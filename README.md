# Intuition governance UI

The application connects to the November 2026 Intuition testnet governance deployment. Import transaction hashes to discover proposals, retain receipt history in this browser, and read current state directly over RPC. No indexer, subgraph, database, pinning credential, or application backend is needed.

```sh
pnpm install --frozen-lockfile
pnpm --filter dao-ui dev
```

Open the local development URL and select **Import testnet fixtures**. The four deployed proposals exercise executed, vetoed, active, and executable states. Importing only reads chain data; veto and execution require a connected testnet wallet and explicit confirmation.

The pinned public RPC works without an environment file. Optional overrides are documented in `packages/ui/.env.example`. WalletConnect requires a project ID; an injected wallet does not.

See [testnet setup, deployment provenance and limitations](docs/governance/testnet.md), the [RPC-first MVP specification](docs/governance/rpc-mvp.md), and the [Linear milestone plan](docs/governance/project-plan.md). Proposal creation/Safe export and mainnet configuration are subsequent work.

This monorepo derives from [Aragon's Taiko UI](https://github.com/aragon/taiko-ui), with a customized `aragon-ods-fork` component package and the application in `packages/ui`. Reusable legacy modules remain in the source tree while the active routes use the new governance interface.
