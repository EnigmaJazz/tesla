# Design: Phase 6 — State Decomposition

## Technical Approach

Complete the Phase 3 migration contract: four memory globals (R-TRIP-7: `TDS_Depart_Memory`, `TDS_Completed_Dropins`, `TDS_Arrival_Memory`, `TDS_Completed_Stops`) retire to trip-state-only; five status globals (R-TRIP-8: `User_At_Base`, `Base_Arrival_Unix`, `TDS_Lateness_Halt`, `Current_Status`, `TDS_Manual_Return_Completed`) become state-backed read-only projections written by the reducer's `project()` after each committed state change. Three chained slices map to proposal Approach 2 and REQ-6STATE-1..8: (1) reducer write-side — `project()` + 3 missing commands + `OBSERVE_DEPARTURE` production caller + owner table + tests; (2) read-side cutover of the four memories + harness inversion (split 2a/2b if >400 Δ lines); (3) vestigial deletion + config/testing docs.

## Architecture Decisions

| # | Decision | Choice | Rejected | Rationale |
|---|---|---|---|---|
| D1 | `OBSERVE_DEPARTURE` production caller | `Sandbox_Engine.js` base-leave branch (:571) | Dispatcher; Compiler | Sandbox detects the natural base-departure via geo-processing, already stages the symmetric `OBSERVE_LIVE_BASE` on arrival (:527), and holds the active-leg context (`oldItin[0].targetEventId`) for the cross-day event identity. Dispatcher acts on already-selected trips via `DEPART_NOW` — `applyDepartNow` (:131) records `actualDepartUnix` separately (manual lifecycle, not a cross-day recurring observation). Compiler plans; it does not observe actuals (spec: "previous day's **actual** departure"). |
| D2 | Resolver copies (REQ-6STATE-6) | Keep the 5 byte-identical `readActiveGeneration` copies; amend canonical spec | Cached-global par1 indirection | Tasker standalone-script isolation forbids imports; copies are a documented necessity (TDS_Helper.js:20-24). TDS_Helper.js:25 stays canonical; canonical spec records their retention rather than demanding removal. |
| D3 | schemaVersion | No bump — stay v1 | 1→2 + migrator | New commands activate fields already present in `initialState()` (:74-89: `userAtBase`, `baseArrivalUnix`, `latenessHalt`, `currentStatus`). No fields added. Future 1→2 MUST ship a migrator; the current unknown-version reset in `loadState` (:94-97) is data loss for in-flight trips. |
| D4 | Base-leave clear | New `OBSERVE_BASE_LEAVE` command | Extend `OBSERVE_LIVE_BASE` with `atBase:false` | Separate semantics (arrival vs departure) avoids overloading one command; idempotent (no-op if `userAtBase` already false). |
| D5 | Projection write discipline | `project(state)` runs inside `reduce()` only AFTER commit + exact read-back succeeds; on failure it is skipped, prior bytes preserved, `STATE_PROJECTION_SKIPPED` logged | Component `setGlobal` of the 5 status globals | REQ-6STATE-2 forbids authoritative globals. The gating is structural: `reduce()` (:460) already calls `project()` only post-successful `commit()` (:454, which does `writeWithReadback`); slice 1 adds the `STATE_PROJECTION_SKIPPED` log on the `!commitResult.ok` path (:455). |

## Data Flow

```
component ──stage cmd──▶ reducer.validate ──▶ apply(pure) ──▶ commit+read-back ──▶ project(state)
   ▲                                                                         │
   │                                                                         ▼
   └── reads projected global ◀── setGlobal(5 R-TRIP-8 globals from committed state)
        (Dashboard, Dispatcher, Sandbox read-side keep reading globals as projections)
```

On commit/read-back failure: `reduce()` returns `ERROR` (:457), `project()` never runs, prior global bytes preserved, `STATE_PROJECTION_SKIPPED` logged (SCN-6STATE-3).

## File Changes

| File | Slice | Action | Anchors |
|---|---|---|---|
| `Trip_State_Reducer.js` | 1 | Implement `project()` (:342 no-op → `setGlobal` 5 globals from `newState`); add `applyObserveBaseLeave`/`applyObserveLatenessHalt`/`applyObserveStatus` (idempotent); add 3 `COMMANDS` entries (:296); log `STATE_PROJECTION_SKIPPED` on commit fail (:455); pass `newState` to `project()` (:460) | :296,:342,:455,:460 |
| `TDS_State_Command.js` | 1 | Add `OBSERVE_BASE_LEAVE`/`OBSERVE_LATENESS_HALT`/`OBSERVE_STATUS` to `REDUCER_COMMANDS` (:39) + `REDUCER_REQUIRED_FIELDS` (:56), byte-exact field parity with reducer `validate` | :39,:56 |
| `Sandbox_Engine.js` | 1 | `setGlobal('TDS_Lateness_Halt','false'/'true')` (:427,1249,1343,1419,1640) → stage `OBSERVE_LATENESS_HALT`; remove `setGlobal User_At_Base/Base_Arrival_Unix` (:521 — `OBSERVE_LIVE_BASE` at :527 + `project()` own them); :571 base-leave → stage `OBSERVE_BASE_LEAVE` + `OBSERVE_DEPARTURE` (tripId from `oldItin[0].targetEventId` — reorder `oldItin` read above :571); :616 `setGlobal('Current_Status')` → stage `OBSERVE_STATUS` | :427,:521,:571,:616,:1249+ |
| `Depart_Now.js` | 1 | :35 `setGlobal('TDS_Lateness_Halt','false')` → stage `OBSERVE_LATENESS_HALT {halt:false}` | :35 |
| `Return_to_Base.js` | 1 | :100-101 `setGlobal Current_Status`/`TDS_Lateness_Halt` → stage `OBSERVE_STATUS` + `OBSERVE_LATENESS_HALT` | :100 |
| `Compiler.js` | 2 | :527 read `TDS_Depart_Memory` → read `state.trips[tripId].departures[]`; :700 `setGlobal('TDS_Depart_Memory')` → remove (state is authority, populated by `OBSERVE_DEPARTURE`) | :527,:700 |
| `Finaliser.js` | 2 | :93,95 read `TDS_Completed_Dropins`/`TDS_Arrival_Memory` → read `state.completedDropins`/`state.trips[].observedArrivalUnix`; :167-168 `setGlobal` → remove; delete vestigial override-merge (:224-250, `Engine_Output_Itinerary` :244) + `TDS_Optimize_Queue` write (:387) | :93,:167,:224,:387 |
| `Sandbox_Engine.js` | 2 | :18 read `global('TDS_Completed_Stops')` → read `state.completedStops` ONCE at module top (preserve single-snapshot-per-pass) | :18 |
| `Stop_Logger.js` | 2 | :43 `setGlobal('TDS_Completed_Stops')` → remove (`COMPLETE_STOP` staging :51 stays, sole path) | :43 |
| `Override_Handler.js` | 2 | Remove `GLOBAL_MEMORIES` list (:74-78) + prune loop (:640-646); reducer 30-day retention owns stop/dropin/departure/arrival state | :74,:640 |
| `Alpha.js` | 3 | Remove `TDS_Optimize_Queue` clear (:45) + `TDS_Count` write (:259) | :45,:259 |
| `Sandbox_Engine.js` | 3 | Delete dead `readOrigin()` (:159-168) — TDS_Helper.js:51 is canonical; Sandbox reads `User_At_Base` projection | :159 |
| `openspec/specs/itinerary/spec.md` | archive | §8 line ~98: replace "ephemeral globals pending Phase 3 migration" with the migration contract (4 keys state-only; 5 globals state-backed projections, MAY project); add resolver-copies requirement (REQ-6STATE-6) | ~:98 |
| `openspec/config.yaml` | 3 | `apply.test_command`/`verify.test_command` → `node harness/test_*.js`; `testing.runner`/`layers.unit`/`layers.integration` → harness reality | — |
| `openspec/testing-capabilities.md` | 3 | Mirror config; `Detected` → 2026-08-07; replace "could be created" note with `harness/` layout (mock_tasker.js, runner.js, day_utils.js, 28 tests) | — |
| `harness/test_single_writer.js` | 2 | Invert E2-1..E2-4 (:523,557,571,586): assert state reads, not legacy global writes | :523-588 |
| `harness/test_trip_lifecycle.js` | 1+2 | Slice 1: add `OBSERVE_BASE_LEAVE`/`OBSERVE_LATENESS_HALT`/`OBSERVE_STATUS`/`project()` + `STATE_PROJECTION_SKIPPED` tests; Slice 2: assert Sandbox reads `state.completedStops` | — |
| `harness/test_ac5.js`, `test_departure_day.js` | 2 | Audit for legacy-global assertions; update any asserting `TDS_Depart_Memory`/`TDS_Completed_Stops` writes | — |

## Interfaces / Contracts

New command payloads (byte-exact parity: reducer `validateFields` ↔ `TDS_State_Command.REDUCER_REQUIRED_FIELDS`):

```js
OBSERVE_BASE_LEAVE:    { generationId, at:number }               // userAtBase=false, baseArrivalUnix=null
OBSERVE_LATENESS_HALT: { generationId, halt:any, at:number }     // halt coerced: true|"true"→true (type:"any" matches SET_OVERRIDE pattern; validateFields unchanged)
OBSERVE_STATUS:        { generationId, status:string, at:number }// currentStatus=status
// OBSERVE_DEPARTURE (:307) already exists; gains production caller (Sandbox :571)
project(state): setGlobal(User_At_Base, state.userAtBase); setGlobal(Base_Arrival_Unix, state.baseArrivalUnix);
  setGlobal(TDS_Lateness_Halt, state.latenessHalt); setGlobal(Current_Status, state.currentStatus);
  setGlobal(TDS_Manual_Return_Completed, state.manualReturnCompleted)
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit (slice 1) | `project()` writes 5 globals post-commit; `STATE_PROJECTION_SKIPPED` on commit fail; 3 new commands idempotent + projection | Extend `test_trip_lifecycle.js` via reducer shim; assert `store.globals` + `store.flashLog` |
| Unit (slice 2) | Compiler reads `state.departures[]`; Finaliser reads `state.completedDropins`/`observedArrivalUnix`; Sandbox reads `state.completedStops` (snapshot); Stop_Logger no global write | Invert E2-1..E2-4 in `test_single_writer.js`; update `test_ac5.js`, `test_departure_day.js` |
| Regression | 28/28 (→29 if new file) green after each slice | `for f in harness/test_*.js; do node $f; done` (baseline verified 28/28) |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

Per-slice revertible. Slice 1: `project()` writes the 5 status globals, readers keep reading projections → no read-side regression. Memory-global writers (Compiler/Finaliser/Stop_Logger) keep writing until slice 2 verifies state reads. No schema change, no feature flag. Single-writer contract preserved: reducer remains sole writer of `TDS_Trip_State.json`; `project()` is the sole writer of the 5 status globals (closing the dual-write gap at Sandbox_Engine.js:521/572).

## Review Workload Forecast

| Slice | Files | Est. Δ lines (incl. tests) | 400-line budget risk |
|---|---|---|---|
| 1 | Reducer, State_Command, Sandbox, Depart_Now, Return_to_Base, test_trip_lifecycle | 300–380 | Medium |
| 2 | Compiler, Finaliser, Sandbox, Stop_Logger, Override_Handler, test_single_writer, test_ac5, test_departure_day, test_trip_lifecycle | 380–460 | High → split 2a (Compiler + Stop_Logger + Override_Handler + E2-1/E2-3/E2-4 + tests) / 2b (Finaliser + Sandbox + E2-2 + tests) |
| 3 | Alpha, Sandbox (readOrigin), config.yaml, testing-capabilities.md, canonical spec sync | 150–200 | Low |

Decision needed before apply: Yes (D1 caller confirmed; D3 no-bump confirmed). Chained PRs recommended: Yes — slice 2 forecasts High. 400-line budget risk: Medium (slice 1), High (slice 2 → split 2a/2b), Low (slice 3).

## Open Questions

- [ ] Tasker serial-task multi-command staging per Sandbox pass is pre-existing (`OBSERVE_LIVE_BASE` + `COMPLETE_TRIP` already stage multiple via the synchronous reducer shim at :532/:567). Slice 1 adds `OBSERVE_LATENESS_HALT`/`OBSERVE_STATUS`/`OBSERVE_BASE_LEAVE` to this shape; the harness verifies via the synchronous shim, Tasker production is device-validated. A batch-staging mechanism is deferred (not introduced by Phase 6).
- [ ] Non-base-origin departures are not observed by the Sandbox base-leave caller (D1) — the cross-day diff falls back to the prior-day record for those legs. Acceptable for v1 (overnight base-origin is the dominant pattern); follow-up if the API-conflict signal weakens.
