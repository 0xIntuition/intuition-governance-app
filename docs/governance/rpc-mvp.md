# veTRUST governance: RPC-first MVP

## Direction

Adapt this application to the deployed Intuition governance route, with minimal infrastructure. Proposal discovery is based on transaction hashes supplied by users. Fetch their receipts through the configured chain's RPC, decode relevant events, and persist those events in local storage. No indexer, subgraph, database, or application backend is required for governance discovery or current-state reads.

Source: the user's direction on 2026-11-04 and the [frontend project](https://linear.app/0xintuition/project/vetrust-onchain-governance-frontendapplication-1367e601c391/overview), including all 20 issues and six milestones read through Intuition Studio. Implementation stays on the existing `development` branch. This document specifies the overall intended behavior. The [testnet implementation record](testnet.md) distinguishes what is now implemented and verified from remaining scope; see also [the issue map and implementation order](project-plan.md).

## Boundaries

- Use the deployed optimistic plugin and veTRUST voting adapter. Keep existing contract permissions authoritative.
- Mainnet proposal creation belongs to the manager Safe; the application builds/simulates/exports its transaction. The authorized testnet proposer can submit directly. Veto and eligible execution remain holder/public interactions as specified by the contracts.
- Import known transactions; do not build global discovery, a background indexer, or an unbounded historical RPC scanner.
- Local history is specific to this browser and deployment. Missing imported events do not mean nothing happened on chain.
- Current proposal state, voting power, permissions, veto eligibility, and execution eligibility come from fresh contract reads. Stored events do not authorize transactions.
- Reuse viem/wagmi and the existing application where practical. Keep the receipt decoder, local store, and contract reads small and explicit.

## Receipt import

1. The user selects a configured deployment and supplies a transaction hash. The minimal input is a 32-byte hash; accepting explorer URLs is optional.
2. Fetch the receipt using that deployment's public RPC client, with the configured chain ID verified. Pending, missing, reverted, or unavailable receipts produce a recoverable error and no successful import.
3. Match log emitters against the configured governance contracts and decode with the corresponding pinned ABI. A matching event signature from a foreign contract is insufficient. The outer transaction recipient may be a Safe; validate the emitting contract, not just `transaction.to`.
4. Retain all relevant logs in the receipt, including multiple proposals or lifecycle events. Extract proposal IDs from decoded events rather than array position or transaction order. A transaction with no relevant logs is not a successful import.
5. Store receipt provenance and normalized events. Reimporting is idempotent. Refresh the affected proposal's current state through RPC.
6. After an in-app transaction confirms, pass its receipt through the same importer. Externally submitted transactions use manual import.

An execution or veto receipt may arrive before the creation receipt. Preserve the known event and show incomplete history; do not invent a creator, title, creation timestamp, or relationship. Current contract state may still be readable.

## Persistent data

Use a versioned local-storage namespace containing chain ID, DAO address, and plugin address. Separate this durable import store from the existing React Query persistence, whose build buster clears data on new builds.

Minimum stored information:

- Schema version and deployment identity.
- Transaction hash, block number, block hash, transaction index, and relevant log indices.
- Emitter, event name, decoded arguments, and raw topics/data sufficient to re-decode after an ABI migration.
- Import timestamp and last successful verification information.

Use `(chainId, transactionHash, logIndex)` as the event identity within the deployment namespace; retain the block hash to detect reorganization. Serialize bigint values losslessly as strings. Sort by block number, transaction index, and log index.

Validate persisted JSON on read. Unsupported versions, malformed entries, quota errors, and unavailable storage must not crash the app or report a durable save that failed. Preserve valid existing entries when a new import fails. Support removing local entries and clearing the selected deployment's local history; neither operation changes chain state. Handle multiple tabs without silently losing existing imports.

Cached receipts are reproducible from transaction hashes, not a trusted database. On refresh, recheck receipt inclusion/block identity; exclude orphaned evidence and update replaced receipts. Mark uncertain history when RPC verification fails. Choose confirmation handling per deployment rather than claiming immediate finality. Never persist wallet secrets or private signing material.

## Current state and history

Lists show imported proposals with local pagination/filtering and an explicit local-history explanation. An empty local store offers transaction import; it must not claim the DAO has no proposals. Existing bounded `proposalCount` / `proposalIds` / `getProposal` reads may remain useful for known state, without requiring automatic discovery or implying complete event history. A direct proposal link may read known onchain state, but must explain when receipt history is missing in this browser.

Details combine imported evidence with `getProposal` and deployment-supported reads. The imported creator is the event creator, not automatically the outer transaction sender. Veto totals and executed status come from the contract; imported voter/executor history can be incomplete. Never infer full voter participation from the imported subset.

Before veto or execute, refresh chain-specific eligibility and simulate the intended call. On confirmation, import the receipt and invalidate affected reads. On RPC failure, show unavailable/stale state rather than enabling an action from cached eligibility. Wallet chain and deployment identity must agree.

## Metadata boundary

An event may contain only a metadata URI or hash. RPC cannot recover content that was never placed on chain. The upstream application depended on `/api/ipfs`, server-side content verification/Blob mirroring, and `/api/pin` with a server-only Pinata credential. The initial testnet slice removes these endpoints and dependencies from the active application path.

The baseline RPC-only interface must remain usable with proposal ID, verified actions, current contract state, and explicit unavailable metadata. It must not quietly require those server services. Before retaining rich proposal descriptions or creation uploads, resolve the metadata format against the deployed ABI and project scope:

- Decode bounded, validated inline content when it is actually present on chain.
- If externally supplied documents are supported, verify them against an onchain content commitment when available; otherwise identify them as unverified annotations.
- Public IPFS/HTTP retrieval or external publishing is an additional dependency, not “entirely RPC.” Keep it explicitly optional unless the product scope is amended.

The minimal builder exports a metadata JSON file and accepts an externally prepared URI/CID; external publishing remains an operator workflow to confirm in ENG-17609. Preserve the existing URI encoding until an explicit contract-compatible format decision changes it. Do not introduce public upload credentials, a pinning service, or a new metadata encoding as an implicit part of this migration. Metadata text cannot override action bytes or execution targets.

## Timelocks and monitoring

If the final topology retains the upgrade timelock, decode its operation and read its current status over RPC. Import scheduling/cancellation receipts through the same importer. A zero timestamp means the operation is not currently scheduled; it does not distinguish never-scheduled from cancelled. Imported cancellation is historical evidence, and current state after rescheduling takes precedence.

ENG-17577 still owns the topology and proposal lifetime policy. This frontend change does not settle it. Operational monitoring in ENG-17585 also remains independent: browser-local events do not replace complete monitoring, backfill or alerts, and the UI does not depend on that monitoring index.

## Deployment readiness

Record the chain ID, public RPC, explorer, DAO, optimistic plugin, voting adapter/history source, proposer Safe, deployment block, ABI provenance, and sample lifecycle transactions for each supported deployment. Target Intuition mainnet (1155), testnet (13579), and local anvil (31337), as specified in ENG-17611. Verify and reuse existing deployments first; only missing fixtures/deployments require later deployment work. Confirm contract code and read compatibility before enabling writes. Production addresses must come from deployment evidence, not the Taiko examples in `DEPLOYMENTS.md`.

The sibling governance source uses timestamp-based veTRUST history and rejects delegation. Source defaults do not establish live settings. The newly supplied testnet deployment has been verified with a 120-second minimum duration, 20% veto ratio, `skipL2`, and a separate 120-second upgrades timelock. See [deployment provenance](testnet.md). Read actual settings and proposal snapshots rather than reusing Taiko timing defaults.

## Code map

| Area | Existing code | Migration implication |
| --- | --- | --- |
| Configuration | `packages/ui/src/constants.ts`, `utils/chains.ts`, `context/Web3Modal.tsx` | Replace Taiko identities and network assumptions with verified Intuition deployments. |
| Plugin registration | `packages/ui/src/plugins/index.ts` | Expose only governance capabilities deployed for this project. |
| Lists | Optimistic proposal list, `hooks/useProposalId.tsx`, dashboard latest proposals | Existing count/ID reads do not provide imported event history; use local known proposals for MVP discovery. |
| Creation evidence | Optimistic `hooks/useProposal.tsx`, `utils/evm.ts` | Replace deployment-to-head log scans with receipt evidence. |
| Indexed enrichment | `utils/gql/`, proposal pages and headers | Replace creator/history/related-proposal assumptions with explicit imported evidence and missing-data states. |
| Voting | Optimistic voting-power, veto, execute, and settings hooks | Reuse compatible contract calls; remove unsupported token, delegation, and L2 assumptions. |
| Persistence | `packages/ui/src/context/index.tsx` | Keep durable imports independent of the build-invalidated query cache. |
| Metadata | `utils/ipfs.ts`, `hooks/useMetadata.ts`, `pages/api/` | Remove mandatory proxy/pinning dependencies from the MVP path. |

## Acceptance checks

Use focused non-browser tests with recorded/synthetic receipts and mocked RPC responses. Cover valid creation/veto/execution, multiple matching logs, Safe-wrapped calls, foreign emitters, malformed hashes/logs, failed/pending/missing receipts, duplicate and out-of-order imports, same proposal IDs across deployments, bigint round trips, storage corruption/quota failure, reload and build-version survival, missing metadata, reorg detection, and stale eligibility. Inspect test scripts before running them.

The MVP must work with no subgraph URL, Pinata credential, or Blob/backend configuration. Network failures must remain recoverable. A later manual check should import a known proposal, reload, compare the visible actions/state with chain evidence, and confirm that another browser starts with empty local history. Browser QA is user-owned unless explicitly requested.
