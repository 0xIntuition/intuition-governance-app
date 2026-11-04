import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createIndexer, indexerUrl, MAX_INDEX_PAGES, type EventFilter } from "./indexer";
import { governanceClient, governanceKey } from "./rpc";
import { date, ErrorMessage, Explorer } from "./shared";

const api = createIndexer(indexerUrl);
const key = ["governance-indexer", ...governanceKey, indexerUrl];
function useConnection() {
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: [...key, "health"],
    enabled: !!indexerUrl,
    retry: false,
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const status = await api.probe(signal);
      // Discovery can still work during an RPC outage. Never claim a known lag
      // when the current chain head could not be read.
      const head = status.ready
        ? await governanceClient.getBlockNumber({ cacheTime: 0 }).catch(() => undefined)
        : undefined;
      return { ...status, head };
    },
  });
  const enabled = !!indexerUrl && health.isSuccess && health.data.ready;
  const previous = useRef<bigint | undefined>(undefined);
  const block = health.data?.ready ? health.data.block : undefined;
  useEffect(() => {
    if (enabled && block !== undefined && previous.current !== block) {
      if (previous.current !== undefined)
        void queryClient.invalidateQueries({
          predicate: (q) =>
            [
              "governance-proposal",
              "governance-list",
              "governance-voting",
              "governance-operation",
              "governance-lock",
            ].includes(String(q.queryKey[0])) ||
            (q.queryKey[0] === key[0] && q.queryKey[q.queryKey.length - 1] !== "health"),
        });
      previous.current = block;
    }
  }, [enabled, block, queryClient]);
  return { enabled, health };
}
const Context = createContext<ReturnType<typeof useConnection> | null>(null);
export function IndexerProvider({ children }: { children: ReactNode }) {
  const connection = useConnection();
  return <Context.Provider value={connection}>{children}</Context.Provider>;
}
function useIndexer() {
  const value = useContext(Context);
  if (!value) throw new Error("IndexerProvider is required");
  return value;
}
export function IndexerStatus() {
  const { health } = useIndexer();
  let description = "Automatic discovery is not configured. Import receipts to find proposals in this browser.";
  if (indexerUrl) {
    if (health.isPending)
      description = "Connecting to automatic proposal discovery. Manual receipt import is available.";
    else if (health.isError)
      description =
        "Indexer unavailable. Showing previously loaded proposals and local receipts; new proposals may be missing.";
    else if (!health.data?.ready) description = "The indexer is syncing. Local receipt imports remain available.";
    else {
      const { block, head } = health.data;
      description =
        head === undefined
          ? `Indexer connected at block ${block}. Current RPC head is unavailable.`
          : head > block
            ? `Indexer is ${head - block} blocks behind the chain. Recent activity may be missing.`
            : `Indexer connected at block ${block}. Checking for new activity every 15 seconds.`;
    }
  }
  return (
    <div className="gov-discovery" role="status">
      <p>{description}</p>
      <p>Proposal state and transaction eligibility always come from RPC.</p>
    </div>
  );
}
export function useIndexedProposals() {
  const { enabled } = useIndexer();
  return useInfiniteQuery({
    queryKey: [...key, "proposals"],
    enabled,
    retry: false,
    refetchInterval: enabled ? 30_000 : false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.proposals(pageParam, signal),
    getNextPageParam: (last, pages) => (pages.length < MAX_INDEX_PAGES ? (last.nextCursor ?? undefined) : undefined),
  });
}
export function IndexedActivity({ filter = {}, title = "Indexed activity" }: { filter?: EventFilter; title?: string }) {
  const { enabled } = useIndexer();
  const query = useInfiniteQuery({
    queryKey: [...key, "events", filter],
    enabled,
    retry: false,
    refetchInterval: enabled ? 30_000 : false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.events(filter, pageParam, signal),
    getNextPageParam: (last, pages) => (pages.length < MAX_INDEX_PAGES ? (last.nextCursor ?? undefined) : undefined),
  });
  const rows = [
    ...new Map(
      query.data?.pages.flatMap((p) => p.items).map((e) => [`${e.transactionHash}:${e.logIndex}`, e]) ?? []
    ).values(),
  ];
  if (!indexerUrl) return null;
  return (
    <section className="gov-indexed-activity">
      <h2>{title}</h2>
      <p>
        History reported by the indexer, through its last indexed block. It may be incomplete while syncing or offline.
      </p>
      {!enabled && <p>Live indexed history is unavailable. Any rows below are from the last successful request.</p>}
      <ErrorMessage error={query.error} />
      {enabled && query.isPending && <p role="status">Loading activity…</p>}
      {!query.isPending && !rows.length && (
        <p>No activity in the loaded indexer history. This does not prove nothing happened on chain.</p>
      )}
      {rows.map((event) => (
        <div className="gov-row" key={`${event.transactionHash}:${event.logIndex}`}>
          <div>
            <h3>{event.name.replace(/([a-z])([A-Z])/g, "$1 $2")}</h3>
            <p>
              <Explorer value={event.contract} /> · Block {event.blockNumber} · {date(BigInt(event.timestamp))}
            </p>
            {event.proposalId && !filter.proposalId && (
              <p>
                <a href={`/?proposal=${event.proposalId}`}>View proposal</a>
              </p>
            )}
            <details>
              <summary>Event details</summary>
              <pre>{JSON.stringify(event.args, null, 2)}</pre>
              <p className="gov-hash">Transaction hash: {event.transactionHash}</p>
            </details>
          </div>
          <Explorer kind="tx" value={event.transactionHash}>
            Transaction
          </Explorer>
        </div>
      ))}
      {query.hasNextPage && (
        <button disabled={!enabled || query.isFetching} onClick={() => void query.fetchNextPage()}>
          Load older activity
        </button>
      )}
      {query.data?.pages.length === MAX_INDEX_PAGES && query.data.pages[MAX_INDEX_PAGES - 1].nextCursor && (
        <p>Showing the first 250 events. Narrow the view to a proposal or operation to see its history.</p>
      )}
    </section>
  );
}
