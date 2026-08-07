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

## Remediation (Run-2 FAIL — direct-reader rejection contract)

Run-2 verify (whole-change FAIL, re-opened by `dff4f08`) found the direct JSON readers
(`Gatekeeper.js:51-68 readCacheJson`, `Sandbox_Engine.js` reader) accept entries the manager's
`rcmFilterRouteEntries` (Route_Cache_Manager.js:235-258) rejects: nonpositive
`meanDurationSecs` (zero/negative → `cache_hit=true, durationSecs=0`), missing `expiresAt`,
key/bucket mismatch, WALK-with-numeric-bucket; and neither reader emits `CACHE_ENTRY_REJECTED`
LOG-17 on rejection. Scope: REQ-5CACHE-2 SCN-5CACHE-3 + REQ-5LOG-1 SCN-5LOG-1 at the reader.

- [x] **R1 RED — Adversarial reader regression.** Extend `harness/test_cache_readers.js` (or add
  `harness/test_reader_rejection.js`) with direct-reader fixtures for zero-duration,
  negative-duration, missing-`expiresAt`, key/bucket-mismatch, and WALK-numeric-bucket entries;
  assert reader-side miss (no `cache_hit`, no zero-duration leg) AND reader-side
  `CACHE_ENTRY_REJECTED` LOG-17 emission (prove it comes from the reader, not a prior manager
  `CACHE_READ` log); fail on current master.
- [x] **R2 GREEN — Reader validation + LOG-17.** Modify `Gatekeeper.js readCacheJson` and the
  `Sandbox_Engine.js` reader to replicate the manager's rejection filter inline (no
  require/import — Tasker standalone isolation; duplicated helper is the repo convention):
  `meanDurationSecs > 0`, `typeof expiresAt === "number"`, key/bucket integrity, WALK null-bucket,
  field-type checks, and emit `CACHE_ENTRY_REJECTED` LOG-17 on every dropped/rejected entry;
  done when R1 passes with reader-origin logs.
- [x] **R3 VERIFY —** Run full harness suite (`for t in harness/test_*.js; do node "$t" || exit 1; done`,
  `node --check` on all `*.js`, and the adversarial probe pattern; require reader/manager parity on
  every invalid class and LOG-17 from the reader itself. 28/28 baseline must stay green.
  **Verified (R3 run)**: full suite 28/28 (hash `sha256:ddd91e380fb0774286101762af46264615da9259c154ac88910bf57ad33bfcb6`,
  zero regression), syntax 54/54 (`sha256:e3b0c442…`), single-writer audit 0 matches, focused harness PASS
  (`sha256:47270f16…`), adversarial probe 11/11 (GK-1..GK-8, SB-1..SB-3) with reader-origin
  `CACHE_ENTRY_REJECTED` LOG-17. Whole-change verdict PASS: 7/7 requirements, 12/12 scenarios. See
  `verify-report.md` R3 section (evidence revision `sha256:bc8fcf41bca72793838be7ba13ae9b00a3c1c8c18b5a9f74785fdbdbac89069e`).

## Test Plan

New: `harness/test_typed_queue.js`, `harness/test_route_cache_manager.js`, `harness/test_request_correlation.js`. Extended: `test_ac3_sandbox.js`, `test_dst_utc.js`, `test_sandbox_ac6.js`, `test_compiler_ac1.js`, `test_atomic_publication.js`, `test_id_parsing.js`, `test_ac5.js`, `test_sandbox_ovr10.js`, `harness/mock_tasker.js`. Threat matrix: N/A.
