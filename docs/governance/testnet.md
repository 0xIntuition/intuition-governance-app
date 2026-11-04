# Testnet governance implementation

Implemented on the existing `development` branch, 2026-11-04. This is the first usable testnet slice of the [project plan](project-plan.md), not completion of all project milestones.

Follow-up: [optional automatic discovery and indexed activity](indexer.md) now augment these RPC flows. Manual receipt import remains available as a fallback; indexed history does not replace fresh contract checks.

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
| MultiVault proxy | `0xAC1AA948D5c40b6C60a07170C5794E595d08C32c` |
| Wrapped testnet TRUST | `0xDE80b6EE63f7D809427CA350e30093F436A0fe35` |
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

### Setup and locking

The `/setup` page lists the full configured addresses with explorer links, live governance settings, and network connection details. It is linked from both proposal and setup navigation. veTRUST is the non-transferable voting weight recorded by TrustBonding; the voting adapter exposes that history to governance. MultiVault is listed as a separate core contract.

The lock form uses `VotingEscrow.sol` / `TrustBonding.sol` at core commit `91c1a24` and the sequence in `script/testnet/LockTrust.s.sol`. RPC checks verified that TrustBonding points to the configured wrapped TRUST and MultiVault contracts, the token uses 18 decimals, and locks require at least 14 days and at most 730 days. Unlock dates round down to whole weeks; minimum duration is checked **after** that rounding. The form defaults to 30 days and displays the actual date before any transaction.

For a new lock, enter an amount and duration, then complete each explicit wallet action:

1. Wrap only the amount missing from the wallet's existing wrapped TRUST balance.
2. Approve the entered amount for the configured TrustBonding contract. Existing sufficient allowance skips this step.
3. Create the lock. Each step rechecks configuration, wallet account/network, balances and lock intent, simulates the exact call, and checks estimated gas funds before opening the wallet.

Active locks accept additions at their existing unlock date. Expired or globally unlocked positions can be withdrawn as **wrapped TRUST**, including while deposits are paused. Duration extensions and unwrapping are outside this form's scope. Unsupported smart wallets are rejected unless allowed by the contract. No faucet, gas sponsor or custodial key is introduced; testers need funded wallets.

Confirmed wrapping and approvals remain usable if a later step is rejected. Current balances and allowances determine the next step on return. While this page is open, an unresolved transaction blocks repeat submissions and offers a confirmation retry; successful lock/withdraw confirmation clears the amount, including after a timeout. Transaction links are session-local. No lock receipt is sent to the governance-event importer, which accepts proposal/timelock events only.

New deposits only affect future proposal snapshots. They do not give a new tester voting power on the existing fixtures. Create a subsequent proposal after the test wallets have locked funds. The displayed veTRUST estimate follows the contract's integer division and linear decay; live voting weight remains authoritative.

### Proposals

- Import transaction hashes through RPC, validate configured emitters and ABI events, verify canonical receipt inclusion, and save raw relevant logs with block/transaction provenance.
- Revalidate local records over RPC before showing them as verified evidence. Missing/reverted/noncanonical receipts and malformed records produce recoverable errors.
- Store up to 100 receipts in versioned keys scoped to chain/DAO/plugin. Duplicate imports are idempotent; different tabs do not overwrite a shared receipt array. Remove or clear only this deployment's history.
- Display known proposals with bounded pagination and live state. Details include snapshot voting power, correctly rounded veto threshold, imported activity, raw calldata and supported timelock/proxy upgrade decoding.
- Connect a wallet, switch to the pinned testnet, review and simulate veto/execution, then submit through the wallet. On confirmation, independently save the receipt and refresh chain data. Failed history persistence is reported separately from successful confirmation. Cancelled/replaced calls are not presented as successful governance actions.
- Open **New proposal** (`/proposals/new`) to create a no-action test proposal, add a proposer, or submit up to ten ordered contract calls. The form checks the connected wallet's onchain proposer permission for the exact calldata, reads the minimum veto window, and simulates before requesting a signature. Every action must succeed; native action values come from the DAO at execution. Metadata is an optional existing `ipfs://` or `https://` URI. Combined calldata is limited to 64 KiB to fit local receipt storage.
- Confirmed creation uses the mined `ProposalCreated` event ID, saves its receipt locally, and links to the proposal. A confirmation timeout keeps the transaction hash and offers a confirmation retry instead of another submission. A storage error preserves the success message and proposal link.

### Adding test proposers

The deployed manager wallet has `PROPOSER_PERMISSION`, but it does **not** hold DAO `ROOT_PERMISSION`. The DAO itself holds root permission. Being the deployer does not bypass this arrangement; these permissions were verified through RPC on 2026-11-04.

Connect an existing proposer, choose **New proposal → Add proposer**, enter the other wallet, and review the proposal. Its single action calls `DAO.grant(plugin, wallet, PROPOSER_PERMISSION_ID)` with zero native value. After the veto window (currently at least 120 seconds), open the proposal and execute it if eligible. The recipient can then connect and propose. This grants neither DAO root access nor a timelock scheduling role. Locking TRUST is separate and is needed for voting power; lock before creating the proposal whose snapshot the tester will vote on.

No deployment-to-head scans, indexer, external ABI lookup, metadata download, server-side cache, or pinning endpoint is used by the active application. The old `/api/ipfs` and `/api/pin` handlers have been removed. Unsupported plugin routes do not expose legacy functionality.

## Limits and remaining work

Local history is partial, browser-specific and origin-specific. A second browser or changed hosting origin starts empty. Clearing site data removes it. Keep transaction hashes for recovery. RPC verification establishes current inclusion, not irreversible finality.

Fixtures A–C refer to unpinned IPFS metadata; D has empty metadata. The interface deliberately shows unavailable descriptions and the onchain reference. RPC cannot reconstruct documents that were never published. Action bytes and current contract reads remain available.

This slice supports only the supplied testnet deployment. Mainnet/anvil selection, manager/Safe export, rich metadata preparation and publishing, broader ABI decoding, full timelock evidence presentation, public hosting and legacy dependency cleanup remain in the project backlog. The manager EOA here must not be represented as a Safe. Legacy builder code is retained for subsequent reuse but is not routed into this interface.

## Validation

```sh
pnpm --filter dao-ui type-check
pnpm --filter dao-ui lint
pnpm --filter dao-ui test
pnpm --filter dao-ui build
CHECK_GOVERNANCE_RPC=1 pnpm --filter dao-ui exec vitest run src/governance/__tests__/deployment.integration.test.ts
CHECK_GOVERNANCE_RPC=1 pnpm --filter dao-ui exec vitest run src/governance/__tests__/locking.test.ts
```

The live check only reads RPC; it does not sign or broadcast. Unit coverage includes recorded creation/veto/execution receipts, foreign emitters, Safe-wrapped log handling, malformed inputs, missing/noncanonical receipts, storage corruption/quota failure, bigint precision, threshold rounding, pinned confirmed reads versus pending eligibility, and nested action decoding.

Results on 2026-11-04: typecheck and lint passed; 253 unit tests passed across 33 files (the opt-in live test is skipped by default); the separate live test passed; production build passed and emitted only static page routes. Static security, logic and CI/history review found no HIGH issues. The identified receipt-save, pagination and replacement-handling issues were corrected; logic fixes were independently rechecked. Existing toolchain warnings about deprecated `next lint`, Browserslist age and workspace build-script configuration remain outside this slice.

Setup follow-up on the same date: 266 unit tests passed, with two live checks skipped by default. The separate locking live check passed against the configured contracts and funded manager account. Typecheck, lint and production build passed, including the static `/setup` route. Static transaction-flow review identified a receipt-retry cleanup issue; it was fixed and independently rechecked. Locking coverage includes exact decimal precision, weekly rounding, native balance reserve, wrap-shortfall/approval progression, exact calldata and spender, failed simulations, identity checks, and withdrawal guards.

Manual UI and wallet review remains user-owned: import fixtures, reload, open proposal C/D, compare the visible actions, and check wallet veto/execution with the intended test account. Browser QA and signed transactions were not performed during implementation.

For the new form, manually open `/setup`, connect a funded testnet wallet, enter a small amount and 30-day duration, then confirm wrap, approval and lock in sequence. Check the resulting lock and voting power, and use a newly created proposal to test that wallet's veto eligibility. A rejected wallet step should preserve the input and earlier confirmed steps.

Proposal creation follow-up: construction and preflight tests cover exact permission calldata, stale permissions/settings, invalid addresses and wildcard grants, duration/value precision, receipt-size bounds and pending-block simulation. Component tests cover unauthorized/wrong-chain wallets, account changes during preparation, signature rejection, confirmation retries, mismatched/reverted transactions, calldata casing and storage failure after success. A read-only `eth_call` of a no-action proposal succeeded from the manager account. No proposal was broadcast during verification. For manual review, create a test proposal, then follow the Add proposer flow above with a second wallet.
