import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createIndexer, mergeProposalIds, type IndexedProposal } from "../indexer";
import { deployment, fixtureTransactions } from "../deployment";

const identity = { chainId: deployment.chainId, plugin: deployment.plugin.toLowerCase() };
const row: IndexedProposal = {
  ...identity,
  proposalId: "610405300457693690041668389091439876825658949632",
  creator: deployment.manager,
  creationTransaction: fixtureTransactions[0],
  creationBlock: "9375991",
  creationPosition: "40269600000000000",
};
const manifest = {
  ...identity,
  dao: deployment.dao,
  adapter: deployment.adapter,
  trustBonding: deployment.trustBonding,
  proxyAdmin: deployment.proxyAdmin,
  timelocks: [deployment.upgradesTimelock, deployment.parametersTimelock],
  governanceStartBlock: 9375982,
  coreStartBlock: 9375954,
};
const event = {
  id: "fixture",
  ...identity,
  contract: deployment.plugin,
  source: "Plugin",
  name: "ProposalCreated",
  proposalId: row.proposalId,
  operationHash: null,
  args: { proposalId: row.proposalId },
  transactionHash: fixtureTransactions[0],
  transactionIndex: 0,
  logIndex: 0,
  blockNumber: row.creationBlock,
  blockHash: "0x" + "11".repeat(32),
  timestamp: "1793819955",
  position: row.creationPosition,
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const page = (items: unknown[], nextCursor: string | null = null) => ({ deployment: identity, items, nextCursor });
function mock(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async () => response(body, status));
}

describe("optional indexer boundary", () => {
  it("discovers decimal proposal IDs and merges local-only proposals without duplicates", async () => {
    const api = createIndexer("http://localhost:42069/", mock(page([row])));
    const data = await api.proposals();
    expect(data.items[0].proposalId).toBe(row.proposalId);
    expect(mergeProposalIds(data.items, [{ proposalId: row.proposalId }, { proposalId: "1" }, {}])).toEqual([
      row.proposalId,
      "1",
    ]);
    expect(mergeProposalIds([], [{ proposalId: "1" }])).toEqual(["1"]);
  });
  it("rejects mismatched deployments, malformed items and lossy numeric IDs", async () => {
    for (const body of [
      { ...page([row]), deployment: { ...identity, chainId: 1 } },
      { ...page([row]), deployment: { ...identity, plugin: deployment.dao } },
      page([{ ...row, chainId: 1 }]),
      page([{ ...row, plugin: deployment.dao }]),
      page([{ ...row, proposalId: Number(row.proposalId) }]),
      page([{ ...row, proposalId: (2n ** 256n).toString() }]),
      page([{ ...row, creator: "invalid" }]),
      page(Array(26).fill(row)),
    ])
      await expect(createIndexer("https://example.test", mock(body)).proposals()).rejects.toThrow("does not match");
  });
  it("validates the full deployment before checking readiness", async () => {
    const fetcher = mock({ deployment: identity, item: { ...manifest, trustBonding: deployment.dao } });
    await expect(createIndexer("https://example.test", fetcher).probe()).rejects.toThrow("deployment");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("treats initial backfill as syncing and reports indexed block separately from wall time", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith("deployment")) return response({ deployment: identity, item: manifest });
      if (String(url).endsWith("ready")) return response({}, 503);
      throw new Error("Status must not be fetched before readiness");
    });
    expect(await createIndexer("https://example.test", fetcher).probe()).toEqual({ ready: false });
    fetcher.mockImplementation(async (url) =>
      String(url).endsWith("deployment")
        ? response({ deployment: identity, item: manifest })
        : String(url).endsWith("ready")
          ? response({})
          : response({ intuition: { id: 13579, block: { number: 9376020, timestamp: 1 } } })
    );
    expect(await createIndexer("https://example.test", fetcher).probe()).toEqual({ ready: true, block: 9376020n });
  });
  it("handles network, HTTP and malformed JSON failures without affecting local imports", async () => {
    const fetchers = [
      mock({}, 503),
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network")),
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not json")),
    ];
    for (const fetcher of fetchers)
      await expect(createIndexer("https://example.test", fetcher).proposals()).rejects.toThrow("unavailable");
    expect(mergeProposalIds([], [{ proposalId: row.proposalId }])).toEqual([row.proposalId]);
  });
  it("uses bounded keyset pages and rejects stalled or reversed cursors", async () => {
    const fetcher = mock(page([{ ...row, creationPosition: "90" }], "90"));
    await createIndexer("https://example.test", fetcher).proposals("100");
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("before")).toBe("100");
    expect(url.searchParams.get("limit")).toBe("25");
    for (const data of [
      page([row], row.creationPosition),
      page([{ ...row, creationPosition: "90" }], "91"),
      page([
        { ...row, creationPosition: "90" },
        { ...row, creationPosition: "95" },
      ]),
    ])
      await expect(createIndexer("https://example.test", mock(data)).proposals("100")).rejects.toThrow("pagination");
  });
  it("scopes proposal and timelock history and rejects unexpected emitters", async () => {
    const fetcher = mock(page([event]));
    const api = createIndexer("https://example.test", fetcher);
    expect((await api.events({ proposalId: row.proposalId })).items).toHaveLength(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("proposalId")).toBe(row.proposalId);
    await expect(api.events({ proposalId: "1" })).rejects.toThrow("scope");
    await expect(
      createIndexer("https://example.test", mock(page([{ ...event, contract: deployment.dao }]))).events()
    ).rejects.toThrow("deployment");
    await expect(
      api.events({ operationId: "0x" + "22".repeat(32), contract: deployment.upgradesTimelock })
    ).rejects.toThrow("scope");
  });
  it("bounds response bodies and excludes credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(2_097_153)));
    await expect(createIndexer("https://example.test", fetcher).proposals()).rejects.toThrow("unavailable");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  });
  it("keeps the timeout when React Query supplies a signal and propagates aborts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const caller = new AbortController();
    await expect(createIndexer("https://example.test", fetcher, 5).proposals(undefined, caller.signal)).rejects.toThrow(
      "unavailable"
    );
    const next = createIndexer("https://example.test", fetcher).proposals(undefined, caller.signal);
    caller.abort();
    await expect(next).rejects.toThrow("aborted");
  });
  it("retains previously loaded discovery during outage and replaces it on recovery/reorg", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetcher = mock(page([row]));
    const api = createIndexer("https://example.test", fetcher);
    const query = { queryKey: ["discovery-test"], queryFn: () => api.proposals(), staleTime: 0 };
    await queryClient.fetchQuery(query);
    fetcher.mockRejectedValue(new Error("offline"));
    await expect(queryClient.fetchQuery(query)).rejects.toThrow();
    expect(queryClient.getQueryData(query.queryKey)).toMatchObject({ items: [{ proposalId: row.proposalId }] });
    fetcher.mockImplementation(async () => response(page([])));
    expect((await queryClient.fetchQuery(query)).items).toEqual([]);
    expect(mergeProposalIds([], [{ proposalId: row.proposalId }])).toEqual([row.proposalId]);
    queryClient.clear();
  });
});

it.runIf(!!process.env.CHECK_GOVERNANCE_INDEXER_URL)(
  "discovers live proposals and proposal/timelock/core history through the UI client",
  async () => {
    const api = createIndexer(process.env.CHECK_GOVERNANCE_INDEXER_URL!);
    expect((await api.probe()).ready).toBe(true);
    const proposals = await api.proposals();
    expect(proposals.items.some((p) => p.proposalId === row.proposalId)).toBe(true);
    const history = await api.events({ proposalId: row.proposalId });
    expect(history.items.some((e) => e.name === "ProposalCreated")).toBe(true);
    expect(history.items.some((e) => e.name === "VetoCast")).toBe(true);
    expect(history.items.some((e) => e.name === "ProposalExecuted")).toBe(true);
    const cancelled = (await api.events({ contract: deployment.upgradesTimelock })).items.find(
      (e) => e.name === "Cancelled"
    );
    expect(cancelled?.operationHash).toBeTruthy();
    expect(
      (await api.events({ operationId: cancelled!.operationHash!, contract: deployment.upgradesTimelock })).items.some(
        (e) => e.name === "CallScheduled"
      )
    ).toBe(true);
    expect((await api.events({ contract: deployment.trustBonding })).items.some((e) => e.name === "Deposit")).toBe(
      true
    );
  },
  30_000
);
