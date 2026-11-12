import Head from "next/head";
import Link from "next/link";
import { Fragment, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { isAddressEqual, type Hex } from "viem";
import { deployment, governanceChain } from "./deployment";
import { governanceClient, governanceKey, verifyDeployment } from "./rpc";
import { canWithdraw, DAY, makeLockPlan, prepareLockTransaction, readLockState, sameLockIntent } from "./locking";
import { date, ErrorMessage, Explorer, GovernanceHeader, units } from "./shared";

const addresses = [
  ["DAO", deployment.dao],
  ["Optimistic voting plugin", deployment.plugin],
  ["Governance voting adapter", deployment.adapter],
  ["veTRUST · TrustBonding", deployment.trustBonding],
  ["MultiVault", deployment.multiVault],
  ["Wrapped TRUST", deployment.wrappedTrust],
  [`Manager · ${deployment.managerLabel}`, deployment.manager],
  ["Upgrades timelock", deployment.upgradesTimelock],
  ["Parameters timelock", deployment.parametersTimelock],
  ["TrustBonding ProxyAdmin", deployment.proxyAdmin],
] as const;

type PendingTransaction = { hash: Hex; label: string; account: string; step: "wrap" | "approve" | "lock" | "withdraw" };
type Transaction = PendingTransaction & { status: string };
export default function SetupPage() {
  return (
    <div className="governance">
      <Head>
        <title>Setup & Lock TRUST · Intuition Governance</title>
      </Head>
      <a className="gov-skip" href="#setup-content">
        Skip to setup
      </a>
      <GovernanceHeader page="setup" />
      <main id="setup-content" className="gov-main gov-setup">
        <h1>{deployment.testnet ? "Testnet setup" : "Setup"}</h1>
        <p>Check the contracts behind this application and lock TRUST to participate in governance.</p>
        <LockAndSettings />
        <section aria-labelledby="addresses-title">
          <h2 id="addresses-title">Deployed contracts</h2>
          <p>
            These are the configured addresses on {deployment.name}. veTRUST is the voting power recorded by
            TrustBonding; MultiVault is a separate protocol contract.
          </p>
          <dl className="gov-addresses">
            {addresses.map(([label, address]) => (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>
                  <Explorer value={address}>{address}</Explorer>
                </dd>
              </Fragment>
            ))}
          </dl>
          <details>
            <summary>Network connection</summary>
            <dl className="gov-facts">
              <dt>Chain ID</dt>
              <dd>{deployment.chainId}</dd>
              <dt>RPC endpoint</dt>
              <dd className="gov-hash">{deployment.rpcUrl}</dd>
              <dt>Native currency</dt>
              <dd>
                {deployment.nativeCurrency.symbol} · {deployment.nativeCurrency.decimals} decimals
              </dd>
              <dt>Explorer</dt>
              <dd>
                <a href={deployment.explorer} target="_blank" rel="noopener noreferrer">
                  Open explorer
                </a>
              </dd>
            </dl>
          </details>
        </section>
      </main>
    </div>
  );
}

function LockAndSettings() {
  const { address, chainId } = useAccount();
  const { data: wallet } = useWalletClient();
  const currentWallet = useRef({ address, chainId });
  currentWallet.current = { address, chainId };
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["governance-lock", ...governanceKey, address],
    queryFn: async () => {
      const governance = await verifyDeployment();
      const lock = await readLockState(address);
      return { governance, lock };
    },
    retry: false,
    staleTime: 30_000,
  });
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<PendingTransaction>();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const state = query.data?.lock;
  let plan: ReturnType<typeof makeLockPlan> | undefined;
  let validation: unknown;
  if (state && amount && address) {
    try {
      plan = makeLockPlan(state, amount, days);
    } catch (e) {
      validation = e;
    }
  }
  const updateReceipt = async (tx: PendingTransaction) => {
    let replaced = false;
    const receipt = await governanceClient.waitForTransactionReceipt({
      hash: tx.hash,
      timeout: 120_000,
      pollingInterval: 4000,
      onReplaced: ({ reason, transactionReceipt }) => {
        replaced = reason !== "repriced";
        tx = { ...tx, hash: transactionReceipt.transactionHash };
        setPending(tx);
      },
    });
    setPending(undefined);
    const status = replaced ? "Cancelled or replaced" : receipt.status === "success" ? "Confirmed" : "Reverted";
    setTransactions((previous) => [...previous, { ...tx, status }]);
    await queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("governance-"),
    });
    if (replaced)
      throw new Error("This transaction was cancelled or replaced. Review your balances before continuing.");
    if (receipt.status !== "success")
      throw new Error("This step reverted. Your earlier confirmed steps are still complete.");
    if (tx.step === "lock" || tx.step === "withdraw") setAmount("");
  };
  const assertWallet = async (account: NonNullable<typeof address>) => {
    if (
      !wallet ||
      currentWallet.current.chainId !== deployment.chainId ||
      (await wallet.getChainId()) !== deployment.chainId
    )
      throw new Error(`Switch your wallet to ${deployment.name} first.`);
    const accounts = await wallet.getAddresses();
    if (
      !currentWallet.current.address ||
      !isAddressEqual(currentWallet.current.address, account) ||
      !accounts[0] ||
      !isAddressEqual(accounts[0], account)
    )
      throw new Error("Your wallet account changed. Review the form again.");
  };
  const submit = async (withdraw = false) => {
    if (busyRef.current || pending || !address || !wallet || (!withdraw && !plan)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await assertWallet(address);
      await verifyDeployment();
      const fresh = await readLockState(address);
      const intent = withdraw ? "withdraw" : makeLockPlan(fresh, amount, days);
      if (intent !== "withdraw" && (!plan || !sameLockIntent(plan, intent))) {
        await query.refetch();
        throw new Error("Your balances or lock details changed. Review the updated step and try again.");
      }
      const request = await prepareLockTransaction(fresh, intent);
      const gas = await governanceClient.estimateGas({ ...request, account: address, blockTag: "pending" });
      const gasPrice = await governanceClient.getGasPrice();
      const value = intent !== "withdraw" && intent.step === "wrap" ? intent.wrapAmount : 0n;
      if (fresh.nativeBalance < value + (gas * gasPrice * 12n) / 10n)
        throw new Error(`Keep more native ${deployment.nativeCurrency.symbol} in your wallet for transaction fees.`);
      await assertWallet(address);
      const hash = await wallet.sendTransaction({ ...request, account: wallet.account, chain: governanceChain });
      const label =
        intent === "withdraw"
          ? "Withdraw lock"
          : intent.step === "wrap"
            ? "Wrap TRUST"
            : intent.step === "approve"
              ? "Approve TrustBonding"
              : intent.mode === "add"
                ? "Add to lock"
                : "Create lock";
      const tx: PendingTransaction = {
        hash,
        label,
        account: address,
        step: intent === "withdraw" ? "withdraw" : intent.step,
      };
      setPending(tx);
      await updateReceipt(tx);
    } catch (e) {
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const checkReceipt = async () => {
    if (busyRef.current || !pending) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await updateReceipt(pending);
    } catch (e) {
      setError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const disabled = busy || !!pending || query.isFetching || query.isError || !wallet || chainId !== deployment.chainId;
  const action =
    plan?.step === "wrap"
      ? "Wrap TRUST"
      : plan?.step === "approve"
        ? "Approve TrustBonding"
        : plan?.mode === "add"
          ? "Add to lock"
          : "Create lock";
  return (
    <>
      <section className="gov-lock-section" aria-labelledby="lock-title">
        <div className="gov-title">
          <div>
            <h2 id="lock-title">Lock TRUST for veTRUST</h2>
            <p>Use a funded wallet. Keep some native {deployment.nativeCurrency.symbol} for transaction fees.</p>
          </div>
          <button disabled={busy || query.isFetching} onClick={() => void query.refetch()}>
            Refresh balances
          </button>
        </div>
        <ErrorMessage error={query.error} />
        {query.isPending && <p role="status">Reading lock settings and wallet balances…</p>}
        {!address && <p>Connect a wallet using the button above to prepare a lock.</p>}
        {address && chainId !== deployment.chainId && (
          <p>Switch to {deployment.name} using the wallet controls above.</p>
        )}
        {state && (
          <>
            <p>
              Locks last at least {Number(state.minTime / DAY)} days and at most {Number(state.maxTime / DAY)} days.
              Unlock dates round down to whole weeks. veTRUST decays as the unlock date approaches and cannot be
              transferred.
            </p>
            {address && (
              <dl className="gov-facts">
                <dt>Native {deployment.nativeCurrency.symbol}</dt>
                <dd>{units(state.nativeBalance)}</dd>
                <dt>Available wrapped TRUST</dt>
                <dd>{units(state.wrappedBalance)}</dd>
                <dt>Locked TRUST</dt>
                <dd>{units(state.lockedAmount)}</dd>
                <dt>Current veTRUST</dt>
                <dd>{units(state.votingPower)}</dd>
                {state.lockedAmount > 0n && (
                  <>
                    <dt>Unlock date</dt>
                    <dd>{date(state.lockEnd)}</dd>
                  </>
                )}
              </dl>
            )}
            <p>
              New locks and additions only count toward proposals created after them. They cannot give you veto power on
              proposals that already exist. <Link href="/">View proposals</Link>
            </p>
            {state.paused && (
              <p role="status">
                The contract has paused new locks and additions. Expired locks can still be withdrawn.
              </p>
            )}
            {state.unlocked && (
              <p role="status">
                The contract has unlocked all positions. Withdraw your existing lock; new deposits are disabled.
              </p>
            )}
            {canWithdraw(state) ? (
              <div>
                <p>
                  Your lock is available to withdraw. This returns wrapped TRUST to your wallet, which you can use for a
                  new lock.
                </p>
                <button className="gov-primary" disabled={disabled} onClick={() => void submit(true)}>
                  Withdraw locked TRUST
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                aria-labelledby="lock-title"
              >
                <div className="gov-lock-fields">
                  <div>
                    <label htmlFor="lock-amount">{state.lockedAmount > 0n ? "TRUST to add" : "TRUST to lock"}</label>
                    <input
                      id="lock-amount"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0.01"
                      maxLength={58}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      disabled={busy || !!pending}
                      aria-describedby="lock-funding lock-validation"
                      aria-invalid={!!validation}
                    />
                  </div>
                  {state.lockedAmount === 0n && (
                    <div>
                      <label htmlFor="lock-days">Lock duration (days)</label>
                      <input
                        id="lock-days"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        value={days}
                        onChange={(e) => setDays(e.target.value)}
                        disabled={busy || !!pending}
                        aria-describedby="lock-rounding lock-validation"
                      />
                    </div>
                  )}
                </div>
                <p id="lock-funding">
                  Existing wrapped TRUST is used first. Any shortfall is wrapped from native{" "}
                  {deployment.nativeCurrency.symbol}, then you approve only the entered amount and confirm the lock.
                  Each step is a separate wallet transaction.
                </p>
                <p id="lock-rounding">
                  {state.lockedAmount > 0n
                    ? "Adding TRUST keeps your existing unlock date."
                    : "The actual unlock date is shown below after rounding. Choose extra days if rounding puts it below the minimum."}
                </p>
                <div id="lock-validation">
                  <ErrorMessage error={validation} />
                </div>
                {plan && (
                  <div className="gov-lock-review">
                    <dl className="gov-facts">
                      <dt>{plan.mode === "add" ? "Amount to add" : "Amount to lock"}</dt>
                      <dd>{units(plan.amount)} TRUST</dd>
                      <dt>Unlock date</dt>
                      <dd>{date(plan.unlockTime)}</dd>
                      <dt>Estimated total veTRUST</dt>
                      <dd>{units(plan.estimatedPower)}</dd>
                    </dl>
                    <p>
                      Locked funds cannot be withdrawn before this date. Voting power is an estimate and changes with
                      time. Approval alone does not create the lock.
                    </p>
                    <p role="status">
                      {plan.step === "wrap"
                        ? `Next: wrap ${units(plan.wrapAmount)} ${deployment.nativeCurrency.symbol} into wrapped TRUST.`
                        : plan.step === "approve"
                          ? `Next: approve TrustBonding to spend ${units(plan.amount)} wrapped TRUST.`
                          : "Next: confirm the lock in your wallet."}
                    </p>
                  </div>
                )}
                <div className="gov-actions">
                  <button type="submit" className="gov-primary" disabled={disabled || !plan} aria-busy={busy}>
                    {action}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        {busy && (
          <p role="status">
            {pending ? "Waiting for the transaction receipt…" : "Checking the latest state and preparing your wallet…"}
          </p>
        )}
        {pending && (
          <p role="status">
            {pending.label} submitted.{" "}
            <Explorer kind="tx" value={pending.hash}>
              View pending transaction
            </Explorer>{" "}
            {!busy && <button onClick={() => void checkReceipt()}>Check confirmation</button>}
          </p>
        )}
        <ErrorMessage error={error} />
        {!!transactions.length && (
          <div className="gov-lock-transactions" aria-live="polite">
            <h3>Transactions this session</h3>
            {transactions.map((tx) => (
              <p key={tx.hash}>
                {tx.label} · {tx.status} · <Explorer kind="tx" value={tx.hash} /> · <Explorer value={tx.account} />
              </p>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="settings-title">
        <h2 id="settings-title">Governance settings</h2>
        <dl className="gov-facts">
          <dt>Veto threshold</dt>
          <dd>{query.data ? `${query.data.governance.settings[0] / 10_000}% of snapshot power` : "Unavailable"}</dd>
          <dt>Minimum veto window</dt>
          <dd>{query.data ? `${query.data.governance.settings[1]} seconds` : "Unavailable"}</dd>
          <dt>Upgrade timelock delay</dt>
          <dd>{query.data ? `${query.data.governance.timelockDelay} seconds` : "Unavailable"}</dd>
        </dl>
        <p>
          Settings and balances are read over RPC.{" "}
          {deployment.testnet ? "This testnet produces blocks when transactions arrive, so lock" : "Lock"} eligibility
          uses the pending block timestamp.
        </p>
      </section>
    </>
  );
}
