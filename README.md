# Intuition governance UI

The application connects to the November 2026 Intuition testnet governance deployment. An optional governance indexer discovers proposals and event history automatically. Current state and transaction eligibility come directly from RPC. Manual receipt import and browser-local history remain available when the indexer is absent or unavailable; no backend is required for that fallback.

```sh
pnpm install --frozen-lockfile
pnpm --filter dao-ui dev
```

In development, the UI connects to the local indexer at `http://127.0.0.1:42069` when available. See [indexer integration and local startup](docs/governance/indexer.md). Without it, expand **Import a transaction manually** and select **Import testnet fixtures**. The four deployed proposals exercise executed, vetoed, active, and executable states. Discovery/import only reads data; veto and execution require a connected testnet wallet and explicit confirmation.

Open **Setup & lock TRUST** (`/setup`) to inspect the configured contracts, including MultiVault and TrustBonding, and create a veTRUST lock. The form guides a funded testnet wallet through wrapping TRUST, approving the entered amount, and locking it. Existing locks can receive additions; expired locks can be withdrawn as wrapped TRUST.

The pinned public RPC works without an environment file. Optional overrides are documented in `packages/ui/.env.example`. WalletConnect requires a project ID; an injected wallet does not.

See [testnet setup, deployment provenance and limitations](docs/governance/testnet.md), the [RPC-first MVP specification](docs/governance/rpc-mvp.md), and the [Linear milestone plan](docs/governance/project-plan.md). Proposal creation/Safe export and mainnet configuration are subsequent work.

This monorepo derives from [Aragon's Taiko UI](https://github.com/aragon/taiko-ui), with a customized `aragon-ods-fork` component package and the application in `packages/ui`. Reusable legacy modules remain in the source tree while the active routes use the new governance interface.
