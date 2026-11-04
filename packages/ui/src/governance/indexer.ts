import { z } from "zod";
import { deployment } from "./deployment";

// REST boundary only: production builds don't depend on a sibling checkout.
export const indexerUrl =
  process.env.NEXT_PUBLIC_GOVERNANCE_INDEXER_URL ??
  (process.env.NODE_ENV === "development" ? "http://127.0.0.1:42069" : "");
export const INDEX_PAGE_SIZE = 25;
export const MAX_INDEX_PAGES = 10;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((s) => BigInt(s) < 2n ** 256n);
const integer = z.number().int().nonnegative().safe();
const matches = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const identity = z.object({
  chainId: z.literal(deployment.chainId),
  plugin: address.refine((s) => matches(s, deployment.plugin)),
});
const proposal = identity.extend({
  proposalId: uint,
  creator: address,
  creationTransaction: hash,
  creationBlock: uint,
  creationPosition: uint,
});
const event = z
  .object({
    id: z.string().max(180),
    chainId: z.literal(deployment.chainId),
    contract: address,
    source: z.enum(["Plugin", "Dao", "Timelock", "TrustBonding", "Proxy", "ProxyAdmin"]),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,99}$/),
    proposalId: uint.nullable(),
    operationHash: hash.nullable(),
    args: z.record(z.unknown()),
    transactionHash: hash,
    blockNumber: uint,
    blockHash: hash,
    timestamp: uint,
    logIndex: integer,
    transactionIndex: integer,
    position: uint,
  })
  .superRefine((row, context) => {
    const expected = {
      Plugin: [deployment.plugin],
      Dao: [deployment.dao],
      Timelock: [deployment.upgradesTimelock, deployment.parametersTimelock],
      TrustBonding: [deployment.trustBonding],
      ProxyAdmin: [deployment.proxyAdmin],
      Proxy: [],
    }[row.source];
    if (expected.length && !expected.some((a) => matches(a, row.contract)))
      context.addIssue({ code: "custom", message: "Unexpected event emitter" });
  });
export type IndexedProposal = z.infer<typeof proposal>;
export type IndexedEvent = z.infer<typeof event>;
const page = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({ deployment: identity, items: z.array(schema).max(INDEX_PAGE_SIZE), nextCursor: uint.nullable() });
const deploymentSchema = z.object({
  deployment: identity,
  item: identity.extend({
    dao: address.refine((s) => matches(s, deployment.dao)),
    adapter: address.refine((s) => matches(s, deployment.adapter)),
    trustBonding: address.refine((s) => matches(s, deployment.trustBonding)),
    proxyAdmin: address.refine((s) => matches(s, deployment.proxyAdmin)),
    timelocks: z
      .array(address)
      .length(2)
      .refine((items) =>
        [deployment.upgradesTimelock, deployment.parametersTimelock].every((a) => items.some((s) => matches(a, s)))
      ),
    governanceStartBlock: integer.refine((n) => BigInt(n) <= deployment.deploymentBlock),
    coreStartBlock: integer,
  }),
});
export class IndexerUnavailable extends Error {}
export type EventFilter = { proposalId?: string; operationId?: string; contract?: string };
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function createIndexer(base: string, fetcher: Fetcher = fetch, timeout = 8_000) {
  async function request(path: string, signal?: AbortSignal, readiness = false) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeout);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const url = new URL(base.replace(/\/$/, "") + path);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid indexer URL");
      const response = await fetcher(url, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
      });
      if (readiness) {
        await response.body?.cancel();
        if (response.status === 503) return false;
        if (response.ok) return true;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Indexer returned ${response.status}`);
      }
      // Bound decoded response size as well as page length; retain the timeout
      // through body reads, even when React Query supplies a cancellation signal.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty indexer response");
      let size = 0;
      let body = "";
      const decoder = new TextDecoder();
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          size += chunk.value.byteLength;
          if (size > 2_097_152) throw new Error("Indexer response exceeded the size limit");
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return JSON.parse(body) as unknown;
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new IndexerUnavailable(
        "Automatic discovery is unavailable. You can still use RPC and import transaction receipts."
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new IndexerUnavailable(
        "The indexer response does not match this deployment or API. Using local receipts as a fallback."
      );
    return result.data;
  }
  function params(before?: string, filter: EventFilter = {}) {
    const query = new URLSearchParams({ limit: String(INDEX_PAGE_SIZE) });
    if (before !== undefined) query.set("before", uint.parse(before));
    if (filter.proposalId) query.set("proposalId", uint.parse(filter.proposalId));
    if (filter.operationId) query.set("operationId", hash.parse(filter.operationId));
    if (filter.contract) query.set("contract", address.parse(filter.contract));
    return query.toString();
  }
  function checkPage<T extends { [key: string]: unknown }>(
    result: { items: T[]; nextCursor: string | null },
    field: keyof T,
    before?: string
  ) {
    const positions = result.items.map((row) => BigInt(row[field] as string));
    if (
      positions.some((p, i) => (i > 0 && p >= positions[i - 1]) || (before !== undefined && p >= BigInt(before))) ||
      (result.nextCursor !== null &&
        (!positions.length || BigInt(result.nextCursor) !== positions[positions.length - 1]))
    )
      throw new IndexerUnavailable("The indexer returned inconsistent pagination. Refresh to restart discovery.");
    return result;
  }
  return {
    async probe(signal?: AbortSignal) {
      parse(deploymentSchema, await request("/v1/deployment", signal));
      if (!(await request("/ready", signal, true))) return { ready: false as const };
      const statuses = parse(
        z.record(z.object({ id: integer, block: z.object({ number: integer, timestamp: integer }) })),
        await request("/status", signal)
      );
      const status = Object.values(statuses).find((s) => s.id === deployment.chainId);
      if (!status) throw new IndexerUnavailable("The indexer status does not include this chain.");
      return { ready: true as const, block: BigInt(status.block.number) };
    },
    async proposals(before?: string, signal?: AbortSignal) {
      const result = parse(page(proposal), await request(`/v1/proposals?${params(before)}`, signal));
      return checkPage(result, "creationPosition", before);
    },
    async events(filter: EventFilter = {}, before?: string, signal?: AbortSignal) {
      const result = parse(page(event), await request(`/v1/events?${params(before, filter)}`, signal));
      if (
        result.items.some(
          (e) =>
            (filter.proposalId && e.proposalId !== filter.proposalId) ||
            (filter.operationId && e.operationHash?.toLowerCase() !== filter.operationId.toLowerCase()) ||
            (filter.contract && !matches(e.contract, filter.contract))
        )
      )
        throw new IndexerUnavailable("The indexer returned activity outside the requested scope.");
      return checkPage(result, "position", before);
    },
  };
}
export function mergeProposalIds(indexed: readonly IndexedProposal[], local: readonly { proposalId?: string }[]) {
  return [
    ...new Set([...indexed.map((p) => p.proposalId), ...local.flatMap((e) => (e.proposalId ? [e.proposalId] : []))]),
  ].sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1));
}
