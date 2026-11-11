import { GovernanceHeader, Explorer, ErrorMessage, short, message, units, date } from "./shared";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { formatUnits, isAddressEqual, type Address, type Hex } from "viem";
import { deployment, fixtureTransactions } from "./deployment";
import { pluginAbi, timelockAbi } from "./contracts";
import { decodeStoredEvents, type StoredReceipt } from "./events";
import { clearReceipts, loadReceipts, removeReceipt, saveReceipt } from "./storage";
import {
  decodeAction,
  fetchReceipt,
  governanceClient,
  governanceKey,
  mergeProposalIds,
  metadataReference,
  nextProposalIdPage,
  proposalIndex,
  readProposal,
  readProposalIdPage,
  readVotingPower,
  verifyDeployment,
  type Action,
  type Proposal,
} from "./rpc";

const proposalKey = (id: string) => ["governance-proposal", ...governanceKey, id];
const rowsPerPage = 6;

export default function GovernanceScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [receipts, setReceipts] = useState<StoredReceipt[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [importError, setImportError] = useState<unknown>(null);
  const [page, setPage] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const deploymentQuery = useQuery({
    queryKey: ["governance-deployment", ...governanceKey],
    queryFn: () => verifyDeployment(),
    staleTime: 60_000,
  });
  const reloadLocal = useCallback(() => {
    try {
      const loaded = loadReceipts(window.localStorage);
      setReceipts(loaded.receipts);
      setWarnings(loaded.warnings);
    } catch {
      setWarnings(["Browser storage is unavailable. Enable site storage and reload to import transactions."]);
    }
    setReady(true);
  }, []);
  useEffect(() => {
    reloadLocal();
    window.addEventListener("storage", reloadLocal);
    return () => window.removeEventListener("storage", reloadLocal);
  }, [reloadLocal]);
  const hashes = useMemo(() => receipts.map((r) => r.transactionHash).sort(), [receipts]);
  const history = useQuery({
    queryKey: ["governance-history", ...governanceKey, hashes],
    enabled: ready && deploymentQuery.isSuccess,
    queryFn: async () => {
      const verified: StoredReceipt[] = [];
      const errors: string[] = [];
      for (const hash of hashes) {
        try {
          // Cached local JSON is never promoted to verified history. Fetch and
          // canonically verify every receipt once per session/explicit refresh.
          const receipt = await queryClient.fetchQuery({
            queryKey: ["governance-receipt", ...governanceKey, hash],
            queryFn: () => fetchReceipt(hash),
            staleTime: 60_000,
            retry: false,
          });
          verified.push(receipt);
        } catch (e) {
          errors.push(`${short(hash)}: ${message(e)}`);
        }
      }
      return { verified, errors };
    },
    retry: false,
  });
  const events = useMemo(
    () =>
      (history.data?.verified ?? [])
        .flatMap(decodeStoredEvents)
        .sort((a, b) =>
          a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1
        ),
    [history.data]
  );
  const importedIds = useMemo(
    () => [...new Set(events.flatMap((e) => (e.proposalId ? [e.proposalId] : [])))],
    [events]
  );
  const selected =
    typeof router.query.proposal === "string" && /^\d{1,78}$/.test(router.query.proposal)
      ? router.query.proposal
      : undefined;
  // The proposal list comes from the plugin's onchain index, read lazily in pages of IDs.
  // Imported receipts only add event history; their IDs are merged in without duplicates.
  const listing = useInfiniteQuery({
    queryKey: ["governance-proposal-ids", ...governanceKey],
    enabled: !selected && deploymentQuery.isSuccess,
    initialPageParam: { page: 0, count: undefined as bigint | undefined },
    queryFn: ({ pageParam }) => readProposalIdPage(pageParam.page, pageParam.count),
    getNextPageParam: (last, _pages, param) => nextProposalIdPage(last, param.page),
    retry: false,
  });
  const listedIds = useMemo(() => listing.data?.pages.flatMap((p) => p.ids) ?? [], [listing.data]);
  const ids = useMemo(
    () => mergeProposalIds(listedIds, importedIds, !listing.hasNextPage || listing.isError),
    [listedIds, importedIds, listing.hasNextPage, listing.isError]
  );
  const { hasNextPage, isFetching: listingFetching, isError: listingError, fetchNextPage } = listing;
  useEffect(() => {
    // Read the next page of IDs only when the requested row page reaches past them.
    if ((page + 1) * rowsPerPage > ids.length && hasNextPage && !listingFetching && !listingError) void fetchNextPage();
  }, [page, ids.length, hasNextPage, listingFetching, listingError, fetchNextPage]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(ids.length / rowsPerPage) - 1));
  const visibleIds = ids.slice(currentPage * rowsPerPage, currentPage * rowsPerPage + rowsPerPage);
  const list = useQuery({
    queryKey: ["governance-list", ...governanceKey, visibleIds],
    enabled: !selected && deploymentQuery.isSuccess && visibleIds.length > 0,
    queryFn: async () => {
      const rows: Array<{ id: string; proposal?: Proposal; error?: string }> = [];
      // Sequential, bounded pages avoid bursts against the public RPC.
      for (const id of visibleIds) {
        try {
          rows.push({
            id,
            proposal: await queryClient.fetchQuery({
              queryKey: proposalKey(id),
              queryFn: () => readProposal(BigInt(id)),
              retry: false,
            }),
          });
        } catch (e) {
          rows.push({ id, error: message(e) });
        }
      }
      return rows;
    },
    retry: false,
  });
  const importHashes = async (values: readonly string[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setImportError(null);
    setNotice("");
    let count = 0;
    try {
      await verifyDeployment();
      for (const hash of values) {
        const receipt = await fetchReceipt(hash);
        saveReceipt(window.localStorage, receipt);
        queryClient.setQueryData(["governance-receipt", ...governanceKey, receipt.transactionHash], receipt);
        count++;
      }
      setInput("");
      setPage(0);
      setNotice(`${count} ${count === 1 ? "transaction saved" : "transactions saved"} in this browser.`);
    } catch (e) {
      setImportError(e);
      if (count) setNotice(`${count} transactions were saved before the import stopped. Retry to continue safely.`);
    } finally {
      reloadLocal();
      await queryClient.invalidateQueries({ queryKey: ["governance-history"] });
      busyRef.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("governance-"),
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void importHashes([input]);
  };
  const onConfirmed = async (hash: Hex) => {
    // Confirmed writes must not be dropped when a manual refresh holds the UI lock.
    try {
      const receipt = await fetchReceipt(hash);
      saveReceipt(window.localStorage, receipt);
      queryClient.setQueryData(["governance-receipt", ...governanceKey, receipt.transactionHash], receipt);
    } catch (e) {
      throw new Error(
        `Transaction confirmed, but local history could not be saved. Import its hash to retry. ${message(e)}`
      );
    } finally {
      reloadLocal();
      await queryClient.invalidateQueries({ queryKey: ["governance-history"] });
      await queryClient.invalidateQueries({ queryKey: ["governance-proposal"] });
    }
  };
  return (
    <div className="governance">
      <a className="gov-skip" href="#governance-content">
        Skip to proposals
      </a>
      <GovernanceHeader page="proposals" />
      <main id="governance-content" className="gov-main">
        <div className="gov-title">
          <div>
            <h1>{selected ? "Proposal" : "Governance proposals"}</h1>
            <p>Review onchain actions and veto with your veTRUST.</p>
          </div>
          <button
            disabled={busy || deploymentQuery.isFetching || listing.isFetching || history.isFetching || list.isFetching}
            onClick={() => void refresh()}
          >
            Refresh from chain
          </button>
        </div>
        <ErrorMessage error={deploymentQuery.error} />
        {deploymentQuery.isPending && <p role="status">Checking the governance contracts…</p>}
        {selected ? (
          <>
            <button className="gov-back" onClick={() => void router.push("/", undefined, { shallow: true })}>
              Back to proposals
            </button>
            <ProposalDetail
              key={selected}
              id={selected}
              events={events}
              enabled={deploymentQuery.isSuccess && !deploymentQuery.isFetching}
              onConfirmed={onConfirmed}
            />
          </>
        ) : (
          <>
            <section className="app-surface gov-import" aria-labelledby="import-title">
              <h2 id="import-title">Import a transaction</h2>
              <p>
                Paste a transaction hash to load its governance events, such as the creator, vetoes and execution.
                History is saved only in this browser.
              </p>
              <form onSubmit={onSubmit}>
                <label htmlFor="transaction-hash">Transaction hash</label>
                <div className="gov-input-row">
                  <input
                    id="transaction-hash"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="0x…"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="import-help"
                    disabled={busy}
                  />
                  <button
                    className="gov-primary"
                    type="submit"
                    disabled={busy || !input.trim() || !deploymentQuery.isSuccess}
                    aria-busy={busy}
                  >
                    Import transaction
                  </button>
                </div>
              </form>
              <p id="import-help">
                Only receipts from this deployment are accepted. Importing does not ask your wallet to sign.
              </p>
              {fixtureTransactions.length > 0 && (
                <button
                  disabled={busy || !deploymentQuery.isSuccess}
                  onClick={() => void importHashes(fixtureTransactions)}
                >
                  Import testnet fixtures
                </button>
              )}
              <ErrorMessage error={importError} />
              <p role="status" aria-live="polite">
                {busy ? "Working with the RPC…" : notice}
              </p>
            </section>
            <section className="gov-proposals" aria-labelledby="proposals-title">
              <h2 id="proposals-title">Proposals</h2>
              <p>
                The list, veto totals and status come from the contracts. Event history comes only from transactions
                imported into this browser.
              </p>
              {!ready || listing.isFetching || history.isFetching || list.isFetching ? (
                <p role="status">Loading and verifying proposal data…</p>
              ) : null}
              {listing.isError && (
                <div className="gov-error" role="alert">
                  <p>
                    Proposals could not be loaded from the RPC. {message(listing.error)}
                    {ids.length > 0 ? " Some proposals may be missing below." : ""}
                  </p>
                  <button disabled={listing.isFetching} onClick={() => void listing.refetch()}>
                    Retry loading proposals
                  </button>
                </div>
              )}
              {listing.isSuccess && !listing.isFetching && ready && !history.isFetching && !ids.length && (
                <p>No proposals have been created yet.</p>
              )}
              <div className="app-surface gov-rows">
                {visibleIds.map((id) => {
                  const row = list.data?.find((r) => r.id === id);
                  const index = proposalIndex(BigInt(id));
                  return (
                    <div className="gov-row" key={id}>
                      <div>
                        <a className="gov-proposal-link" href={`/?proposal=${id}`}>
                          Proposal {index.toString()}
                        </a>
                        <p>
                          {row?.proposal
                            ? `${row.proposal.result[5].length} onchain action${row.proposal.result[5].length === 1 ? "" : "s"} · Metadata unavailable`
                            : row?.error || "Loading current state…"}
                        </p>
                      </div>
                      <span className="gov-status">{row?.proposal?.status ?? "Unavailable"}</span>
                    </div>
                  );
                })}
              </div>
              {(ids.length > rowsPerPage || hasNextPage) && (
                <nav aria-label="Proposal pages" className="gov-pagination">
                  <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                    Previous
                  </button>
                  <span>Page {currentPage + 1}</span>
                  <button
                    disabled={
                      ((currentPage + 1) * rowsPerPage >= ids.length && !hasNextPage) ||
                      listingFetching ||
                      currentPage < page
                    }
                    onClick={() => setPage(currentPage + 1)}
                  >
                    Next
                  </button>
                </nav>
              )}
            </section>
          </>
        )}
        {warnings.map((w, i) => (
          <p className="gov-error" role="alert" key={i}>
            {w}
          </p>
        ))}
        {history.data?.errors.map((w) => (
          <p className="gov-error" role="alert" key={w}>
            History could not be verified: {w}. Retry refresh or remove the local import.
          </p>
        ))}
        <ErrorMessage error={history.error} />
        {(receipts.length > 0 || warnings.length > 0) && (
          <details className="gov-history">
            <summary>Manage local history ({receipts.length} transactions)</summary>
            <p>Removing an import only changes this browser. Keep its hash to import it again.</p>
            {receipts.map((receipt) => (
              <div className="gov-row" key={receipt.transactionHash}>
                <Explorer value={receipt.transactionHash} kind="tx" />
                <button
                  onClick={() => {
                    try {
                      removeReceipt(window.localStorage, receipt.transactionHash);
                      reloadLocal();
                      setPage(0);
                    } catch (e) {
                      setImportError(e);
                    }
                  }}
                >
                  Remove <span className="sr-only">{receipt.transactionHash}</span>
                </button>
              </div>
            ))}
            <button onClick={() => setConfirmClear(true)}>Clear local history</button>
            {confirmClear && (
              <div className="gov-actions">
                <p>Remove all imported history from this browser?</p>
                <button onClick={() => setConfirmClear(false)}>Keep history</button>
                <button
                  onClick={() => {
                    try {
                      clearReceipts(window.localStorage);
                      reloadLocal();
                      setConfirmClear(false);
                      setPage(0);
                    } catch (e) {
                      setImportError(e);
                    }
                  }}
                >
                  Clear history
                </button>
              </div>
            )}
          </details>
        )}
      </main>
      <footer className="gov-footer">
        <p>{deployment.name}. Imported event history is stored only in this browser.</p>
        <a
          href="https://github.com/0xIntuition/intuition-contracts-v2-governance"
          target="_blank"
          rel="noopener noreferrer"
        >
          Governance contracts
        </a>
      </footer>
    </div>
  );
}

type Event = ReturnType<typeof decodeStoredEvents>[number];
function ProposalDetail({
  id,
  events,
  enabled,
  onConfirmed,
}: {
  id: string;
  events: Event[];
  enabled: boolean;
  onConfirmed: (hash: Hex) => Promise<void>;
}) {
  const proposal = useQuery({ queryKey: proposalKey(id), queryFn: () => readProposal(BigInt(id)), enabled });
  const { address, chainId } = useAccount();
  const { data: wallet } = useWalletClient();
  const voting = useQuery({
    queryKey: ["governance-voting", ...governanceKey, id, address, proposal.data?.blockNumber.toString()],
    queryFn: () => readVotingPower(proposal.data!, address!),
    enabled: enabled && !!proposal.data && !!address,
  });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [txHash, setTxHash] = useState<Hex>();
  const [confirmed, setConfirmed] = useState(false);
  const [reviewAction, setReviewAction] = useState<"veto" | "execute">();
  useEffect(() => {
    setReviewAction(undefined);
    setTxHash(undefined);
    setConfirmed(false);
    setError(null);
  }, [id, address]);
  const send = async (action: "veto" | "execute") => {
    if (pendingRef.current || !wallet || !address) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setConfirmed(false);
    setTxHash(undefined);
    try {
      if ((await wallet.getChainId()) !== deployment.chainId)
        throw new Error(`Switch your wallet to ${deployment.name} first.`);
      if (!isAddressEqual(wallet.account.address, address))
        throw new Error("Your wallet account changed. Review the proposal again.");
      await verifyDeployment();
      const fresh = await readProposal(BigInt(id));
      if (action === "execute" && !fresh.executable)
        throw new Error("This proposal cannot currently execute. Refresh its status.");
      if (action === "veto" && !(await readVotingPower(fresh, address)).canVeto)
        throw new Error("This wallet cannot veto this proposal at the latest block.");
      const simulation = await governanceClient.simulateContract({
        address: deployment.plugin,
        abi: pluginAbi,
        functionName: action,
        args: [BigInt(id)],
        account: address,
        blockTag: "pending",
      });
      if ((await wallet.getChainId()) !== deployment.chainId)
        throw new Error("The wallet network changed. Review and try again.");
      const hash = await wallet.writeContract(simulation.request);
      setTxHash(hash);
      setReviewAction(undefined);
      let replacementReason: string | undefined;
      const receipt = await governanceClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
        pollingInterval: 4000,
        onReplaced: ({ reason, transactionReceipt }) => {
          replacementReason = reason;
          setTxHash(transactionReceipt.transactionHash);
        },
      });
      if (replacementReason && replacementReason !== "repriced")
        throw new Error(
          "The transaction was cancelled or replaced with a different call. Refresh the proposal before trying again."
        );
      if (receipt.status !== "success") throw new Error("The transaction reverted. No governance change was applied.");
      setConfirmed(true);
      await onConfirmed(receipt.transactionHash);
      await proposal.refetch();
      await voting.refetch();
    } catch (e) {
      setError(e);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  if (proposal.isPending) return <p role="status">Loading proposal from the RPC…</p>;
  if (!proposal.data) return <ErrorMessage error={proposal.error} />;
  const p = proposal.data;
  const creator = events.find((e) => e.name === "ProposalCreated" && e.proposalId === id);
  const ownEvents = events.filter((e) => e.proposalId === id);
  const reference = metadataReference(p.result[4]);
  const writable =
    enabled && !proposal.isFetching && !proposal.isError && !!wallet && chainId === deployment.chainId && !pending;
  return (
    <article className="gov-detail">
      <div className="gov-title">
        <h2>Proposal {(p.id & ((1n << 64n) - 1n)).toString()}</h2>
        <span className="gov-status">{p.status}</span>
      </div>
      <p className="gov-hash">{id}</p>
      <ErrorMessage error={proposal.error} />
      <dl className="gov-facts">
        <dt>Proposed by</dt>
        <dd>
          {creator?.creator ? (
            <Explorer value={creator.creator}>
              {isAddressEqual(creator.creator as Address, deployment.manager)
                ? `Manager (${deployment.managerLabel})`
                : short(creator.creator)}
            </Explorer>
          ) : (
            "Creation receipt not imported"
          )}
        </dd>
        <dt>Veto window ends</dt>
        <dd>{date(p.result[2].vetoEndDate)}</dd>
        <dt>Voting snapshot</dt>
        <dd>{date(p.result[2].snapshotTimestamp)}</dd>
        <dt>Veto power</dt>
        <dd>{units(p.result[3])} veTRUST</dd>
        <dt>Required to veto</dt>
        <dd>
          {units(p.threshold)} veTRUST ({p.result[2].minVetoRatio / 10000}%, rounded up)
        </dd>
        <dt>Total snapshot power</dt>
        <dd>{units(p.supply)} veTRUST</dd>
        <dt>Confirmed state read at</dt>
        <dd>
          Block {p.blockNumber.toString()} · {date(p.blockTimestamp)}
        </dd>
      </dl>
      <section>
        <h2>Proposal description</h2>
        <p>Metadata unavailable. The actions below come directly from the contract.</p>
        {reference && (
          <details>
            <summary>Metadata reference</summary>
            <p className="gov-hash">{reference}</p>
          </details>
        )}
      </section>
      <section>
        <h2>Onchain actions</h2>
        <p>Execution runs these calls through the DAO. Review every target, value and calldata before executing.</p>
        {p.result[6] !== 0n && (
          <p className="gov-error">Some action failures are allowed by this proposal: {p.result[6].toString()}.</p>
        )}
        {p.result[5].length ? (
          p.result[5].map((action, index) => (
            <ActionView
              key={index}
              action={action}
              block={p.blockNumber}
              timestamp={p.blockTimestamp}
              vetoEnd={p.result[2].vetoEndDate}
            />
          ))
        ) : (
          <p>No actions.</p>
        )}
      </section>
      <section>
        <h2>Your voting power</h2>
        <p>
          Eligibility is evaluated for the next block. Current power decays with time; the proposal snapshot stays
          fixed.
        </p>
        {!address ? (
          <p>Connect your wallet to check snapshot power and veto eligibility.</p>
        ) : (
          <>
            <ErrorMessage error={voting.error} />
            {voting.isPending ? (
              <p>Reading voting power…</p>
            ) : (
              voting.data && (
                <>
                  <dl className="gov-facts">
                    <dt>At this snapshot</dt>
                    <dd>{units(voting.data.snapshot)} veTRUST</dd>
                    <dt>Current power</dt>
                    <dd>{units(voting.data.current)} veTRUST</dd>
                  </dl>
                  <p>
                    {voting.data.canVeto
                      ? "Your wallet can veto this proposal."
                      : voting.data.hasVetoed
                        ? "Your wallet has already vetoed."
                        : voting.data.snapshot === 0n
                          ? "Your wallet had no voting power at the snapshot."
                          : "The veto window is closed or this proposal is no longer active."}
                  </p>
                </>
              )
            )}
          </>
        )}
        {chainId && chainId !== deployment.chainId && <p>Switch to {deployment.name} to submit a transaction.</p>}
        <div className="gov-actions">
          <button
            className={!reviewAction && voting.data?.canVeto ? "gov-primary" : undefined}
            disabled={!writable || voting.isFetching || voting.isError || !voting.data?.canVeto}
            onClick={() => setReviewAction("veto")}
          >
            Veto proposal
          </button>
          <button
            className={!reviewAction && p.executable ? "gov-primary" : undefined}
            disabled={!writable || !p.executable}
            onClick={() => setReviewAction("execute")}
          >
            Execute proposal
          </button>
        </div>
        {reviewAction && (
          <div className="gov-confirm">
            <h3>{reviewAction === "veto" ? "Confirm your veto" : "Confirm proposal execution"}</h3>
            <p>
              {reviewAction === "veto"
                ? "This uses your voting power at the snapshot to oppose this proposal. A veto cannot be undone."
                : "Anyone may execute an eligible proposal. This will run all actions above through the DAO, including any upgrades. The full call will be simulated before opening your wallet."}
            </p>
            <div className="gov-actions">
              <button disabled={pending} onClick={() => setReviewAction(undefined)}>
                Cancel
              </button>
              <button
                className="gov-primary"
                disabled={!writable}
                aria-busy={pending}
                onClick={() => void send(reviewAction)}
              >
                Confirm {reviewAction}
              </button>
            </div>
          </div>
        )}
        {pending && (
          <p role="status">
            {txHash ? "Waiting for the transaction receipt…" : "Checking current state and preparing your wallet…"}
          </p>
        )}
        {txHash && (
          <p role="status">
            {confirmed ? "Transaction confirmed." : "Transaction submitted; confirmation is not yet known."}{" "}
            <Explorer value={txHash} kind="tx">
              View transaction
            </Explorer>
          </p>
        )}
        <ErrorMessage error={error} />
      </section>
      <section>
        <h2>Imported activity</h2>
        <p>This is only the activity imported into this browser, not a complete voter list.</p>
        {ownEvents.length ? (
          ownEvents.map((event) => (
            <div className="gov-row" key={`${event.transactionHash}:${event.logIndex}`}>
              <div>
                {event.name === "ProposalCreated"
                  ? "Proposal created"
                  : event.name === "ProposalExecuted"
                    ? "Proposal executed"
                    : "Veto cast"}
                {event.voter && (
                  <p>
                    <Explorer value={event.voter} /> · {units(event.votingPower ?? 0n)} veTRUST
                  </p>
                )}
              </div>
              <Explorer value={event.transactionHash} kind="tx" />
            </div>
          ))
        ) : (
          <p>No activity receipts imported for this proposal.</p>
        )}
      </section>
    </article>
  );
}

function ActionView({
  action,
  block,
  timestamp,
  vetoEnd,
  depth = 0,
}: {
  action: Action;
  block: bigint;
  timestamp: bigint;
  vetoEnd: bigint;
  depth?: number;
}) {
  const decoded = useMemo(() => decodeAction(action), [action]);
  const operation = useQuery({
    queryKey: ["governance-operation", ...governanceKey, action.to, decoded.operationId, block.toString()],
    enabled: !!decoded.operationId,
    queryFn: async () => {
      const eta = await governanceClient.readContract({
        address: action.to,
        abi: timelockAbi,
        functionName: "getTimestamp",
        args: [decoded.operationId!],
        blockNumber: block,
      });
      const ready = await governanceClient.readContract({
        address: action.to,
        abi: timelockAbi,
        functionName: "isOperationReady",
        args: [decoded.operationId!],
        blockTag: "pending",
      });
      return { eta, ready };
    },
  });
  const eta = operation.data?.eta;
  return (
    <div className="gov-action">
      <h3>{decoded.name}</h3>
      <dl className="gov-facts">
        <dt>Target</dt>
        <dd>
          <Explorer value={action.to} />
        </dd>
        <dt>Value</dt>
        <dd>
          {formatUnits(action.value, deployment.nativeCurrency.decimals)} {deployment.nativeCurrency.symbol}
        </dd>
        {decoded.proxy && (
          <>
            <dt>Proxy</dt>
            <dd>
              <Explorer value={decoded.proxy} />
            </dd>
            <dt>New implementation</dt>
            <dd>
              <Explorer value={decoded.implementation!} />
            </dd>
          </>
        )}
      </dl>
      {decoded.operationId && (
        <>
          <ErrorMessage error={operation.error} />
          <p>
            {eta === undefined
              ? "Timelock status unavailable."
              : eta === 0n
                ? "Not currently scheduled. This alone does not prove whether the operation was cancelled."
                : eta === 1n
                  ? "Timelock operation completed."
                  : operation.data?.ready
                    ? `Timelock ready for the next block. The proposal veto period must also have ended (${date(vetoEnd)}).`
                    : `Timelock waiting. Earliest execution: ${date(eta > vetoEnd ? eta : vetoEnd)}.`}
          </p>
          <details>
            <summary>Operation ID</summary>
            <p className="gov-hash">{decoded.operationId}</p>
          </details>
        </>
      )}
      <details>
        <summary>Raw calldata</summary>
        <pre>{action.data}</pre>
      </details>
      {depth < 2 &&
        decoded.children?.map((child, i) => (
          <ActionView key={i} action={child} block={block} timestamp={timestamp} vetoEnd={vetoEnd} depth={depth + 1} />
        ))}
    </div>
  );
}
