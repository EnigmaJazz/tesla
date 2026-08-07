# Tasks: Phase 6 — State Decomposition

## Review Workload Forecast

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

Delivery `auto-chain`; D1 (caller = Sandbox_Engine.js:571) & D3 (v1) confirmed; chain topology awaits user. Tests + docs count toward deltas.

| Slice | PR | Est. Δ lines (incl. tests+docs) | Budget risk | Chained PR? | Decision needed? |
|---|---|---|---|---|---|
| 1 | PR 1 | 300–380 | Medium | No | No |
| 2a | PR 2a | 200–240 | Medium | No | No |
| 2b | PR 2b | 180–220 | Medium | No | No |
| 3 | PR 3 | 150–200 | Low | No | No |

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | `project()` + 3 commands + callers + owner table | PR 1 | `node harness/test_trip_lifecycle.js`; then full loop | harness vm sandbox; device flows manual-only (N/A: serial par1/par2, %-expansion) | Revert reducer/State_Command/Sandbox/adapters+tests; readers keep globals, memory writers untouched |
| 2a | Compiler/Stop_Logger/Override_Handler reads; E2-1/3/4 inversion | PR 2a | `node harness/test_single_writer.js && node harness/test_ac5.js && node harness/test_departure_day.js` | harness vm sandbox | Revert 2a files + test inversions; independent of 2b |
| 2b | Finaliser/Sandbox reads + E2-2; Finaliser vestigial merge deletion | PR 2b | `node harness/test_single_writer.js`; then full loop | harness vm sandbox | Revert 2b files + E2-2; 2a reads independent |
| 3 | Alpha/readOrigin deletion + config/testing docs + canonical spec sync | PR 3 | `for f in harness/test_*.js; do node $f; done` | harness vm sandbox, 28/28 gate | Pure-deletion reverts; zero behavior delta |

## Slice 1 — Reducer write-side (PR 1)

- [x] 1.1 `Trip_State_Reducer.js`:342 — `project(newState)` setGlobals 5 status globals from committed state [REQ-6STATE-2 SCN-6STATE-4]
- [x] 1.2 `Trip_State_Reducer.js`:455/:460 — skip projection on commit/read-back fail, preserve prior bytes, log `STATE_PROJECTION_SKIPPED` [REQ-6STATE-2 SCN-6STATE-3]
- [x] 1.3 `Trip_State_Reducer.js`:296 — add `OBSERVE_BASE_LEAVE` + idempotent `applyObserveBaseLeave` (`userAtBase=false`, `baseArrivalUnix=null`) [REQ-6STATE-3 SCN-6STATE-5]
- [x] 1.4 `Trip_State_Reducer.js`:296 — add `OBSERVE_LATENESS_HALT` + `applyObserveLatenessHalt` (coerce `true|"true"→true`) [REQ-6STATE-3 SCN-6STATE-6]
- [x] 1.5 `Trip_State_Reducer.js`:296 — add `OBSERVE_STATUS` + `applyObserveStatus` (`currentStatus=status`) [REQ-6STATE-3]
- [x] 1.6 `TDS_State_Command.js`:39/:56 — register 3 commands in `REDUCER_COMMANDS` + `REDUCER_REQUIRED_FIELDS`, byte-exact parity [REQ-6STATE-3]
- [x] 1.7 `Sandbox_Engine.js`:571 — reorder `oldItin` above :571; base-leave stages `OBSERVE_BASE_LEAVE` + `OBSERVE_DEPARTURE` (`tripId`=`oldItin[0].targetEventId`) [REQ-6STATE-4 SCN-6STATE-7]
- [x] 1.8 `Sandbox_Engine.js` — lateness `setGlobal` :427/:1249/:1343/:1419/:1640 → stage `OBSERVE_LATENESS_HALT`; remove :521 base setGlobals; :616 `Current_Status` → `OBSERVE_STATUS` [REQ-6STATE-1/2 SCN-6STATE-4/5/6]
- [x] 1.9 `Depart_Now.js`:35 — `setGlobal('TDS_Lateness_Halt','false')` → stage `OBSERVE_LATENESS_HALT {halt:false}` [REQ-6STATE-3 SCN-6STATE-6]
- [x] 1.10 `Return_to_Base.js`:100-101 — setGlobals → stage `OBSERVE_STATUS` + `OBSERVE_LATENESS_HALT` [REQ-6STATE-3 SCN-6STATE-5/6]
- [x] 1.11 `harness/test_trip_lifecycle.js` — tests: 3 commands idempotent; `project()` writes 5 globals; `STATE_PROJECTION_SKIPPED` on commit-fail shim [REQ-6STATE-2/3 SCN-6STATE-3/4/5/6]
- [x] 1.12 Regression: full harness loop green 28/28 [REQ-6STATE-8 SCN-6STATE-11]

## Slice 2a — Compiler / Stop_Logger / Override_Handler (PR 2a)

- [x] 2a.1 `Compiler.js`:527/:700 — read `state.trips[tripId].departures[]` for prune + `departChanged`/`departDiffMins`; remove `setGlobal('TDS_Depart_Memory')` [REQ-6STATE-1/4 SCN-6STATE-1/7]
- [x] 2a.2 `Stop_Logger.js`:43 — remove `setGlobal('TDS_Completed_Stops')`; `COMPLETE_STOP` staging (:51) sole path [REQ-6STATE-1 SCN-6STATE-1]
- [x] 2a.3 `Override_Handler.js`:74-78/:640-646 — delete `GLOBAL_MEMORIES` list + prune loop; reducer 30-day retention owns [REQ-6STATE-1 SCN-6STATE-2]
- [x] 2a.4 `harness/test_single_writer.js` — invert E2-1 (:523) + E2-3 (:557): assert state reads, not global writes [REQ-6STATE-8 SCN-6STATE-11] (E2-4 re-scoped to 2b by orchestrator: Sandbox read cutover is 2b.2)
- [x] 2a.5 `harness/test_ac5.js` + `test_departure_day.js` — audit `TDS_Depart_Memory`/`TDS_Completed_Stops` assertions; none exist (test_ac5 only seeds Finaliser inputs = 2b) [REQ-6STATE-8 SCN-6STATE-11]
- [x] 2a.6 Regression: full harness loop green 28/28 [REQ-6STATE-8 SCN-6STATE-11]

## Slice 2b — Finaliser / Sandbox + E2-2 (PR 2b)

- [x] 2b.1 `Finaliser.js`:93/:95/:167-168 — read `state.completedDropins` + `state.trips[].observedArrivalUnix`; remove setGlobal writes [REQ-6STATE-1 SCN-6STATE-1]
- [x] 2b.2 `Sandbox_Engine.js`:18 — read `state.completedStops` once at module top (single-snapshot-per-pass) [REQ-6STATE-1 SCN-6STATE-1]
- [x] 2b.3 `harness/test_single_writer.js` — invert E2-2 (:571): assert state reads [REQ-6STATE-8 SCN-6STATE-11]
- [x] 2b.4 `harness/test_trip_lifecycle.js` — assert Sandbox reads `state.completedStops` snapshot [REQ-6STATE-1 SCN-6STATE-1]
- [x] 2b.5 `Finaliser.js`:224-250/:387 — delete vestigial override-merge + `Engine_Output_Itinerary` (:244) + `TDS_Optimize_Queue` write; itinerary unchanged [REQ-6STATE-5 SCN-6STATE-8]
- [x] 2b.6 Regression: full harness loop green 28/28 [REQ-6STATE-8 SCN-6STATE-11]

## Slice 3 — Vestigial deletion + docs (PR 3)

- [x] 3.1 `Alpha.js`:45/:259 — remove `TDS_Optimize_Queue` clear + `TDS_Count` write; keep `Tesla_Last_Sync`/`Daily_Walk_Meters` [REQ-6STATE-5 SCN-6STATE-8]
- [x] 3.2 `Sandbox_Engine.js`:159-168 — delete dead `readOrigin()`; TDS_Helper.js:51 canonical [REQ-6STATE-5]
- [x] 3.3 `openspec/config.yaml` — `apply`/`verify.test_command` → `node harness/test_*.js`; `testing.runner`/`layers.unit`/`layers.integration` → harness reality [REQ-6STATE-7 SCN-6STATE-10]
- [x] 3.4 `openspec/testing-capabilities.md` — mirror config; `Detected` → 2026-08-07; replace "could be created" with `harness/` layout (mock_tasker.js, runner.js, day_utils.js, 28 tests) [REQ-6STATE-7 SCN-6STATE-10]
- [x] 3.5 Canonical `openspec/specs/itinerary/spec.md` §8 (~:98) — migration contract (4 keys state-only; 5 globals state-backed) + resolver-copies retention; applied at archive [REQ-6STATE-1/6 SCN-6STATE-9]
- [x] 3.6 Verify: full loop 28/28; grep — no live get/set of 4 memory globals; `project()` read-back verified [REQ-6STATE-8 SCN-6STATE-11]
- [x] 3.7 `Trip_State_Reducer.js` — implement 30-day retention prune (DEFAULT_RETENTION_DAYS=30 declared at :35, never implemented): prune trips/departures/completedDropins/completedStops/observedArrivalUnix older than 30 local planning days on the next commit after Override_Handler prune loop removal; log STATE_STOP_RETENTION_APPLIED; add harness coverage [REQ-6STATE-1 SCN-6STATE-2]
