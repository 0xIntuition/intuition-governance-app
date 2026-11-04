import {
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  maxUint256,
  parseEther,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { daoPermissionsAbi, pluginAbi, proposerPermissionId } from "./contracts";
import { deployment } from "./deployment";
import { governanceClient, verifyDeployment, type Action, type GovernanceClient } from "./rpc";

export type ProposalDraft = {
  kind: "test" | "proposer" | "calls";
  proposer: string;
  metadata: string;
  duration: string;
  actions: { to: string; value: string; data: string }[];
};
const anyAddress = "0xffffffffffffffffffffffffffffffffffffffff";
export function individualAddress(input: string): Address {
  if (!isAddress(input.trim())) throw new Error("Enter a valid address with a correct checksum, or use lowercase.");
  const address = getAddress(input.trim());
  if (isAddressEqual(address, zeroAddress) || address.toLowerCase() === anyAddress)
    throw new Error("Enter an individual wallet or contract address, not the zero or wildcard address.");
  return address;
}
export function makeProposalPlan(draft: ProposalDraft, minDuration: bigint) {
  if (!/^\d+$/.test(draft.duration) || BigInt(draft.duration) < minDuration || BigInt(draft.duration) > 31_536_000n)
    throw new Error(`Enter a veto window between ${minDuration} and 31536000 whole seconds (one year).`);
  const reference = draft.metadata.trim();
  if (reference && !/^(ipfs:\/\/|https:\/\/)[^\s]+$/.test(reference))
    throw new Error("Use an ipfs:// or https:// metadata URI, or leave it empty.");
  if (new TextEncoder().encode(reference).length > 2048) throw new Error("The metadata URI is too long.");
  let actions: Action[] = [];
  if (draft.kind === "proposer") {
    const who = individualAddress(draft.proposer);
    actions = [
      {
        to: deployment.dao,
        value: 0n,
        data: encodeFunctionData({
          abi: daoPermissionsAbi,
          functionName: "grant",
          args: [deployment.plugin, who, proposerPermissionId],
        }),
      },
    ];
  } else if (draft.kind === "calls") {
    if (!draft.actions.length || draft.actions.length > 10) throw new Error("Add between one and ten actions.");
    actions = draft.actions.map((action, index) => {
      const value = action.value.trim();
      const data = action.data.trim();
      if (!/^\d+(\.\d{1,18})?$/.test(value))
        throw new Error(`Action ${index + 1}: enter a nonnegative TRUST amount with at most 18 decimals.`);
      if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(data) || data.length > 131074)
        throw new Error(
          `Action ${index + 1}: enter byte-aligned hexadecimal calldata beginning with 0x (up to 64 KiB).`
        );
      const amount = parseEther(value);
      if (amount > maxUint256) throw new Error(`Action ${index + 1}: the TRUST amount is too large.`);
      return { to: individualAddress(action.to), value: amount, data: data as Hex };
    });
  }
  // Leave room for ABI offsets and metadata inside the local receipt schema's
  // per-log limit, so a successful creation can always be imported.
  if (actions.reduce((total, action) => total + (action.data.length - 2) / 2, 0) > 65536)
    throw new Error("Keep the combined action calldata within 64 KiB so the receipt can be saved locally.");
  const args = [toHex(reference), actions, 0n, BigInt(draft.duration)] as const;
  return { args, data: encodeFunctionData({ abi: pluginAbi, functionName: "createProposal", args }) };
}
export type ProposalPlan = ReturnType<typeof makeProposalPlan>;
export async function canPropose(account: Address, data: Hex, client: GovernanceClient = governanceClient) {
  return client.readContract({
    address: deployment.dao,
    abi: daoPermissionsAbi,
    functionName: "hasPermission",
    args: [deployment.plugin, account, proposerPermissionId, data],
    blockTag: "pending",
  });
}
export async function prepareProposal(
  account: Address,
  draft: ProposalDraft,
  client: GovernanceClient = governanceClient
) {
  const deploymentState = await verifyDeployment(client);
  const plan = makeProposalPlan(draft, BigInt(deploymentState.settings[1]));
  if (!(await canPropose(account, plan.data, client)))
    throw new Error("This wallet does not have permission to create this proposal.");
  // Simulate the exact call against pending state: permission conditions, voting
  // supply and duration can change after the form's initial read.
  return client.simulateContract({
    address: deployment.plugin,
    abi: pluginAbi,
    functionName: "createProposal",
    args: plan.args,
    account,
    blockTag: "pending",
  });
}
