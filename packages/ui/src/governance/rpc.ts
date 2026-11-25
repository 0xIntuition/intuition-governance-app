import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  fromHex,
  getAbiItem,
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

// Concurrent contract reads at the same block are sent as one Multicall3 call.
export const governanceClient = createPublicClient({
  chain: governanceChain,
  batch: { multicall: true },
  transport: http(deployment.rpcUrl, { retryCount: 2, retryDelay: 1500, timeout: 15_000 }),
});
export type GovernanceClient = typeof governanceClient;
export const governanceKey = [deployment.chainId, deployment.dao, deployment.plugin] as const;

// Chain, contract code and wiring are fixed for a deployment, so they are checked once per
// page session. A failed check is not cached, so the next call retries it.
const verifiedIdentity = new WeakMap<GovernanceClient, Promise<void>>();
async function checkIdentity(client: GovernanceClient) {
  if ((await client.getChainId()) !== deployment.chainId)
    throw new Error("The RPC is connected to a different chain. Check NEXT_PUBLIC_RPC_URL.");
  const addresses = [deployment.dao, deployment.plugin, deployment.adapter, deployment.upgradesTimelock];
  const [codes, dao, adapter, source] = await Promise.all([
    Promise.all(addresses.map((address) => client.getCode({ address }))),
    client.readContract({ address: deployment.plugin, abi: pluginAbi, functionName: "dao" }),
    client.readContract({ address: deployment.plugin, abi: pluginAbi, functionName: "votingToken" }),
    client.readContract({ address: deployment.adapter, abi: votesAbi, functionName: "trustBonding" }),
  ]);
  const missing = addresses.find((_, index) => !codes[index] || codes[index] === "0x");
  if (missing) throw new Error(`No contract code at ${missing}. Transactions are disabled.`);
  if (
    !isAddressEqual(dao, deployment.dao) ||
    !isAddressEqual(adapter, deployment.adapter) ||
    !isAddressEqual(source, deployment.trustBonding)
  )
    throw new Error("The governance contracts do not match this deployment. Transactions are disabled.");
}
function verifyIdentity(client: GovernanceClient) {
  let check = verifiedIdentity.get(client);
  if (!check) {
    check = checkIdentity(client);
    verifiedIdentity.set(client, check);
    check.catch(() => verifiedIdentity.delete(client));
  }
  return check;
}

// Settings and the timelock delay can change through governance, so they are read fresh.
export async function verifyDeployment(client: GovernanceClient = governanceClient) {
  const [, settings, timelockDelay] = await Promise.all([
    verifyIdentity(client),
    client.readContract({ address: deployment.plugin, abi: pluginAbi, functionName: "governanceSettings" }),
    client.readContract({ address: deployment.upgradesTimelock, abi: timelockAbi, functionName: "getMinDelay" }),
  ]);
  if (!settings[5])
    throw new Error("This deployment requires an unsupported L2 voting path. Transactions are disabled.");
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
const ipfsGateway = "https://ipfs.io";

// Opens https:// references directly and ipfs:// references through a public gateway.
// Anything else is shown as plain text.
export function metadataLink(reference: string) {
  if (/^https:\/\/\S+$/.test(reference)) return reference;
  const ipfs = /^ipfs:\/\/(\S+)$/.exec(reference);
  return ipfs ? `${ipfsGateway}/ipfs/${ipfs[1]}` : undefined;
}
export async function readProposal(id: bigint, client: GovernanceClient = governanceClient) {
  if (id < 0n || id >= 2n ** 256n) throw new Error("Invalid proposal ID.");
  // The block number is cached for a few seconds, so proposals loaded together read the
  // same block and their calls share one multicall.
  const block = await client.getBlock({ blockNumber: await client.getBlockNumber() });
  const at = { address: deployment.plugin, abi: pluginAbi, blockNumber: block.number } as const;
  const [proposal, vetoRead, executableRead] = await Promise.allSettled([
    client.readContract({ ...at, functionName: "getProposal", args: [id] }),
    client.readContract({ ...at, functionName: "isMinVetoRatioReached", args: [id] }),
    client.readContract({
      address: deployment.plugin,
      abi: pluginAbi,
      blockTag: "pending",
      functionName: "canExecute",
      args: [id],
    }),
  ]);
  // Check existence first, so an unknown ID reports that rather than a revert from the other reads.
  if (proposal.status === "rejected") throw proposal.reason;
  const result = proposal.value;
  if (!result[2].snapshotTimestamp) throw new Error("This proposal does not exist on the configured deployment.");
  if (vetoRead.status === "rejected") throw vetoRead.reason;
  if (executableRead.status === "rejected") throw executableRead.reason;
  const vetoed = vetoRead.value;
  const executable = executableRead.value;
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

const proposalCreated = getAbiItem({ abi: pluginAbi, name: "ProposalCreated" });
// Upper bound on blocks sharing one timestamp; the RPC caps eth_getLogs at 2,000 blocks.
const maxCreationRange = 1_000n;

// Blocks read in parallel per search round. Blocks come only with traffic, so their times are
// too uneven to estimate a block from a timestamp; reading several evenly spaced blocks at once
// narrows the window ninefold per round, whatever the spacing.
const probesPerRound = 8n;

const blockTime = async (client: GovernanceClient, blockNumber: bigint) =>
  (await client.getBlock({ blockNumber })).timestamp;

// Narrows a window where block `low` is before `timestamp` and block `high`, with time
// `highTime`, is at or after it. Returns the first block at or after it and its time.
async function narrow(client: GovernanceClient, timestamp: bigint, low: bigint, high: bigint, highTime: bigint) {
  while (high - low > 1n) {
    const step = (high - low + probesPerRound) / (probesPerRound + 1n);
    const probes: bigint[] = [];
    for (let block = low + step; block < high && probes.length < probesPerRound; block += step) probes.push(block);
    const times = await Promise.all(probes.map((block) => blockTime(client, block)));
    const index = times.findIndex((time) => time >= timestamp);
    if (index > 0) low = probes[index - 1];
    if (index === -1) low = probes[probes.length - 1];
    else [high, highTime] = [probes[index], times[index]];
  }
  return [high, highTime] as const;
}

// Finds who created a proposal without an indexer and without scanning from the deployment.
// The plugin sets the snapshot to the creation block's timestamp minus one, so a binary search
// over block timestamps finds the few blocks with that timestamp, and one eth_getLogs over
// them, filtered on the indexed proposal ID, returns the creator. Any failure returns null and
// the page shows no creator. Block numbers here are the RPC's own, never the L1 numbers that
// contracts see.
export async function readProposalCreator(
  id: bigint,
  snapshotTimestamp: bigint,
  client: GovernanceClient = governanceClient
): Promise<Address | null> {
  try {
    const created = snapshotTimestamp + 1n;
    const head = await client.getBlockNumber();
    const from = deployment.deploymentBlock;
    const [fromTime, headTime] = await Promise.all([blockTime(client, from), blockTime(client, head)]);
    if (headTime < created) return null;
    const [first, firstTime] =
      fromTime >= created ? [from, fromTime] : await narrow(client, created, from, head, headTime);
    // No block has the creation timestamp: the snapshot does not belong to this deployment.
    if (firstTime !== created) return null;
    // Blocks sharing the creation timestamp sit right after the first one. One round reads
    // blocks 1, 2, 4 … 512 after it to bracket the first later block, then narrows inside.
    const offsets: bigint[] = [];
    for (let offset = 1n; offset < maxCreationRange && first + offset <= head; offset *= 2n) offsets.push(offset);
    const times = await Promise.all(offsets.map((offset) => blockTime(client, first + offset)));
    const index = times.findIndex((time) => time > created);
    const lastEqual = first + (index > 0 ? offsets[index - 1] : index === 0 ? 0n : (offsets.at(-1) ?? 0n));
    let last = head;
    if (index !== -1)
      last = (await narrow(client, created + 1n, lastEqual, first + offsets[index], times[index]))[0] - 1n;
    else if (headTime > created) last = (await narrow(client, created + 1n, lastEqual, head, headTime))[0] - 1n;
    if (last - first >= maxCreationRange) return null;
    const logs = await client.getLogs({
      address: deployment.plugin,
      event: proposalCreated,
      args: { proposalId: id },
      fromBlock: first,
      toBlock: last,
      strict: true,
    });
    return logs.length === 1 ? logs[0].args.creator : null;
  } catch {
    return null;
  }
}

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
  const [snapshot, current, canVeto, hasVetoed] = await Promise.all([
    governanceClient.readContract({
      ...at,
      functionName: "getPastVotes",
      args: [account, proposal.result[2].snapshotTimestamp],
    }),
    governanceClient.readContract({
      address: deployment.adapter,
      abi: votesAbi,
      blockTag: "pending",
      functionName: "getVotes",
      args: [account],
    }),
    governanceClient.readContract({
      address: deployment.plugin,
      abi: pluginAbi,
      functionName: "canVeto",
      args: [proposal.id, account],
      blockTag: "pending",
    }),
    governanceClient.readContract({
      address: deployment.plugin,
      abi: pluginAbi,
      functionName: "hasVetoed",
      args: [proposal.id, account],
      blockNumber: proposal.blockNumber,
    }),
  ]);
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
