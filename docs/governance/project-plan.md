# Governance project preparation

Prepared 2026-11-04 for the [veTRUST frontend/application project](https://linear.app/0xintuition/project/vetrust-onchain-governance-frontendapplication-1367e601c391/overview). Project UUID: `3a0c9e8f-85d0-44f4-a094-6cfa3836d245`.

## Implementation follow-up

The user subsequently supplied a new testnet deployment and authorized implementation. The first slice now connects the active UI to that deployment, imports receipt evidence into local storage, reads timestamp voting and proposal state, decodes supported timelock actions, and prepares simulated wallet veto/execution. See [testnet.md](testnet.md) for verified addresses, fixture IDs, setup, checks and remaining scope. The preparation history below records the earlier planning pass; it does not supersede this implementation record.

This advances ENG-17610 through ENG-17617 in part. It does not mark those tickets complete: additional networks, broader decoding and timelock history, signed wallet checks and cleanup remain. Proposal creation/Safe export is the next substantial feature slice. Work remains uncommitted on `development`.

## Working agreement

Implement on the current `development` branch in this checkout. The inspected baseline is `cbfe542`; the remote still points to `taikoxyz/dao-ui-mono`. Public 0xIntuition repository setup remains a launch deliverable in ENG-17608, rather than a prerequisite to starting local work. No push, repository publication, contract transaction, application deployment, or PR is part of this preparation pass.

The [RPC MVP specification](rpc-mvp.md) records the user's selected approach: user-supplied transaction hashes, RPC receipt validation/decoding, persistent local event history, and fresh contract state. No indexer, subgraph, app-hosted pinning, metadata proxy, or database is required. Local history is incomplete and browser-specific; missing content/provenance must be represented honestly.

## Project inventory and execution order

The project has 20 issues across six milestones. All were in Staging when read. Existing statuses, assignees, priority and milestone membership are preserved; specification updates do not mark implementation complete.

| Milestone | Issues | Implementation order and exit |
| --- | --- | --- |
| 1. Fork, decisions and testnet fixtures | [ENG-17608](https://linear.app/0xintuition/issue/ENG-17608), [17609](https://linear.app/0xintuition/issue/ENG-17609), [17610](https://linear.app/0xintuition/issue/ENG-17610) | Prepare this checkout, record RPC-only scope, verify existing deployment evidence and prepare replayable fixtures. Keep publication/hosting decisions separate from local progress. |
| 2. Testnet MVP: view, track and veto | [ENG-17611](https://linear.app/0xintuition/issue/ENG-17611)–[17615](https://linear.app/0xintuition/issue/ENG-17615) | Configure chains and remove unsupported modules first; then implement receipt imports/storage, correct veTRUST reads, and truthful lifecycle/history states. |
| 3. Decoded actions and timelock tracking | [ENG-17616](https://linear.app/0xintuition/issue/ENG-17616), [17617](https://linear.app/0xintuition/issue/ENG-17617) | Bundle the ABI registry before timelock/proxy decoding. Use contract reads for current operation state and imported receipts for available history. |
| 4. Safe proposal builder | [ENG-17618](https://linear.app/0xintuition/issue/ENG-17618), [17619](https://linear.app/0xintuition/issue/ENG-17619) | Confirm signers' export workflow; reuse the action decoder, accept externally prepared metadata, simulate/export, and import the eventual mined transaction. |
| 5. Public launch readiness | [ENG-17620](https://linear.app/0xintuition/issue/ENG-17620)–[17626](https://linear.app/0xintuition/issue/ENG-17626) | Branding, security, bounded RPC requests, wallet dependencies, licensing/docs, CI/hosting, then independent release review. |
| 6. Mainnet launch | [ENG-17627](https://linear.app/0xintuition/issue/ENG-17627) | Use verified deployment receipts, isolate mainnet storage, check actual authority/activation, and publish only after the release gate. |

For the first implementation slice, take ENG-17608's local cleanup, ENG-17611's explicit deployment config and ENG-17612's unsupported-module removal. Preserve reusable action-builder utilities. Then implement ENG-17613's pure receipt decoder/store against fixtures before wiring it into proposal screens. ENG-17614 corrects timestamp voting and threshold math; ENG-17615 integrates the resulting states. Hosting selection need not block pure data-layer work.

ENG-17613 is a prerequisite for ENG-17615's history states, ENG-17617's imported timelock evidence, and ENG-17619's confirmed-transaction ingestion. Retain the existing contract/deployment and release dependencies.

## Scope updates

| Existing issue | Change |
| --- | --- |
| ENG-17608 | Work in this checkout/branch; retain public repository setup as unfinished launch work. |
| ENG-17609 | Replace undecided indexing/pinning alternatives with the RPC-only agreement; retain open hosting/domain/operator metadata decisions. |
| ENG-17610 | Verify/reuse deployments and supply transaction hashes/receipt fixtures; do not assume prior “nothing deployed” text remains current. |
| ENG-17611 | Isolate chain/deployment clients, reads and storage; verify deployed identity; explorer API is not required. |
| ENG-17613 | Replace full historical scans with receipt import, validated durable storage, deduplication, recovery and partial-history semantics. |
| ENG-17615 | Handle missing local provenance/history/metadata without fabricated information or endless loading. |
| ENG-17616 | Bundled ABI registry is sufficient for MVP; external ABI/signature services are optional future enrichment. |
| ENG-17617 | Use current timelock reads and imported cancellation evidence; zero timestamp is not proof of cancellation. |
| ENG-17619 | Export metadata for external publishing, accept URI/CID, simulate/export Safe data, and import confirmed creation receipts. |
| ENG-17621 | Remove mandatory pin/cache endpoints and cover untrusted receipts/local storage in hardening. |
| ENG-17622 | Bound imports/live reads rather than scan windows; ended-but-unexecuted proposals can still require refresh. |
| ENG-17623 | Preserve durable imports during wallet/query-cache dependency cleanup. |
| ENG-17624 | Document local history limits, recovery and backend-free setup. |
| ENG-17625 | Build without subgraph/pinning/Blob services; retain imports across same-origin releases. |
| ENG-17626 | Review RPC/import correctness and partial coverage; browser QA remains opt-in. |
| ENG-17627 | Isolate mainnet imports and retain live authority checks; receipts alone do not establish activation. |

ENG-17612, ENG-17614, ENG-17618 and ENG-17620 retain their existing implementation scope. All six milestone descriptions are aligned with the minimal architecture. No new issues are needed for this change.

Applied and read back in Linear on 2026-11-04: the project description, all six milestone descriptions, the 16 issue updates above, and the three importer blocking relationships. Existing issue workflow fields were preserved. The snapshot, exact before/after edits and write verification manifest for this session are retained at `/tmp/vetrust-linear-context/`; that temporary audit directory is not a deployment dependency.

## Decisions and unresolved inputs

Locked by the user's direction: work on this branch; use RPC receipt imports and local storage; keep infrastructure minimal. The implementation details in the RPC spec make that direction testable without changing contract governance policy.

Still unresolved or requiring evidence:

- Mainnet/anvil deployment receipt manifests and fixture transactions. The user subsequently supplied a new testnet manifest, now verified and implemented as recorded in [testnet.md](testnet.md).
- Hosting/domain and the operator's external metadata preparation/publishing workflow in ENG-17609.
- Safe submission interface and accepted export format in ENG-17618.
- Final topology and proposal lifetime policy in [ENG-17577](https://linear.app/0xintuition/issue/ENG-17577). The contract repository's source configuration is not approval of the policy or proof of deployment.
- Mainnet deployment, handover and activation evidence in [ENG-17588](https://linear.app/0xintuition/issue/ENG-17588), [ENG-17589](https://linear.app/0xintuition/issue/ENG-17589), and [ENG-17590](https://linear.app/0xintuition/issue/ENG-17590).

The bounded cross-project read also covered [ENG-17583](https://linear.app/0xintuition/issue/ENG-17583) (Safe/CLI workflow) and [ENG-17585](https://linear.app/0xintuition/issue/ENG-17585) (monitoring). Their scope is preserved. Full operational monitoring remains separate from browser-local history.

## Validation for this preparation pass

Read the full Linear project, all milestones/issues, issue relationships/comments and bounded contract dependencies through Intuition Studio's existing Linear client. The project had no separate attached documents or project updates; specifications lived in the project and issue descriptions.

Reviewed repository configuration, proposal data hooks, GraphQL usage, receipt/log access, metadata services, persistence, and sibling adapter/deployment source. Inspected the package scripts and Vitest configuration: unit tests default to Node, with jsdom for component tests. Checked Markdown local links and whitespace. No application source was changed or test/build run in this documentation pass. No application browser QA or live contract verification was performed.
