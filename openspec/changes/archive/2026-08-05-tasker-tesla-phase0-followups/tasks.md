# Tasks: Tasker Tesla Phase 0 Follow-ups

## Slice Mapping

| Slice | Scope | PR |
|---|---|---|
| A | AC-3, AC-7, 0B: overnight boundaries, planning days, queue survival | PR1/A |
| B | AC-5, 0E, INV-0.4: completion isolation and suppression | PR2/B |
| C | INV-0.7: nonzero route-duration fallback | PR3/C+D |
| D | OVR-10: exact-key reads and parsing regression coverage | PR3/C+D |

## Review Workload Forecast

PR1/A: ~380–460 lines; **High** risk. PR2/B: ~260–340 lines; Low–Medium risk. PR3/C+D: ~380–480 lines; **High** risk due to Sandbox and Compiler coverage.

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

## Slice A — PR1/A

- [x] **A1 RED — Add boundary regressions.** Create `harness/test_ac3_sandbox.js`; extend `harness/test_sandbox_ac6.js`, `test_dst_utc.js`, and `test_departure_day.js` for same-location overnight, DST-local `planningDay`, live-base precedence, preserved tomorrow queue rows, and required boundary logs. Done when assertions fail against current behavior. Files: four harness files. **DONE** — commit 0215eb9 (RED 392 lines).
- [x] **A2 GREEN — Implement day-boundary planning.** Modify `Sandbox_Engine.js` EOD/flush regions (L787–818, L1334–1361, queue setup L532–557) to remove `_IN` inference, compute timezone-derived `planningDay`, stop `skipIdx` and chain propagation at local day boundaries, emit structured overnight/cross-day events, and append queue columns 20–21. Update `Compiler.js` row consumption without changing columns 17–19. Files: `Sandbox_Engine.js`, `Compiler.js`. **DONE** — commit 6affa07 (GREEN 92 insertions).
- [x] **A3 GREEN — Verify Slice A.** Run the four focused harnesses, then the full suite; require tomorrow rows unchanged, base/JIT head leg, DST-safe boundaries, AC-6 precedence, and LOG-17 fields. Files: listed harness files. **DONE** — focused AC-3/AC-6/DST/departure-day pass; full harness **18/18 green**; PR #25 open.

Apply-progress (Slice A): attempt 1 recorded **passed** in the SDD runtime ledger (504 changed lines, budget-exceeded flag; maintainer approved reset 2026-08-02, ledger `next_action: begin`). GGA review on the GREEN commit reported only pre-existing OVR/PREFS flat-string findings (absorbed by the schema-v2 Override Handler); committed with `--no-verify` per the out-of-scope convention.

## Slice B — PR2/B

- [x] **B1 RED — Add lifecycle regressions.** Create `harness/test_ac5.js` covering reducer completion, idempotence, exact-trip mutation, tomorrow PLANNED/JIT preservation, future-day dispatcher rejection, synthetic-return suppression, and action-lock cleanup without session writes. Done when it fails. Files: new test plus `harness/test_reducer_commands.js`. **DONE** — commit c1c5aa2 (RED, 8 failing sections on master).
- [x] **B2 GREEN — Implement completion and selection.** Implement `COMPLETE_TRIP` in `Trip_State_Reducer.js` (L208/`reduce`), accepting `{generationId,tripId,at,planningDay}` and changing only matched IN_PROGRESS/ARRIVED trips. Update `Sandbox_Engine.js` completion observer and suppression guard; update `Dispatcher.js` to reject future planning days and log `EVT-FUTURE_TRIP_NOT_DUE`. Files: three scripts. **DONE** — commit 333f668 + verify-fix dfc43f1 (completion scoped to today; future-day check uses `tripDay > todayDay`).
- [x] **B3 GREEN — Close existing lock path.** Update `Finaliser.js` and `Unlock.js` to clear `TDS_Action_Lock.json` only after successful reducer completion, reusing existing ownership paths. Run focused and full harnesses. Files: two scripts and B harnesses. **DONE** — commit 333f668 (folded by staging); focused AC-5 **11/11**, full harness **19/19 green**; PR #26 open. SDD verify **PASS (run 2)** — 0 CRITICAL; findings 1/3/5 triaged and fixed, 2/4/6 rejected as out-of-scope/over-aggressive.

## Slice C — PR3/C+D

- [x] **C1 RED — Extend fallback tests.** Extend `harness/test_compiler_ac1.js` for API → positive Sandbox metrics → ACTIVE_TRAVEL local estimate → rejection, zero-duration rejection, columns 17–19, and fallback log details. Files: test file. **DONE** — commit 1bce7cc (RED, 3 failing sections on master: Sandbox-metrics tier not consumed, no fallback flash, Sandbox columns 17/18 empty).
- [x] **C2 GREEN — Implement fallback tiers.** Modify `Sandbox_Engine.js` enqueue/route metric regions to export positive `block_step17/18`; modify `Compiler.js` to consume them before local estimation and reject/log otherwise. Files: two scripts. **DONE** — commit 46f22fa (GREEN; also named RELEVANCE_WINDOW_SECS/METERS_TO_MILES, fixed Compiler substring read + Depart_Memory leak + drop-in stop double-count found by review).
- [x] **D1 RED/GREEN — Prove exact identity reads.** Create `harness/test_sandbox_ovr10.js` with `ev_1`/`ev_10`, schema-v2 own-property override/preference maps, and underscore-core `team_event_alpha_kx8f00`; assert no OVR/PREFS writes and valid final-underscore parsing. Update only read paths in `Sandbox_Engine.js`; run focused/full suites. Files: new test and `Sandbox_Engine.js`. **DONE** — RED commit a24774c, GREEN commit 8fc59b7 (getOvrEntry/hasExactOverride/getLatenessMode/hasExactPref + exact-token CSV fallback; no OVR/PREFS writes).

## Test Plan

New: `test_ac3_sandbox.js`, `test_ac5.js`, `test_sandbox_ovr10.js`. Extended: AC-6, DST, departure-day, reducer, and Compiler AC-1 harnesses. Threat-matrix rows are all N/A; no additional threat RED tests apply.
