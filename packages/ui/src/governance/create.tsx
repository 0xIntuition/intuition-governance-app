import Head from "next/head";
import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { isAddressEqual, type Address, type Hex } from "viem";
import { deployment } from "./deployment";
import { decodeStoredEvents } from "./events";
import { decodeAction, fetchReceipt, governanceClient, governanceKey, verifyDeployment } from "./rpc";
import { canPropose, makeProposalPlan, prepareProposal, type ProposalDraft, type ProposalPlan } from "./proposing";
import { saveReceipt } from "./storage";
import { ErrorMessage, Explorer, GovernanceHeader, message, units } from "./shared";

type SentProposal = { hash: Hex; account: Address; data: Hex };
const emptyAction = () => ({ to: "", value: "0", data: "0x" });
export default function CreateProposalPage() {
  const { address, chainId } = useAccount();
  const { data: wallet } = useWalletClient();
  const current = useRef({ address, chainId });
  current.current = { address, chainId };
  const [draft, setDraft] = useState<ProposalDraft>({
    kind: "test",
    proposer: "",
    metadata: "",
    duration: "",
    actions: [emptyAction()],
  });
  const [review, setReview] = useState<{ account: Address; data: Hex }>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>();
  const [sent, setSent] = useState<SentProposal>();
  const [created, setCreated] = useState<string>();
  const [storageWarning, setStorageWarning] = useState<string>();
  const config = useQuery({
    queryKey: ["proposal-config", ...governanceKey],
    queryFn: () => verifyDeployment(),
    refetchInterval: 30_000,
  });
  const minimum = BigInt(config.data?.settings[1] ?? 120);
  const resolved = { ...draft, duration: draft.duration || minimum.toString() };
  let plan: ProposalPlan | undefined;
  let validation: unknown;
  try {
    plan = makeProposalPlan(resolved, minimum);
  } catch (e) {
    validation = e;
  }
  const permission = useQuery({
    queryKey: ["proposal-permission", ...governanceKey, address, plan?.data],
    queryFn: () => canPropose(address!, plan?.data ?? "0x"),
    enabled: !!address && !!config.data && !config.isError,
    refetchInterval: 15_000,
  });
  const authorized =
    !!address &&
    !!wallet &&
    chainId === deployment.chainId &&
    config.isSuccess &&
    !config.isFetching &&
    permission.isSuccess &&
    permission.data &&
    !permission.isFetching;
  const reviewed =
    !!plan && !!review && address === review.account && chainId === deployment.chainId && plan.data === review.data;
  const update = (patch: Partial<ProposalDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setReview(undefined);
    setError(undefined);
  };

  const confirm = async (transaction: SentProposal) => {
    let replaced = false;
    const receipt = await governanceClient.waitForTransactionReceipt({
      hash: transaction.hash,
      timeout: 120_000,
      pollingInterval: 4000,
      onReplaced: ({ reason, transactionReceipt }) => {
        replaced = reason !== "repriced";
        transaction = { ...transaction, hash: transactionReceipt.transactionHash };
        setSent(transaction);
      },
    });
    if (replaced || receipt.status !== "success") {
      setSent(undefined);
      throw new Error(
        replaced
          ? "The transaction was cancelled or replaced with a different call. Review before trying again."
          : "The transaction reverted. No proposal was created."
      );
    }
    const onchain = await governanceClient.getTransaction({ hash: receipt.transactionHash });
    if (
      !onchain.to ||
      !isAddressEqual(onchain.to, deployment.plugin) ||
      !isAddressEqual(onchain.from, transaction.account) ||
      onchain.input.toLowerCase() !== transaction.data.toLowerCase() ||
      onchain.value !== 0n
    ) {
      setSent(undefined);
      throw new Error("The confirmed transaction does not match the proposal you reviewed.");
    }
    const stored = await fetchReceipt(receipt.transactionHash);
    const event = decodeStoredEvents(stored).find(
      (event) => event.name === "ProposalCreated" && event.creator?.toLowerCase() === transaction.account.toLowerCase()
    );
    if (!event?.proposalId)
      throw new Error("No proposal creation event was found. Check the transaction in the explorer.");
    // Use the mined event's ID, never the simulation result (ID includes time).
    setCreated(event.proposalId);
    try {
      saveReceipt(window.localStorage, stored);
    } catch (e) {
      setStorageWarning(message(e));
    }
  };
  const send = async () => {
    if (busyRef.current || sent || !reviewed || !authorized || !address || !wallet || !plan) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const checkWallet = async () => {
        const accounts = await wallet.getAddresses();
        if (
          current.current.address !== address ||
          current.current.chainId !== deployment.chainId ||
          (await wallet.getChainId()) !== deployment.chainId ||
          !accounts[0] ||
          !isAddressEqual(accounts[0], address) ||
          !isAddressEqual(wallet.account.address, address)
        )
          throw new Error("Your wallet or network changed. Review the proposal again on Intuition testnet.");
      };
      await checkWallet();
      const simulation = await prepareProposal(address, resolved);
      await checkWallet();
      const hash = await wallet.writeContract(simulation.request);
      const transaction = { hash, account: address, data: plan.data };
      setSent(transaction);
      setReview(undefined);
      await confirm(transaction);
    } catch (e) {
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const recheck = async () => {
    if (!sent || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await confirm(sent);
    } catch (e) {
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="governance">
      <Head>
        <title>New proposal · Intuition governance</title>
      </Head>
      <a className="gov-skip" href="#create-content">
        Skip to proposal form
      </a>
      <GovernanceHeader page="create" />
      <main id="create-content" className="gov-main gov-create">
        <h1>New proposal</h1>
        <p>Create a test proposal, invite another proposer, or submit contract calls for governance.</p>
        <div aria-live="polite">
          {!address ? (
            <p>Connect your wallet to check proposer access.</p>
          ) : config.isPending || permission.isPending ? (
            <p>Checking proposer access…</p>
          ) : permission.isSuccess ? (
            <p>
              {permission.data
                ? "Your wallet has permission to propose."
                : "This wallet cannot create this proposal. An existing proposer can submit an Add proposer proposal for your address."}
            </p>
          ) : null}
          {address && chainId !== deployment.chainId && <p>Switch your wallet to Intuition testnet to continue.</p>}
        </div>
        <ErrorMessage error={config.error || permission.error} />
        {(config.isError || permission.isError) && (
          <button
            onClick={() => {
              void config.refetch();
              void permission.refetch();
            }}
          >
            Retry access check
          </button>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (authorized && plan) setReview({ account: address!, data: plan.data });
          }}
        >
          <fieldset disabled={busy || !!sent} className="gov-create-fields">
            <label htmlFor="proposal-kind">Proposal type</label>
            <select
              id="proposal-kind"
              value={draft.kind}
              onChange={(event) => update({ kind: event.target.value as ProposalDraft["kind"] })}
            >
              <option value="test">Test proposal · no actions</option>
              <option value="proposer">Add proposer</option>
              <option value="calls">Contract calls</option>
            </select>
            {draft.kind === "test" && <p>Test the veto and execution flow with no contract actions or transfers.</p>}
            {draft.kind === "proposer" && (
              <>
                <p>
                  The DAO manages proposer permissions. Your manager or deployer role does not grant direct access to
                  change them. The new wallet gains access only after this proposal passes its veto window and is
                  executed.
                </p>
                <label htmlFor="proposer-address">Wallet to add</label>
                <input
                  id="proposer-address"
                  required={true}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x…"
                  value={draft.proposer}
                  onChange={(event) => update({ proposer: event.target.value })}
                />
                <p>
                  This grants permission to create governance proposals. It does not grant permission to schedule
                  timelock operations or manage other permissions directly.
                </p>
              </>
            )}
            {draft.kind === "calls" && (
              <>
                <p>
                  Actions execute in order from the DAO. All actions must succeed. Native TRUST values are paid from the
                  DAO balance when the proposal executes.
                </p>
                {draft.actions.map((action, index) => {
                  const changeAction = (patch: Partial<typeof action>) =>
                    update({ actions: draft.actions.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
                  return (
                    <div className="gov-action" key={index}>
                      <h2>Action {index + 1}</h2>
                      <label htmlFor={`target-${index}`}>Target contract or recipient</label>
                      <input
                        id={`target-${index}`}
                        required={true}
                        autoComplete="off"
                        spellCheck={false}
                        value={action.to}
                        onChange={(event) => changeAction({ to: event.target.value })}
                        placeholder="0x…"
                      />
                      <label htmlFor={`value-${index}`}>Native TRUST amount</label>
                      <input
                        id={`value-${index}`}
                        required={true}
                        inputMode="decimal"
                        value={action.value}
                        onChange={(event) => changeAction({ value: event.target.value })}
                      />
                      <label htmlFor={`data-${index}`}>Calldata</label>
                      <textarea
                        id={`data-${index}`}
                        required={true}
                        spellCheck={false}
                        rows={3}
                        value={action.data}
                        onChange={(event) => changeAction({ data: event.target.value })}
                      />
                      {draft.actions.length > 1 && (
                        <button
                          type="button"
                          onClick={() => update({ actions: draft.actions.filter((_, i) => i !== index) })}
                        >
                          Remove action {index + 1}
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  disabled={draft.actions.length >= 10}
                  onClick={() => update({ actions: [...draft.actions, emptyAction()] })}
                >
                  Add action
                </button>
              </>
            )}
            <div className="gov-lock-fields">
              <div>
                <label htmlFor="proposal-duration">Veto window (seconds)</label>
                <input
                  id="proposal-duration"
                  required={true}
                  inputMode="numeric"
                  value={resolved.duration}
                  onChange={(event) => update({ duration: event.target.value })}
                />
                <p>Minimum: {minimum.toString()} seconds, read from the contract.</p>
              </div>
              <div>
                <label htmlFor="proposal-metadata">Metadata URI (optional)</label>
                <input
                  id="proposal-metadata"
                  autoComplete="off"
                  value={draft.metadata}
                  onChange={(event) => update({ metadata: event.target.value })}
                  placeholder="ipfs://… or https://…"
                />
                <p>Use an existing document URI. No upload service is required.</p>
              </div>
            </div>
            <ErrorMessage error={validation} />
            {!reviewed && !sent && (
              <div className="gov-actions">
                <button className="gov-primary" type="submit" disabled={!authorized || !plan}>
                  Review proposal
                </button>
              </div>
            )}
          </fieldset>
        </form>
        {reviewed && plan && !sent && (
          <section className="gov-lock-review" aria-labelledby="proposal-review">
            <h2 id="proposal-review">Review proposal</h2>
            <p>
              Veto window: {resolved.duration} seconds. All actions must succeed. Creating this proposal starts the veto
              window; it does not execute the actions.
            </p>
            {draft.kind === "proposer" && (
              <p>
                Grant proposer access to <Explorer value={draft.proposer.trim()}>{draft.proposer.trim()}</Explorer>.
              </p>
            )}
            {plan.args[1].length === 0 && <p>No actions or transfers.</p>}
            {plan.args[1].map((action, index) => (
              <div className="gov-action" key={index}>
                <h3>
                  Action {index + 1} · {decodeAction(action).name}
                </h3>
                <dl className="gov-facts">
                  <dt>Target</dt>
                  <dd>
                    <Explorer value={action.to}>{action.to}</Explorer>
                  </dd>
                  <dt>Native TRUST</dt>
                  <dd>{units(action.value)}</dd>
                </dl>
                <details>
                  <summary>Exact calldata</summary>
                  <pre>{action.data}</pre>
                </details>
              </div>
            ))}
            <div className="gov-actions">
              <button disabled={busy} onClick={() => setReview(undefined)}>
                Edit proposal
              </button>
              <button
                className="gov-primary"
                disabled={!authorized || busy}
                aria-busy={busy}
                onClick={() => void send()}
              >
                Create proposal
              </button>
            </div>
          </section>
        )}
        {busy && (
          <p role="status">
            {sent ? "Waiting for transaction confirmation…" : "Checking the proposal and waiting for your wallet…"}
          </p>
        )}
        {sent && (
          <p>
            Transaction: <Explorer value={sent.hash} kind="tx" />
          </p>
        )}
        {sent && !created && !busy && (
          <>
            <p>Confirmation is not yet verified. Check the existing transaction before submitting another proposal.</p>
            <button onClick={() => void recheck()}>Check confirmation</button>
          </>
        )}
        {created && (
          <p role="status">
            Proposal created. <Link href={`/?proposal=${created}`}>Open proposal</Link> to follow its veto window and
            execute it when eligible.
          </p>
        )}
        {storageWarning && (
          <p role="alert">
            {storageWarning} Keep the transaction hash to import it later; the proposal was created successfully.
          </p>
        )}
        <ErrorMessage error={error} />
      </main>
    </div>
  );
}
