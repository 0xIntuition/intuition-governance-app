# Optional governance indexer

The user supplied `intuition-governance-indexer` on 2026-11-04 and selected automatic discovery as a progressive enhancement to the [RPC MVP](rpc-mvp.md). The existing receipt importer remains independent. No indexer response authorizes a wallet transaction.

## Coverage assessment

The indexer uses Ponder 0.18.4 and the same current testnet manifest as this application. Its event backfill starts at core block 9,375,954 and governance block 9,375,982. Review covered `ponder.config.ts`, `ponder.schema.ts`, handlers, REST routes, the typed client, deployment checks and tests.

| Need | Available | Frontend use |
| --- | --- | --- |
| Proposal discovery | `/v1/proposals`, decimal IDs and creation provenance | Automatically merge indexed IDs with locally imported IDs; deduplicate and read current state over RPC. |
| Creation, veto and execution history | Proposal-filtered `/v1/events`; separate veto endpoint also available | Paginated proposal activity; imported receipt evidence remains separately identified. |
| Timelock schedule, cancellation, execution and rescheduling | Operation projections and operation-filtered events | Correlate operation history using the operation hash decoded from RPC action bytes and the timelock address. Current readiness stays on RPC. |
| Governance/configuration monitoring | Plugin settings, DAO execution/permissions, timelock roles/delays, TrustBonding deposits/withdrawals/rewards/configuration, core upgrades, TrustBonding ProxyAdmin ownership | Recent governance/contract activity with emitter, block, time, transaction and decoded event details. |
| Deployment identity and sync status | `/v1/deployment`, `/ready`, `/status` | Reject incompatible identities; show syncing, connected, behind-head or unavailable status. |
| Current voting power, threshold, veto/execute eligibility | Intentionally not derived by the indexer | Existing fresh RPC reads and pending-block simulations remain authoritative. |

This is sufficient for the current discovery and history interface. It does not provide unpublished metadata, Safe signatures, every core protocol event, notifications, or all core ProxyAdmin ownership changes. Empty timelock batches can emit no schedule/execution logs; a missing event is not proof of nonexistence. Supply and lock events cannot substitute for decaying veTRUST reads. The service's README documents these boundaries.

## Local service

The indexer was started at `http://127.0.0.1:42069`, bound to loopback, using embedded PGlite and a separate `governance_ui_20261104` schema. It is continuously following the chain, with no end block. The ignored `.env.local` now has testnet, public-RPC and PGlite defaults; existing unrelated settings were preserved. No indexer source files changed.

To restart after stopping the running instance, from the indexer checkout:

```sh
bun run check:deployment
PONDER_NETWORK=testnet PONDER_DATABASE=pglite \
  PONDER_RPC_URL=https://testnet.rpc.intuition.systems/http \
  bun --bun ponder start --schema governance_ui_20261104 --port 42069 --hostname 127.0.0.1
```

Run one writer for this schema and one listener on this port. PGlite is for local use; the service already documents PostgreSQL deployment for production.

In this UI checkout:

```sh
pnpm --filter dao-ui dev
```

Development defaults to the local URL above. `NEXT_PUBLIC_GOVERNANCE_INDEXER_URL` overrides it. Set it to an empty string to disable automatic discovery. Production builds have no default indexer URL: configure an accessible HTTPS endpoint at build time to enable it. A hosted application must not use a visitor's localhost. No API credential or local sibling package dependency is shipped to the browser.

## Runtime behavior and fallback

- Probe deployment/readiness/status every 15 seconds while the page is active. Compare indexed block height with RPC head, not wall-clock age: this testnet can remain idle without new blocks. If RPC head is unavailable, report unknown freshness.
- Poll discovery and visible activity queries every 30 seconds. A changed indexed block invalidates relevant current RPC reads and indexed history. The selected indexer URL, chain and plugin are part of query identity.
- Request 25 records per API page. Explicit load-more controls allow up to ten pages per view. Six proposals at a time get current RPC state reads. The bounds are disclosed when reached.
- Validate response shape, deployment identity, row identity, event scope, integer precision and cursor order. Requests omit credentials, have an eight-second timeout per HTTP request, and cap response bodies at 2 MiB. Nothing fetches metadata URLs or executes event content.
- Network/HTTP/schema errors leave local receipt loading and wallet flows independent. Previously loaded indexed data stays visible with unavailable/error notices; successful refresh replaces it, including removed/reorganized records. Refreshing a paginated query starts from its first page and follows fresh cursors.
- Indexed rows live in the session query cache, **not** durable local storage. After a reload with the indexer unavailable, only previously imported receipts can discover proposals. Manual import and direct proposal-ID links remain available. Copy a transaction hash from an event's details and import it to retain independently RPC-verified evidence in this browser.
- The importer still checks canonical receipt inclusion and configured emitters. Indexed history is labeled as indexer-reported evidence. Proposal status, actions, snapshot power and all transaction preconditions continue to use RPC, even when indexer projections disagree.

The client uses the public REST contract directly with runtime validation. This keeps production builds independent of sibling repositories and avoids adding Ponder/server dependencies to the frontend. The service's typed client remains suitable for other consumers.

## Checks performed

Indexer checks passed: typecheck, all 13 offline tests, and deployment preflight. The running service reached block **9,376,020**, matching the RPC head at verification. Its explicit smoke test verified **84 events**, all four fixture proposals, veto totals, exact actions and timelock states against RPC at that block, plus REST pagination, GraphQL consistency, CORS and invalid-request handling.

Frontend checks passed: 276 unit tests (three live checks skipped by default), typecheck, and production build. The build works with automatic discovery disabled. A separate opt-in live test passed through the actual frontend HTTP client, discovering fixture proposals, creation/veto/execution events, operation-specific schedule/cancellation history and TrustBonding deposits:

```sh
CHECK_GOVERNANCE_INDEXER_URL=http://127.0.0.1:42069 \
  pnpm --filter dao-ui exec vitest run src/governance/__tests__/indexer.test.ts
```

Focused tests cover wrong deployment/chain, malformed or oversized responses, decimal precision, cursor boundaries, timeout with caller cancellation, initial syncing, scoped events, offline preservation and recovery that removes old indexed records. Browser QA, signed transactions and deep-reorg simulation were not performed.

Manual check: open the proposal page with an empty local history while the indexer is running; proposals should appear without a pasted hash. Open proposal and timelock activity, then stop the local indexer and use the manual importer. Restart it and confirm automatic discovery recovers. A reload during the outage should show only local imports, with an explanation of unavailable discovery.
