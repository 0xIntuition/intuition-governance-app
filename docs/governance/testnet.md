# Testnet governance implementation

Implemented on the existing `development` branch, 2026-11-04. This is the first usable testnet slice of the [project plan](project-plan.md), not completion of all project milestones.

## Deployment

The source manifest is `intuition-contracts-v2-governance/deployments.md` in the sibling checkout supplied by the user. Its current `config/13579.json` and generated `abis/OptimisticTokenVotingPlugin.ts` identify governance source commit `8434b5ce3a232364392c4bc3f5efbfdeefcc6d57`. The plugin ABI is bundled in `packages/ui/src/governance/plugin-abi.ts`; the application does not require the sibling checkout at runtime.

| Setting | Pinned value |
| --- | --- |
| Network | Intuition testnet, chain ID `13579` |
| RPC | `https://testnet.rpc.intuition.systems/http` |
| Explorer | `https://intuition-testnet.explorer.caldera.xyz` |
| DAO | `0x866DBeF7fcfC703FBce7eb0292912f1A9D81EC99` |
| Optimistic plugin | `0x61818dCD98276a426b6B95bDCB9E9FCC2235ED46` |
| veTRUST adapter | `0x66591cdB76D6feC57A056A53faD3d35f850354df` |
| TrustBonding proxy | `0xc72c348dD5574C10245066846cbA6ce98C3282fc` |
| Manager (testnet EOA) | `0x54C15B56800235F273bb659aea820c9D3112B3FD` |
| Upgrades timelock | `0xA531EAE7752DddF966E9959B4dab82793C971BB1` |
| Parameters timelock | `0x23C50180DF511b0cccf12a2dD0D3203b25f33Ee5` |
| TrustBonding ProxyAdmin | `0x50AAe824607eB17F65dBfaec065e8cC9F210e50E` |
| Deployment block | `9375982` |

The runtime verifies chain identity, contract bytecode, plugin DAO/adapter links, adapter TrustBonding source and supported voting mode. Live reads confirmed a 20% veto threshold, 120-second minimum duration, `skipL2 = true`, and a 120-second upgrades timelock delay. These settings are displayed from contract reads. This is real timestamp-based, decaying veTRUST, not the superseded mock-token route.

The testnet can remain idle between transactions. Confirmed proposal data, tallies and snapshot supply/power are read at a single mined block. `canExecute`, `canVeto`, current voting power, timelock readiness and pre-submit simulation use the pending block so eligibility reflects the next transaction's time. The interface labels that distinction. A ready governance proposal can still fail execution if a nested action fails; the full call is simulated before wallet submission.

## Run and exercise the fixtures

```sh
pnpm install --frozen-lockfile
pnpm --filter dao-ui dev
```

No environment file is required. `NEXT_PUBLIC_RPC_URL` optionally replaces the public RPC with another endpoint for chain 13579. `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` enables WalletConnect; injected wallets work without it. Public environment values are shipped to the browser; do not put private credentials there.

Select **Import testnet fixtures** to fetch and validate seven receipts: four creations, two vetoes and one execution. Import never sends transactions. The transactions are pinned in `packages/ui/src/governance/deployment.ts`; the receipt logs used by unit tests are in its adjacent `__tests__/fixtures` directory.

| Fixture | Proposal ID | Read-only check on 2026-11-04 |
| --- | --- | --- |
| A | `610405300457693690041668389091439876825658949632` | Executed; small-holder veto below threshold |
| B | `610405307603623395381376122209688258440691974145` | Vetoed; large-holder veto reached threshold |
| C | `610405314749553100721131663754552473100648185858` | Active |
| D | `610405553968057046140823679727932815138873147395` | Executable at pending block |

Fixture states can change as wallets interact with them. A proposal detail can also be opened with `/?proposal=<decimal-id>` without importing its creation receipt.

The fixture manifest identifies a large holder `0xbfc4cB2f93DeEd91de9a07910C957788cF95BA28` and small holder `0xd0516F34c2bf53C8df806132Ba3A335b9A5F038B`. Eligibility is always checked for the connected wallet against the proposal's snapshot. No private keys belong in the frontend.

## Supported behavior

- Import transaction hashes through RPC, validate configured emitters and ABI events, verify canonical receipt inclusion, and save raw relevant logs with block/transaction provenance.
- Revalidate local records over RPC before showing them as verified evidence. Missing/reverted/noncanonical receipts and malformed records produce recoverable errors.
- Store up to 100 receipts in versioned keys scoped to chain/DAO/plugin. Duplicate imports are idempotent; different tabs do not overwrite a shared receipt array. Remove or clear only this deployment's history.
- Display known proposals with bounded pagination and live state. Details include snapshot voting power, correctly rounded veto threshold, imported activity, raw calldata and supported timelock/proxy upgrade decoding.
- Connect a wallet, switch to the pinned testnet, review and simulate veto/execution, then submit through the wallet. On confirmation, independently save the receipt and refresh chain data. Failed history persistence is reported separately from successful confirmation. Cancelled/replaced calls are not presented as successful governance actions.

No deployment-to-head scans, indexer, external ABI lookup, metadata download, server-side cache, or pinning endpoint is used by the active application. The old `/api/ipfs` and `/api/pin` handlers have been removed. Unsupported plugin routes do not expose legacy functionality.

## Limits and remaining work

Local history is partial, browser-specific and origin-specific. A second browser or changed hosting origin starts empty. Clearing site data removes it. Keep transaction hashes for recovery. RPC verification establishes current inclusion, not irreversible finality.

Fixtures A–C refer to unpinned IPFS metadata; D has empty metadata. The interface deliberately shows unavailable descriptions and the onchain reference. RPC cannot reconstruct documents that were never published. Action bytes and current contract reads remain available.

This slice supports only the supplied testnet deployment. Mainnet/anvil selection, proposal creation, manager/Safe export, rich metadata preparation and publishing, broader ABI decoding, full timelock evidence presentation, public hosting and legacy dependency cleanup remain in the project backlog. The manager EOA here must not be represented as a Safe. Legacy builder code is retained for subsequent reuse but is not routed into this interface.

## Validation

```sh
pnpm --filter dao-ui type-check
pnpm --filter dao-ui lint
pnpm --filter dao-ui test
pnpm --filter dao-ui build
CHECK_GOVERNANCE_RPC=1 pnpm --filter dao-ui exec vitest run src/governance/__tests__/deployment.integration.test.ts
```

The live check only reads RPC; it does not sign or broadcast. Unit coverage includes recorded creation/veto/execution receipts, foreign emitters, Safe-wrapped log handling, malformed inputs, missing/noncanonical receipts, storage corruption/quota failure, bigint precision, threshold rounding, pinned confirmed reads versus pending eligibility, and nested action decoding.

Results on 2026-11-04: typecheck and lint passed; 253 unit tests passed across 33 files (the opt-in live test is skipped by default); the separate live test passed; production build passed and emitted only static page routes. Static security, logic and CI/history review found no HIGH issues. The identified receipt-save, pagination and replacement-handling issues were corrected; logic fixes were independently rechecked. Existing toolchain warnings about deprecated `next lint`, Browserslist age and workspace build-script configuration remain outside this slice.

Manual UI and wallet review remains user-owned: import fixtures, reload, open proposal C/D, compare the visible actions, and check wallet veto/execution with the intended test account. Browser QA and signed transactions were not performed during implementation.
