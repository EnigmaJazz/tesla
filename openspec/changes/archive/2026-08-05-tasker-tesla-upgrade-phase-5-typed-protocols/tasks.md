# Tasks: Phase 5 — Typed Protocols

## Slice Mapping

| Slice | Scope | PR |
|---|---|---|
| A | Typed queue, cutover | PR-A → main |
| B | Cache Manager, schemas, ownership | PR-B → main |
| C | Request correlation and rejection | PR-C → main |
| D | Cache readers, parity, TTL | PR-D → main |

## Review Workload Forecast

| Slice | Estimate (code, tests, ledgers) | Risk |
|---|---:|---|
| A | ~390–430 lines | **High; harness revisions may exceed 400** |
| B | ~360–420 lines | **High; new manager may exceed 400** |
| C | ~190–260 lines | Low |
| D | ~260–340 lines | Medium; parity risk |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Under `ask-on-risk`, stop above 400 lines and ask to split or accept `size:exception`; A is harness-risk, B new-code risk, D parity-risk. Tests and ledgers count.

## Slice A — PR-A

- [x] **A1 RED — Queue contract.** Add `harness/test_typed_queue.js`; extend queue/compiler harnesses for valid/malformed envelopes, shadow divergence, positive fallback, and retired steps (REQ-5QUEUE-1, REQ-5CUTOVER-1; SCN-5QUEUE-1..2, SCN-5CUTOVER-1..3); fail on master.
- [x] **A2 GREEN — Queue/cutover.** Modify `Sandbox_Engine.js`, `Compiler.js`, and 11 enqueue call sites for one JSON envelope, shadow fields, typed authority, and removal of `block_step17`–`21`; done when A1 passes with zero-duration rejection and LOG-17.
- [x] **A3 VERIFY —** Run focused A harnesses, full `for t in harness/test_*.js; do node "$t" || exit 1; done`, and `node --check`; done when 24/24 plus new assertions pass.

## Slice B — PR-B

- [x] **B1 RED — Cache ownership/schema.** Add `harness/test_route_cache_manager.js`; extend `harness/mock_tasker.js` for owner rejection, Welford/TTL, exact DRIVE/WALK buckets, and malformed/expired misses (REQ-5CACHE-1/2; SCN-5CACHE-1..3); fail on A.
- [x] **B2 GREEN — Manager migration.** Create `Route_Cache_Manager.js`; modify `Alpha.js`, `API_Parser.js`, and fixtures for `%par1/%par2`, JSON schemas, rollback, four-file ownership, and staged Welford/order writes; done when B1 passes.
- [x] **B3 VERIFY —** Run manager test, full suite, and `node --check`; require 24/24, no Temp multi-writer, and no nonpositive cache result.

## Slice C — PR-C

- [x] **C1 RED — Correlation rejection.** Add `harness/test_request_correlation.js`; assert callback retention, wire-payload exclusion, exact ID acceptance, and stale no-op (REQ-5REQID-1/2; SCN-5REQID-1..3); fail on B.
- [x] **C2 GREEN — Correlate requests.** Modify `API_JSON_Build.js`, `API_Parser.js`, and `Route_Cache_Manager.js` for registration, callback staging, exact checks, pruning, and `STALE_API_RESPONSE_DISCARDED` LOG-17; done when C1 passes.
- [x] **C3 VERIFY —** Run correlation test, full suite, and `node --check`; require accepted owner-only mutations and stale no-op.

## Slice D — PR-D

- [x] **D1 RED — Reader parity/TTL.** Extend `test_route_cache_manager.js` with byte-identical Gatekeeper/Sandbox spatial/bucket selection, WALK `null`, and expiry fixtures; fail on C.
- [x] **D2 GREEN — Reader migration.** Modify `Gatekeeper.js`, `Sandbox_Engine.js`, `Route_Cache_Manager.js`, and fixtures for read-only JSON, adjacent-cell parity, pruning, and text retirement; done when D1 passes.
- [x] **D3 VERIFY —** Run parity/TTL tests, all harnesses, and `node --check`; require identical choices and clean ownership audit.

## Test Plan

New: `harness/test_typed_queue.js`, `harness/test_route_cache_manager.js`, `harness/test_request_correlation.js`. Extended: `test_ac3_sandbox.js`, `test_dst_utc.js`, `test_sandbox_ac6.js`, `test_compiler_ac1.js`, `test_atomic_publication.js`, `test_id_parsing.js`, `test_ac5.js`, `test_sandbox_ovr10.js`, `harness/mock_tasker.js`. Threat matrix: N/A.
