import Link from "next/link";
import type { ReactNode } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { formatUnits } from "viem";
import { deployment } from "./deployment";

export const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
export const message = (error: unknown) =>
  error instanceof Error ? error.message.split("\n")[0] : "The request failed. Please retry.";
export const units = (value: bigint) => formatUnits(value, deployment.tokenDecimals);
export const date = (value: bigint) => new Date(Number(value) * 1000).toLocaleString();
export function Explorer({
  value,
  kind = "address",
  children,
}: {
  value: string;
  kind?: "address" | "tx";
  children?: ReactNode;
}) {
  return (
    <a href={`${deployment.explorer}/${kind}/${value}`} target="_blank" rel="noopener noreferrer" title={value}>
      {children ?? short(value)}
    </a>
  );
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <p className="gov-error" role="alert">
      {message(error)}
    </p>
  ) : null;
}
export function Wallet() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  return (
    <div className="gov-wallet">
      {isConnected && address ? (
        <>
          <span title={address}>{short(address)}</span>
          {chainId !== deployment.chainId && (
            <button disabled={switching} onClick={() => switchChain({ chainId: deployment.chainId })}>
              Switch to testnet
            </button>
          )}
          <button onClick={() => disconnect()}>Disconnect</button>
        </>
      ) : (
        connectors.map((connector) => (
          <button key={connector.uid} disabled={isPending} onClick={() => connect({ connector })}>
            Connect {connector.name === "Injected" ? "wallet" : connector.name}
          </button>
        ))
      )}
      <ErrorMessage error={error || switchError} />
    </div>
  );
}

export function GovernanceHeader({ page }: { page: "proposals" | "setup" | "create" }) {
  return (
    <header className="gov-header">
      <Link className="gov-brand" href="/">
        Intuition <span>Governance</span>
      </Link>
      <nav className="gov-nav" aria-label="Main navigation">
        <Link href="/" aria-current={page === "proposals" ? "page" : undefined}>
          Proposals
        </Link>
        <Link href="/proposals/new" aria-current={page === "create" ? "page" : undefined}>
          New proposal
        </Link>
        <Link href="/setup" aria-current={page === "setup" ? "page" : undefined}>
          Setup & lock TRUST
        </Link>
      </nav>
      <div className="gov-network">
        {deployment.name} · {deployment.chainId}
      </div>
      <Wallet />
    </header>
  );
}
