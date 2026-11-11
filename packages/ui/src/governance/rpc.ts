import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  fromHex,
  http,
  isAddressEqual,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { deployment, governanceChain } from "./deployment";
import { daoPermissionsAbi, pluginAbi, proposerPermissionId, proxyAdminAbi, timelockAbi, votesAbi } from "./contracts";
import { normalizeReceipt, parseTransactionHash, type StoredReceipt } from "./events";

export const governanceClient = createPublicClient({
  chain: governanceChain,
  transport: http(deployment.rpcUrl, { retryCount: 2, retryDelay: 1500, timeout: 15_000 }),
});
export type GovernanceClient = typeof governanceClient;
export const governanceKey = [deployment.chainId, deployment.dao, deployment.plugin] as const;

export async function verifyDeployment(client: GovernanceClient = governanceClient) {
  if ((await client.getChainId()) !== deployment.chainId)
    throw new Error("The RPC is connected to a different chain. Check NEXT_PUBLIC_RPC_URL.");
  for (const address of [deployment.dao, deployment.plugin, deployment.adapter, deployment.upgradesTimelock]) {
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new Error(`No contract code at ${address}. Transactions are disabled.`);
  }
  const dao = await client.readContract({ address: deployment.plugin, abi: pluginAbi, functionName: "dao" });
  const adapter = await client.readContract({
    address: deployment.plugin,
    abi: pluginAbi,
    functionName: "votingToken",
  });
  const source = await client.readContract({
    address: deployment.adapter,
    abi: votesAbi,
    functionName: "trustBonding",
  });
  if (
    !isAddressEqual(dao, deployment.dao) ||
    !isAddressEqual(adapter, deployment.adapter) ||
    !isAddressEqual(source, deployment.trustBonding)
  )
    throw new Error("The governance contracts do not match this deployment. Transactions are disabled.");
  const settings = await client.readContract({
    address: deployment.plugin,
    abi: pluginAbi,
    functionName: "governanceSettings",
  });
  if (!settings[5])
    throw new Error("This deployment requires an unsupported L2 voting path. Transactions are disabled.");
  const timelockDelay = await client.readContract({
    address: deployment.upgradesTimelock,
    abi: timelockAbi,
    functionName: "getMinDelay",
  });
  return { settings, timelockDelay };
}

export async function fetchReceipt(hash: string, client: GovernanceClient = governanceClient): Promise<StoredReceipt> {
  const transactionHash = parseTransactionHash(hash);
  if ((await client.getChainId()) !== deployment.chainId)
    throw new Error(`The RPC chain does not match ${deployment.name}.`);
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash)
    throw new Error("This receipt is no longer in the canonical chain. Retry after the network settles.");
  return normalizeReceipt(receipt);
}

export function vetoThreshold(supply: bigint, ratio: number) {
  return (supply * BigInt(ratio) + 999_999n) / 1_000_000n;
}
export function proposalStatus(executed: boolean, vetoed: boolean, open: boolean, executable: boolean) {
  if (executed) return "Executed";
  if (vetoed) return "Vetoed";
  if (executable) return "Executable";
  if (open) return "Active";
  return "Not executable";
}
export function metadataReference(value: Hex) {
  try {
    return fromHex(value, "string").replace(/\0/g, "");
  } catch {
    return value;
  }
}
export async function readProposal(id: bigint, client: GovernanceClient = governanceClient) {
  if (id < 0n || id >= 2n ** 256n) throw new Error("Invalid proposal ID.");
  const block = await client.getBlock();
  const at = { address: deployment.plugin, abi: pluginAbi, blockNumber: block.number } as const;
  const result = await client.readContract({ ...at, functionName: "getProposal", args: [id] });
  if (!result[2].snapshotTimestamp) throw new Error("This proposal does not exist on the configured deployment.");
  const vetoed = await client.readContract({ ...at, functionName: "isMinVetoRatioReached", args: [id] });
  const executable = await client.readContract({
    address: deployment.plugin,
    abi: pluginAbi,
    blockTag: "pending",
    functionName: "canExecute",
    args: [id],
  });
  const supply = await client.readContract({
    address: deployment.adapter,
    abi: votesAbi,
    functionName: "getPastTotalSupply",
    args: [result[2].snapshotTimestamp],
    blockNumber: block.number,
  });
  return {
    id,
    result,
    supply,
    threshold: vetoThreshold(supply, result[2].minVetoRatio),
    executable,
    status: proposalStatus(result[1], vetoed, result[0], executable),
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
  };
}
export type Proposal = Awaited<ReturnType<typeof readProposal>>;

// The plugin's creation counter sits in the low 64 bits of each proposal ID and equals
// its index in `proposalIds`, so it orders proposals by creation.
export const proposalIndex = (id: bigint) => id & ((1n << 64n) - 1n);
export const proposalIdPageSize = 20;
export type ProposalIdPage = { count: bigint; ids: string[] };

// Reads one page of proposal IDs, newest first. Page 0 also reads `proposalCount`;
// later pages reuse that count so indexes stay stable while new proposals arrive.
// Each page is a single Multicall3 call.
export async function readProposalIdPage(
  page: number,
  count?: bigint,
  client: GovernanceClient = governanceClient
): Promise<ProposalIdPage> {
  const total =
    count ?? (await client.readContract({ address: deployment.plugin, abi: pluginAbi, functionName: "proposalCount" }));
  const end = total - BigInt(page * proposalIdPageSize);
  if (end <= 0n) return { count: total, ids: [] };
  const start = end > BigInt(proposalIdPageSize) ? end - BigInt(proposalIdPageSize) : 0n;
  const contracts = [];
  for (let index = end - 1n; index >= start; index--)
    contracts.push({
      address: deployment.plugin,
      abi: pluginAbi,
      functionName: "proposalIds",
      args: [index],
    } as const);
  const ids = await client.multicall({ contracts, allowFailure: false });
  // A real ID always carries a nonzero start date. Zero means the RPC answered from
  // a state that does not include this proposal yet.
  if (ids.some((id) => id === 0n)) throw new Error("The RPC returned an incomplete proposal list. Retry shortly.");
  return { count: total, ids: ids.map(String) };
}

export function nextProposalIdPage(last: ProposalIdPage, page: number) {
  return BigInt((page + 1) * proposalIdPageSize) < last.count ? { page: page + 1, count: last.count } : undefined;
}

// Merges listed and imported IDs without duplicates, newest first. While older chain
// pages are still unread, imported IDs older than the loaded window wait for their page.
export function mergeProposalIds(listed: readonly string[], imported: readonly string[], listComplete: boolean) {
  const oldest = listed.reduce<bigint | undefined>((min, id) => {
    const index = proposalIndex(BigInt(id));
    return min === undefined || index < min ? index : min;
  }, undefined);
  const extra = imported.filter((id) => listComplete || oldest === undefined || proposalIndex(BigInt(id)) >= oldest);
  return [...new Set([...listed, ...extra])].sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    const ix = proposalIndex(x);
    const iy = proposalIndex(y);
    if (ix !== iy) return ix > iy ? -1 : 1;
    return x === y ? 0 : x > y ? -1 : 1;
  });
}
export async function readVotingPower(proposal: Proposal, account: Address) {
  const at = { address: deployment.adapter, abi: votesAbi, blockNumber: proposal.blockNumber } as const;
  const snapshot = await governanceClient.readContract({
    ...at,
    functionName: "getPastVotes",
    args: [account, proposal.result[2].snapshotTimestamp],
  });
  const current = await governanceClient.readContract({
    address: deployment.adapter,
    abi: votesAbi,
    blockTag: "pending",
    functionName: "getVotes",
    args: [account],
  });
  const canVeto = await governanceClient.readContract({
    address: deployment.plugin,
    abi: pluginAbi,
    functionName: "canVeto",
    args: [proposal.id, account],
    blockTag: "pending",
  });
  const hasVetoed = await governanceClient.readContract({
    address: deployment.plugin,
    abi: pluginAbi,
    functionName: "hasVetoed",
    args: [proposal.id, account],
    blockNumber: proposal.blockNumber,
  });
  return { snapshot, current, canVeto, hasVetoed };
}

export type Action = { to: Address; value: bigint; data: Hex };
export function decodeAction(action: Action) {
  if (isAddressEqual(action.to, deployment.dao) && action.value === 0n) {
    try {
      const decoded = decodeFunctionData({ abi: daoPermissionsAbi, data: action.data });
      if (
        decoded.functionName === "grant" &&
        isAddressEqual(decoded.args[0], deployment.plugin) &&
        decoded.args[2] === proposerPermissionId
      )
        return { name: `Grant proposer access to ${decoded.args[1]}` };
    } catch {
      /* Preserve unrecognized DAO actions as raw calldata. */
    }
  }
  if (
    isAddressEqual(action.to, deployment.upgradesTimelock) ||
    isAddressEqual(action.to, deployment.parametersTimelock)
  ) {
    try {
      const decoded = decodeFunctionData({ abi: timelockAbi, data: action.data });
      if (decoded.functionName === "execute") {
        const [target, value, payload, predecessor, salt] = decoded.args;
        const operationId = keccak256(
          encodeAbiParameters(parseAbiParameters("address,uint256,bytes,bytes32,bytes32"), [
            target,
            value,
            payload,
            predecessor,
            salt,
          ])
        );
        return { name: "Execute timelock operation", operationId, children: [{ to: target, value, data: payload }] };
      }
      if (decoded.functionName === "executeBatch") {
        const [targets, values, payloads, predecessor, salt] = decoded.args;
        if (targets.length !== values.length || targets.length !== payloads.length || targets.length > 32)
          throw new Error("Invalid batch");
        const operationId = keccak256(
          encodeAbiParameters(parseAbiParameters("address[],uint256[],bytes[],bytes32,bytes32"), [
            targets,
            values,
            payloads,
            predecessor,
            salt,
          ])
        );
        return {
          name: "Execute timelock batch",
          operationId,
          children: targets.map((to, i) => ({ to, value: values[i], data: payloads[i] })),
        };
      }
    } catch {
      /* Preserve the exact raw action if decoding fails. */
    }
  }
  // The deployment gives a verified identity for this ProxyAdmin only. Do not
  // assign that identity to arbitrary contracts sharing its function selector.
  if (isAddressEqual(action.to, deployment.proxyAdmin)) {
    try {
      const decoded = decodeFunctionData({ abi: proxyAdminAbi, data: action.data });
      return {
        name: "Upgrade proxy",
        proxy: decoded.args[0],
        implementation: decoded.args[1],
        initialization: decoded.functionName === "upgradeAndCall" ? decoded.args[2] : "0x",
      };
    } catch {
      /* Fall through to raw calldata. */
    }
  }
  return { name: "Contract call (unrecognized)" };
}
