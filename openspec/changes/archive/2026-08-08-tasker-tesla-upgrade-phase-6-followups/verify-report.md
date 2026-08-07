---
change: tasker-tesla-upgrade-phase-6-followups
mode: openspec
artifact_store: openspec
delivery_strategy: auto-chain
strict_tdd: false
verdict: PASS WITH WARNINGS
requirements_count: 7   # 5 ADDED (REQ-6FU-1..5) + 2 MODIFIED (REQ-4CMD-1, REQ-6STATE-4)
scenarios_count: 12      # 10 added FU scenarios (SCN-6FU-1A,2,4,5,6,7,8,9,10,11) + SCN-4CMD-3 (added) + SCN-6STATE-8 (added)
harness_count: 30
harness_passed: 30
harness_exit_code: 0
test_command: "for f in harness/test_*.js; do node $f; done"
build_command: ""
coverage_threshold: 0
verified_at: 2026-08-08
native_review: review-cb2af7e1a5d97629 (post-apply gate approved)
---

# Verification Report — Phase 6 Follow-ups (Batch Staging & Non-Base-Origin Departure)

## 1. Change & Mode

| Field | Value |
| --- | --- |
| Change | `tasker-tesla-upgrade-phase-6-followups` |
| Artifact store | openspec |
| Delivery strategy | auto-chain (stacked-to-main) |
| Strict TDD | false (`openspec/config.yaml`: `strict_tdd: false`) — standard verify; mandated RED-first sequence for the two new RED→GREEN tests is evidenced in `apply-progress.md`. |
| Slices | PR 1 (FU1 core, PRs 39/40/41) + PR 3 (FU2 tail, PR 42) merged; PR 2 (Finaliser) D5-deferred by user decision. |
| Verification mode | Full artifacts — proposal/spec/design/tasks all present; all dimensions verified. |

## 2. Completeness Table

| Dimension | Status | Evidence |
| --- | --- | --- |
| Proposal / exploration | Present | `exploration.md` documents the batch-staging production gap and the FU2 trigger. |
| Specs | Present | `specs/itinerary/spec.md` — REQ-6FU-1..5 (ADDED), REQ-4CMD-1 + REQ-6STATE-4 (MODIFIED). |
| Design | Present | `design.md` — D1..D6 decisions, data flow, file-change table, testing strategy. |
| Tasks | Present | `tasks.md` — all boxes `[x]`; PR 2 tasks 2.1–2.3 marked `SUPERSEDED by D5 (b)` (legitimate recorded deferral, not an unchecked gap — see §6 Findings F1). |
| Apply progress | Present | `apply-progress.md` (PR 1 + PR 3 sections) — RED→GREEN evidence, commit table, deviations. |
| Implementation | Inspected | `Sandbox_Engine.js`, `TDS_State_Command.js`, `Trip_State_Reducer.js`, `Depart_Now.js`, `Return_to_Base.js`, `harness/*.js` (Finaliser.js confirmed NOT modified — `grep REDUCER_BATCH Finaliser.js` → 0 matches, validating D5 deferral). |
| Runtime tests | Executed | `for f in harness/test_*.js; do node $f; done` → **30/30 PASS, exit 0**. |

## 3. Build / Test / Coverage Evidence

| Command | Result |
| --- | --- |
| `for f in harness/test_*.js; do node $f; done` | **exit 0** — all 30 harness scripts PASS (output shows per-script `PASS:` and `ok:` markers, including `serial-batch`, `manual-session`, `state-command`, `fu2-departure-edge`, `reducer-commands`, `trip-lifecycle`, `single-writer` regression suites). |
| Build / type-check | Not applicable — Tasker JSlet environment, no Node build, no linter, no type checker (`openspec/config.yaml`: none available, manual device gate). |
| Coverage | Not available (coverage_threshold: 0). |

Suite count confirmed by `glob harness/test_*.js` = **30 files** (matches `apply-progress.md` PR 3 "30/30 PASS"). New test files delivered by this change: `harness/test_serial_batch.js` (FU1 serial-faithful RED→GREEN) and `harness/test_fu2_departure_edge.js` (FU2 non-base departure edge + guard).

## 4. Spec Compliance Matrix (Requirements → Scenarios → Runtime evidence)

| Requirement | Scenario | EVT code | Covering test (runtime PASS) | Implementation evidence | Verdict |
| --- | --- | --- | --- | --- | --- |
| **REQ-6FU-1** Batch envelope delivery | SCN-6FU-1A (production-loss RED baseline) | — | `test_serial_batch.js` RED→GREEN record (`apply-progress.md` PR 1 RED step: 3/3 sections FAIL pre-fix, last-wins `OBSERVE_LATENESS_HALT` only; GREEN PASS post-fix) | `Sandbox_Engine.js:436-444` `stagedReducerCommands.push`; `:1827-1833` flush one `REDUCER_BATCH`; `mock_tasker.js` `serialMode` (no shim). | **PASS** (RED baseline proven in apply-progress RED→GREEN evidence) |
| REQ-6FU-1 | SCN-6FU-2 (batch delivery) | `REDUCER_BATCH_DELIVERED` | `test_serial_batch.js` PASS — asserts `REDUCER_BATCH_DELIVERED` with `count:4`, all observations land in order; `test_state_command.js` line 256 | `Trip_State_Reducer.js:680` logs `REDUCER_BATCH_DELIVERED {count,applied,skipped}`; `applyBatch` :373-394 | **PASS** |
| **REQ-6FU-2** Partial-failure | SCN-6FU-4 (skip+log invalid, neighbours apply) | `BATCH_SUBCOMMAND_REJECTED` | `test_state_command.js` line 281-284 PASS — one `BATCH_SUBCOMMAND_REJECTED` logged, valid neighbours apply | `Trip_State_Reducer.js:383` logs `BATCH_SUBCOMMAND_REJECTED {command,reason,index,generationId}` + `continue`; `:389-391` valid still apply | **PASS** |
| REQ-6FU-2 | SCN-6FU-5 (all-valid batch) | — | `test_state_command.js` + `test_serial_batch.js` PASS — every sub-command commits-and-projects | `applyBatch` applies every valid `sub.apply(running)`; single commit+project in `reduce()` after loop (D4) | **PASS** |
| **REQ-6FU-3** Nested validation parity | SCN-6FU-6 (malformed envelope rejected, no mutation) | `BATCH_ENVELOPE_REJECTED` | `test_state_command.js` line 219-220 PASS — 8 reject cases (missing/non-array `commands`, non-object entry, nested `REDUCER_BATCH`, oversized 33 entries) each log `BATCH_ENVELOPE_REJECTED` with no file write | `TDS_State_Command.js:163-179` envelope-shape contract + `:174` size guard; `:422` logs `BATCH_ENVELOPE_REJECTED`; reducer mirror `Trip_State_Reducer.js:331-348` | **PASS** |
| REQ-6FU-3 | SCN-6FU-7 (nested field parity) | `BATCH_SUBCOMMAND_REJECTED` | `test_state_command.js` line 293-304 PASS — sub-command failing `REDUCER_REQUIRED_FIELDS` rejected byte-identical to a direct invalid command | `applyBatch` :380 `parseCommand` re-validates each sub-command byte-exact via per-command `validate` (defense-in-depth, D6) | **PASS** |
| **REQ-6FU-4** Adapter migration | SCN-6FU-8 (Depart_Now halt+depart both delivered) | `REDUCER_BATCH_DELIVERED` | `test_manual_session.js` `adapter-batch-delivers-halt-and-primary` PASS + `test_serial_batch.js`; `test_atomic_publication.js:914` | `Depart_Now.js:36-43` batch `[{OBSERVE_LATENESS_HALT},{DEPART_NOW}]` primary last; `Return_to_Base.js:93` batch `[{OBSERVE_STATUS},{OBSERVE_LATENESS_HALT},{RETURN_TO_BASE}]` | **PASS** (adapters migrated) |
| REQ-6FU-4 | SCN-6FU-9 (Finaliser release primary-last preserved) | `STATE_PROJECTION_SKIPPED` | `test_ac3_sandbox.js` `finaliser-midchain-preserves-par1-and-stages-release` PASS (existing test, Finaliser untouched → rule retained) | Finaliser.js NOT modified (`grep REDUCER_BATCH Finaliser.js` → 0); `tds_release_par1/par2` mid-chain rule unchanged — see F1 (D5 deferral) | **PASS** (rule RETAINED by virtue of not touching Finaliser) |
| **REQ-6FU-5** Non-base-origin departure | SCN-6FU-10 (non-base origin stages `OBSERVE_DEPARTURE`, stored on commit) | `OBSERVE_DEPARTURE_ACCEPTED`* | `test_fu2_departure_edge.js` `non-base-head-leg-in-window-stages-departure-once` PASS — stages exactly one `OBSERVE_DEPARTURE` carrying head-leg `targetEventId` + current planning day; `OBSERVE_DEPARTURE` applies via batch | `Sandbox_Engine.js:648-668` edge inside `leaveSec>0 && nowSec∈[leaveSec-600,latestValidDepart]` window, gated `targetId && !currentlyAtBase && !prevAtBase`; `Trip_State_Reducer.js:312` `applyObserveDeparture` stores record | **PASS** (see F2 — EVT alias deviation; evidence = applied count) |
| REQ-6FU-5 | SCN-6FU-11 (once-per-leg guard; no pollution; base-leave not double-observed) | `BATCH_SUBCOMMAND_REJECTED`* | `test_fu2_departure_edge.js` `re-entry-does-not-restage-departure` + `base-leave-departure-not-double-observed` PASS — applied sub-commands total 4+2=6 so departure applied exactly once across passes | Once-per-leg guard `Sandbox_Engine.js:649-660` reads `departures[last].planningDay === localPlanningDay(nowSec)`; base-leave branch `:580` gated `!currentlyAtBase && prevAtBase` — mutually exclusive `prevAtBase` conditions prevent double observation | **PASS** (see F2 — EVT alias deviation) |
| **MODIFIED REQ-4CMD-1** | SCN-4CMD-1 (envelope routed to one owner) | `STATE_COMMAND_ROUTED` | `test_state_command.js` existing routing assertions PASS | `TDS_State_Command.js:438` routes `REDUCER_BATCH` to the Reducer | **PASS** |
| MODIFIED REQ-4CMD-1 | SCN-4CMD-2 (malformed → no mutation) | `STATE_COMMAND_REJECTED` | `test_state_command.js` reject cases PASS | envelope reject = `BATCH_ENVELOPE_REJECTED`, no owner/file change | **PASS** |
| MODIFIED REQ-4CMD-1 | SCN-4CMD-3 (batch routed, added) | `REDUCER_BATCH_DELIVERED` | `test_state_command.js:248` PASS — `REDUCER_BATCH` routes to exactly `Trip_State_Reducer` as one owner entry | `TDS_State_Command.js:48` command in `REDUCER_COMMANDS`; `:438` route | **PASS** |
| **MODIFIED REQ-6STATE-4** | SCN-6STATE-7 (departure record stored, cross-day diff baseline) | `OBSERVE_DEPARTURE_ACCEPTED`* | `test_departure_day.js` 10/10 PASS + `test_serial_batch.js` base-leave `OBSERVE_DEPARTURE` lands | `applyObserveDeparture` stores `departures[]`; Compiler cross-day diff reads `state.trips[].departures[]` (unchanged) | **PASS** |
| MODIFIED REQ-6STATE-4 | SCN-6STATE-8 (non-base origin, added) | `OBSERVE_DEPARTURE_ACCEPTED`* | `test_fu2_departure_edge.js` PASS | `Sandbox_Engine.js:648-668` non-base active-leg edge (REQ-6FU-5) | **PASS** (see F2) |

\* See Finding F2: the spec EVT alias `OBSERVE_DEPARTURE_ACCEPTED` is not a reducer log code. The batch delivery path logs `REDUCER_BATCH_DELIVERED` with `{applied, skipped}`; covering tests assert applied-count totals rather than a nonexistent code (recorded deviation #2 in `apply-progress.md` PR 3). Scenario compliance is proven via the applied-count/runtime assertion, so the scenarios are deemed compliant despite the EVT-alias mismatch. This is a documentation nudge, not a runtime gap.

## 5. Correctness Table (design decisions vs implementation)

| Design decision | Implementation match | Notes |
| --- | --- | --- |
| D1 Batch envelope | `REDUCER_BATCH` command staged as one `setLocal` | ✅ Confirmed |
| D2 Everything-in-batch, primary last | `Depart_Now` `[{HALT},{DEPART_NOW}]`; `Return_to_Base` `[{STATUS},{HALT},{RETURN_TO_BASE}]` | ✅ Confirmed |
| D3 Apply-valid-in-order, log-and-skip | `applyBatch` :381-388 `skip+continue`, `:389` applies valid | ✅ Confirmed; all-or-nothing NOT present |
| D4 Single commit + single project | `reduce()` commits once after `applyBatch`; `applyBatch` returns running state, no per-sub write | ✅ Confirmed |
| D5 Finaliser | D5 (b) defer — Finaliser.js untouched, no Tasker wiring change | ✅ Deferral recorded (tasks 2.1-2.3 SUPERSEDED). Finaliser dropin/arrival observation migration deferred to a follow-up change — see F1. |
| D6 Both router + reducer validation (defense in depth) | Router envelope-shape (`:163-179`); reducer re-validates per sub-command via `parseCommand` (`:380`) | ✅ Confirmed — required so SCN-6FU-4/7 partial-failure is reachable (router deep-field check would dead-end them, per apply-progress deviation #2) |
| `MAX_REDUCER_BATCH_SIZE = 32`, REJECT not truncate | Constant in both files; oversized → `BATCH_ENVELOPE_REJECTED` at router + envelope-reject at reducer | ✅ Confirmed (resolved Open Question) |
| Revision bumps per applied sub-command | Each valid `apply*` bumps revision; one atomic commit writes final state | ✅ Matches design Open-Question resolution |
| Batch flush at true pass end (before `block_queue` emit) | `Sandbox_Engine.js:1827-1833` | ✅ Deviation #4 from `:897` anchor is the correct flush point (captures row-loop halts) — design anchor was illustrative |

## 6. Findings

### CRITICAL
None. No test failed, no required scenario lacks a passing covering test (modulo the documented EVT-alias nuance F2), no single-writer violation, no unchecked core task.

### WARNING

**W1 — REQ-6FU-4 Finaliser clause partially deferred (D5, recorded user decision).**
REQ-6FU-4's requirement text states "Finaliser.js observations the serial model would clobber SHALL route through the batch mechanism." The Finaliser dropin/arrival observation migration was deferred by an explicit user decision (D5 (b)) and recorded in `tasks.md` (tasks 2.1–2.3 marked `SUPERSEDED by D5 (b)`, task 2.4 records the deferral dated 2026-08-08). `Finaliser.js` is confirmed untouched (`grep REDUCER_BATCH Finaliser.js` → 0 matches). SCN-6FU-9 — which asserts the `tds_release_par1/par2` mid-chain primary-last rule SHALL be **preserved** — is satisfied because the rule is retained by the unchanged Finaliser (`test_ac3_sandbox.js` `finaliser-midchain-preserves-par1-and-stages-release` PASS). The Finaliser dropin/arrival observation migration is a follow-up change, NOT a completion gap in this change's scope. This is a WARNING (not CRITICAL) because: (a) the spec's testable scenarios are all covered; (b) the deferral is a legitimate user decision recorded in the tasks ledger; (c) `tasks.md` checks `[x]` for the SUPERSEDED tasks, so no core task is unchecked. The deferred Finaliser observation loss in production remains outside this change's scope and should be tracked as a follow-up.

**W2 — SCN-6FU-10 / SCN-6FU-11 / SCN-6STATE-7 / SCN-6STATE-8 EVT alias mismatch (recorded deviation).**
The spec's EVT alias `OBSERVE_DEPARTURE_ACCEPTED` is not a reducer log code. The `REDUCER_BATCH` delivery path logs `REDUCER_BATCH_DELIVERED` with `{count, applied, skipped}`; the reducer accepts an individual `OBSERVE_DEPARTURE` via `applyObserveDeparture` but emits `TRIP_STATE_COMMAND_ACCEPTED` (not a dedicated accepted code). The covering tests (`test_fu2_departure_edge.js`, `test_serial_batch.js`) assert applied-count totals (e.g. 4 + 2 = 6 across the two-pass base-leave→away case) to prove the departure applied exactly once, instead of asserting a nonexistent event code (recorded deviation #2 in `apply-progress.md` PR 3). Scenario compliance is proven at runtime; the EVT alias in the spec is aspirational. Suggestion: either add a real `OBSERVE_DEPARTURE_ACCEPTED` log code (canonical-sync notes already flag the merge into §25 at archive) OR align the spec EVT to `REDUCER_BATCH_DELIVERED`/`TRIP_STATE_COMMAND_ACCEPTED` during archive. Not blocking.

### SUGGESTION

**S1 — AGENTS.md command list / single-writer table should be updated at archive.**
`REDUCER_BATCH` is registered in `TDS_State_Command.REDUCER_COMMANDS` and the reducer's `COMMANDS` table, but the canonical `openspec/specs/itinerary/spec.md` §9 CMD-9 command list (line 101) does not yet list `REDUCER_BATCH`. The delta spec header carries an explicit canonical-sync note ("add `REDUCER_BATCH` to §9 CMD-9 command list; merge REQ-4CMD-1/REQ-6STATE-4 edits"), and task 4.1 records this is executed at archive. The single-writer contract is intact: the reducer remains the sole writer of `TDS_Trip_State.json` (`Trip_State_Reducer.commit` → `writeWithReadback(PHASE3_STATE_PATH, …, REDUCER_WRITER)`); no new single-writer resource was introduced. No action required pre-archive; recorded for the archive phase.

**S2 — Logging expectation.**
`BATCH_ENVELOPE_REJECTED` and `BATCH_SUBCOMMAND_REJECTED` and `REDUCER_BATCH_DELIVERED` are not yet in the AGENTS.md "required event codes" enumeration, which is a documentation list rather than an enforced registry. Recommend adding them at archive alongside the canonical spec sync. Non-blocking.

## 7. Regression / Architecture invariants

| Invariant | Status | Evidence |
| --- | --- | --- |
| Full harness green | ✅ | 30/30 PASS, exit 0 |
| `schemaVersion` stays 1 | ✅ | `Trip_State_Reducer.js:322` comment + `test_reducer_commands.js:65` assertion `state.schemaVersion === 1`; `Trip_State_Reducer.js:81` initial state `schemaVersion: PHASE3_SCHEMA_VERSION` (1) |
| No new single-writer resource | ✅ | `REDUCER_BATCH` is a command envelope, not a file; reducer stays sole writer of `TDS_Trip_State.json` (`Sandbox_Engine.js:433-434`, `commit()` :398). Finaliser/Alpha untouched. |
| No direct writes to published itinerary | ✅ | `Depart_Now.js:5-7` maintains the no-publish rule; adapters stage commands only |
| No silent state inference / no zero-duration legs / no unbounded time conditions | ✅ (out of change scope) | Unchanged; this change neither adds inference nor touches travel-leg duration |
| Once-per-leg guard prevents `departures[]` pollution | ✅ | `test_fu2_departure_edge.js` re-entry + base-leave-double-observation sections PASS |
| Cross-day diff baseline preserved | ✅ | Compiler.js departure-diff reads `state.trips[].departures[]`; FU2 only ADDS records via the standard `OBSERVE_DEPARTURE` path; `test_departure_day.js` 10/10 |
| AGENTS.md hard rules intact | ✅ | No rule violated; reducer sole writer; no Tasker task-loop wiring change (D5 b honoured) |

## 8. Final Verdict

# PASS WITH WARNINGS

**Rationale.** All five new requirements (REQ-6FU-1..5) and both modified requirements (REQ-4CMD-1, REQ-6STATE-4) have at least one passing covering test per scenario at runtime; the full 30-script harness is green (exit 0); the design decisions D1–D6 are implemented as specified (with documented, correct deviations); `schemaVersion` stays 1 and no new single-writer resource was introduced; the single-writer contract and AGENTS.md hard rules are intact.

The two warnings are both **explicitly recorded, user-authorised, non-runtime gaps**:
- **W1** — the Finaliser dropin/arrival observation migration clause of REQ-6FU-4 is deferred to a follow-up change by the D5 (b) user decision (dated 2026-08-08), recorded as SUPERSEDED in `tasks.md`; SCN-6FU-9 (retain `tds_release_par1/par2` rule) is satisfied by the preserved Finaliser. The Finaliser production observation loss is outside this change's scope.
- **W2** — the spec EVT alias `OBSERVE_DEPARTURE_ACCEPTED` is not a real reducer log code; covering tests assert applied-count totals instead (recorded deviation). Scenario compliance is proven at runtime.

No CRITICAL findings. No failing test. No unchecked core task. The change is verified PASS WITH WARNINGS and is ready for archive (which will execute the canonical-sync note for `REDUCER_BATCH` in §9 CMD-9 and the REQ-4CMD-1 / REQ-6STATE-4 merges, plus the S1/S2 documentation adds).