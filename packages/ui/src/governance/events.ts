import { decodeEventLog, getAbiItem, toEventSelector, type Hex, type TransactionReceipt } from "viem";
import { z } from "zod";
import { deployment } from "./deployment";
import { pluginAbi, timelockAbi } from "./contracts";

const hashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex);
const hexSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .max(262146)
  .transform((s) => s as Hex);
const logSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: hexSchema,
  topics: z.array(hashSchema).min(1).max(4),
  logIndex: z.number().int().nonnegative(),
});
export const receiptSchema = z.object({
  version: z.literal(1),
  chainId: z.literal(deployment.chainId),
  transactionHash: hashSchema,
  blockHash: hashSchema,
  blockNumber: z.string().regex(/^\d{1,30}$/),
  transactionIndex: z.number().int().nonnegative(),
  logs: z.array(logSchema).min(1).max(256),
});
export type StoredReceipt = z.infer<typeof receiptSchema>;
export type GovernanceEvent = {
  name: string;
  proposalId?: string;
  creator?: string;
  voter?: string;
  votingPower?: bigint;
  operationId?: string;
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
};
const supportedPlugin = ["ProposalCreated", "VetoCast", "ProposalExecuted"] as const;
const pluginTopics = supportedPlugin.map((name) => toEventSelector(getAbiItem({ abi: pluginAbi, name })));
const timeTopics = ["CallScheduled", "Cancelled", "CallExecuted"].map((name) =>
  toEventSelector(getAbiItem({ abi: timelockAbi, name: name as "CallScheduled" | "Cancelled" | "CallExecuted" }))
);
export function parseTransactionHash(input: string): Hex {
  const parsed = hashSchema.safeParse(input.trim());
  if (!parsed.success) throw new Error("Enter a transaction hash: 0x followed by 64 hexadecimal characters.");
  return parsed.data;
}
export function decodeStoredEvents(receipt: StoredReceipt): GovernanceEvent[] {
  const events: GovernanceEvent[] = [];
  for (const log of receipt.logs) {
    const emitter = log.address.toLowerCase();
    const plugin = emitter === deployment.plugin.toLowerCase();
    const timelock = [deployment.upgradesTimelock, deployment.parametersTimelock].some(
      (a) => a.toLowerCase() === emitter
    );
    const topic = log.topics[0].toLowerCase();
    if ((!plugin || !pluginTopics.includes(topic as Hex)) && (!timelock || !timeTopics.includes(topic as Hex)))
      continue;
    const decoded = decodeEventLog({
      abi: plugin ? pluginAbi : timelockAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
      strict: true,
    });
    const args = decoded.args as {
      proposalId?: bigint;
      creator?: string;
      voter?: string;
      votingPower?: bigint;
      id?: Hex;
    };
    events.push({
      name: decoded.eventName,
      proposalId: args.proposalId?.toString(),
      creator: args.creator,
      voter: args.voter,
      votingPower: args.votingPower,
      operationId: args.id,
      transactionHash: receipt.transactionHash,
      blockNumber: BigInt(receipt.blockNumber),
      logIndex: log.logIndex,
    });
  }
  return events;
}
export function normalizeReceipt(receipt: TransactionReceipt): StoredReceipt {
  if (receipt.status !== "success") throw new Error("The transaction reverted. No events were imported.");
  const relevantLogs = receipt.logs.filter((l) =>
    [deployment.plugin, deployment.upgradesTimelock, deployment.parametersTimelock].some(
      (a) => a.toLowerCase() === l.address.toLowerCase()
    )
  );
  if (!relevantLogs.length) throw new Error("No supported governance events were found for this deployment.");
  const stored = receiptSchema.parse({
    version: 1,
    chainId: deployment.chainId,
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    transactionIndex: receipt.transactionIndex,
    logs: relevantLogs.map((l) => ({ address: l.address, data: l.data, topics: l.topics, logIndex: l.logIndex })),
  });
  if (!decodeStoredEvents(stored).length)
    throw new Error("No supported governance events were found for this deployment.");
  return stored;
}
