# Apply Progress — Phase 6 State Decomposition, Slice 1 (PR 1)

**Change**: tasker-tesla-upgrade-phase-6-state-decomposition
**Slice**: 1 — Reducer write-side (PR 1 of the stacked-to-main chain)
**Branch**: `tasker-tesla-phase6-pr-1` (from `master`)
**Date**: 2026-08-07
**Mode**: Standard (strict_tdd: false per `openspec/config.yaml`); RED-first where practical
**Delivery**: auto-chain / stacked-to-main; review budget 400 changed lines

## Status

Slice 1 complete: tasks 1.1–1.12 all `[x]` in `tasks.md`. Full harness 28/28 green.

## Commits (on `tasker-tesla-phase6-pr-1`)

| SHA | Message |
|---|---|
| `da9037a` | test(reducer): RED — status observation commands, projection, and projection-skip tests |
| `73c9e67` | feat(reducer): project the five status globals and add the three missing observe commands |
| `3179691` | docs(sdd): mark Phase 6 slice 1 tasks complete (PR 1) |

Not pushed; PR delivery is the orchestrator's step. `apply-progress.md` is intentionally
left UNCOMMITTED (a separate docs commit) so the PR diff stays under the 400-line budget.

## Work Unit Evidence

| Evidence | Required value |
|---|---|
| Focused test command and exact result | `node harness/test_trip_lifecycle.js` → `PASS: trip-lifecycle: arrival, live-base origin, idempotency, atomicity, status observations, projection` (11 tests, exit 0). RED confirmed first: `ERROR: unknown command: OBSERVE_BASE_LEAVE` before implementation. |
| Runtime harness command/scenario and exact result | `for f in harness/test_*.js; do node $f; done` → **28 passed, 0 failed**. Includes sandbox base-arrival/leave paths (`test_ac5.js`, `test_atomic_publication.js`), adapters (`test_manual_session.js`, `test_atomic_publication.js`), and the router (`test_state_command.js`). |
| Rollback boundary | Revert commits `da9037a..3179691` (or the branch) — readers keep reading the globals as projections, memory-global writers (Compiler/Finaliser/Stop_Logger) untouched, `schemaVersion` stays 1. No read-side cutover (slice 2a/2b) or vestigial deletion (slice 3) is included. |

## Test coverage added (task 1.11, `harness/test_trip_lifecycle.js`)

- `OBSERVE_BASE_LEAVE`: clears `userAtBase`/`baseArrivalUnix`, projects `User_At_Base=false` / `Base_Arrival_Unix=""`; idempotent (no revision bump).
- `OBSERVE_LATENESS_HALT`: coerces `true|"true"→true`, clears on `false`, projects `TDS_Lateness_Halt`; idempotent.
- `OBSERVE_STATUS`: sets + projects `Current_Status`; idempotent; rejects missing `status` with `GENERATION_VALIDATION_FAILED`.
- `project()`: after a successful commit writes all five R-TRIP-8 globals (`User_At_Base`, `Base_Arrival_Unix`, `TDS_Lateness_Halt`, `Current_Status`, `TDS_Manual_Return_Completed`) exactly from committed state (SCN-6STATE-4).
- `STATE_PROJECTION_SKIPPED`: on a torn-write commit failure the command returns `ERROR`, the event is logged (warn, names the command), and prior global bytes are preserved (SCN-6STATE-3).

Also updated (regression gate 28/28, required companion): `harness/test_reducer_commands.js`
`testAtomicity` — `project()` now writes the five globals after every successful commit
(the old "must not project any global" assertion inverted by REQ-6STATE-2). File was not
listed in the design's slice-1 table, but task 1.12's 28/28 gate forces it.

## Deviations from design

1. **Sandbox per-pass lateness reset placement (design anchor :427 → code ~:891)**: the
   design says replace `setGlobal('TDS_Lateness_Halt','false')` at the top of `try` (:427).
   A reducer commit there runs `project()` BEFORE the pass reads its live `Current_Status`
   / `User_At_Base` / `Base_Arrival_Unix` inputs, re-projecting stale state bytes over them
   (the harness caught this: base-arrival detection and `LIVE_BASE_OVERRIDES_LEGACY_ORIGIN`
   broke). The reset is staged as the same `OBSERVE_LATENESS_HALT {halt:false}` but after the
   pass has read all live inputs (before the planning loop). EOF passes (idx > master.length)
   no longer reset the halt — the next real pass does; harmless (nothing in the pipeline reads
   `TDS_Lateness_Halt` except Dashboard's UI projection). Same command, same semantics, only
   the firing point moved.
2. **Adapter staging order (Depart_Now / Return_to_Base)**: the `OBSERVE_LATENESS_HALT` /
   `OBSERVE_STATUS` stages are placed BEFORE the primary envelope staging, because the
   adapters' existing contract (asserted by `test_manual_session.js` / `test_atomic_publication.js`)
   requires `par1` to end as `DEPART_NOW` / `RETURN_TO_BASE`. In the serial Tasker chain only the
   last staged command reaches the reducer — the same deferred batch-staging limitation the
   design's Open Questions record for the Sandbox ("Tasker production is device-validated").
   The harness verifies the reducer commands themselves directly (slice-1 tests) and the
   adapters' final envelope (existing tests).
3. **`test_reducer_commands.js` `testAtomicity` update** — see above (forced by 28/28).

## Issues found

- The pass-start clobber (deviation 1) was a real ordering hazard introduced by `project()`
  becoming live: ANY reducer commit mid-pass rewrites all five globals from state. Only the
  pass-start reset preceded live-input reads; all other staged sites (`OBSERVE_LIVE_BASE`,
  `OBSERVE_STATUS`, base-leave pair, conflict halts) fire after the reads that matter and
  project values identical to the removed direct writes. Slice 2a/2b must keep this ordering
  in mind when cutting Sandbox reads over to state.
- `stageReducerCommand` sites with a missing `TDS_Active_Generation` fall back to
  `"gen:0:0000"`, which fails the reducer's generationId regex and silently no-ops — this is
  the pre-existing `OBSERVE_LIVE_BASE` pattern (design anchor :529), not introduced here.

## Not in this slice (deferred to PR 2a/2b/3 — NOT touched)

- Slice 2a: Compiler/Stop_Logger/Override_Handler reads, E2-1/3/4 inversion, `TDS_Depart_Memory` / `TDS_Completed_Stops` writes.
- Slice 2b: Finaliser/Sandbox reads + E2-2, `readActiveGeneration` copies, vestigial merge deletion.
- Slice 3: Alpha deletions, dead `readOrigin()`, config/testing docs, canonical spec sync.

---

# Apply Progress — Phase 6 State Decomposition, Slice 2a (PR 2a)

**Change**: tasker-tesla-upgrade-phase-6-state-decomposition
**Slice**: 2a — Read-side cutover: Compiler / Stop_Logger / Override_Handler (PR 2a of the stacked-to-main chain)
**Branch**: `tasker-tesla-phase6-pr-2a` (from `master`, after PR 1 merged as dce6746)
**Date**: 2026-08-07
**Mode**: Standard (strict_tdd: false per `openspec/config.yaml`); RED-first where practical
**Delivery**: auto-chain / stacked-to-main; review budget 400 changed lines

## Status

Slice 2a complete: tasks 2a.1–2a.6 all `[x]` in `tasks.md`. Full harness 28/28 green.
Changed lines vs master: **232** (120 insertions + 112 deletions, incl. tests) — under the 400 budget.

## Commits (on `tasker-tesla-phase6-pr-2a`)

| SHA | Message |
|---|---|
| `bc9cd5b` | test(single-writer): RED — invert E2-1/E2-3 and PRUNE globals to state ownership |
| `78e58b0` | feat(state): cut Compiler/Stop_Logger/Override_Handler memory reads over to trip state |

Not pushed; PR delivery is the orchestrator's step.

## Work Unit Evidence

| Evidence | Required value |
|---|---|
| Focused test command and exact result | `node harness/test_single_writer.js` → RED confirmed first (3 assertion groups failed: PRUNE globals, E2-1, E2-3), then `PASS: Override Single Writer — … globals, propose-default, projection sync` (exit 0) after implementation. |
| Runtime harness command/scenario and exact result | `for f in harness/test_*.js; do node $f; done` → **28 passed, 0 failed**. Includes `test_ac5.js` (Stop_Logger staging, Finaliser gate), `test_departure_day.js` (reducer OBSERVE_DEPARTURE state), `test_trip_lifecycle.js` (projection). |
| Rollback boundary | Revert commits `bc9cd5b..78e58b0` (or the branch) — Finaliser/Sandbox still read the legacy globals (2b), reducer state retains records, `schemaVersion` stays 1. Independent of 2b/3. |

## Task mapping

- **2a.1** `Compiler.js`: `TDS_Depart_Memory` global read (:527) → `readFile("Tasker/Tesla/Data/TDS_Trip_State.json")` → `state.trips[tripId].departures[]` (last record = prior actual departure); prune loop + `newDepMem` accumulation + `setGlobal('TDS_Depart_Memory')` (:700) removed. `departChanged`/`departDiffMins` cross-day semantics preserved (REQ-6STATE-4, SCN-6STATE-7).
- **2a.2** `Stop_Logger.js`: global read/append/dedup + `setGlobal('TDS_Completed_Stops')` (:43) removed; the staged `COMPLETE_STOP` command is the sole record path; reducer owns `state.completedStops`.
- **2a.3** `Override_Handler.js`: `GLOBAL_MEMORIES` list (:74-78), the PRUNE memory loop (:640-646), and its now-dead helpers `pruneCsv` + `DEPART_WINDOW_SECS` deleted. Category projections (`eventOverrides` prune + `syncProjections`) retained. Closes the missing-`TDS_Completed_Stops` unbounded-growth gap (SCN-6STATE-2).
- **2a.4** `test_single_writer.js`: E2-1 + E2-3 inverted to assert state reads and NO global writes; PRUNE globals section inverted to assert byte-identical (state-owned) globals. E2-4 re-scoped to 2b (Sandbox read cutover is 2b.2) per orchestrator.
- **2a.5** `test_ac5.js` + `test_departure_day.js`: audited — **no** `TDS_Depart_Memory`/`TDS_Completed_Stops` assertions exist. `test_ac5.js` seeds Finaliser's `TDS_Completed_Dropins`/`TDS_Arrival_Memory` inputs (2b behavior, untouched); `test_departure_day.js` is already pure reducer-state. No edits needed.
- **2a.6** Regression: 28/28 green (full loop).

## Deviations from design

1. **E2-4 inversion moved to 2b** (design work-unit table lists "E2-1/3/4 inversion" under 2a): the orchestrator's authoritative scope assigns E2-4 (Sandbox reads `TDS_Completed_Stops`) to slice 2b because the Sandbox `state.completedStops` read is task 2b.2. Inverting E2-4 in 2a would assert a read cutover that does not exist until 2b. `tasks.md` 2a.4 annotated accordingly.
2. **`test_single_writer.js` PRUNE-globals section (:375-390) inverted in 2a** (not listed in the design's slice table): it asserted the exact `GLOBAL_MEMORIES` prune loop 2a.3 deletes; task 2a.6's 28/28 gate forces it. Same pattern as slice 1's `test_reducer_commands.js` companion.
3. **Dead helpers removed with the prune loop**: `pruneCsv` (:607-618) and `DEPART_WINDOW_SECS` (:36) existed only to serve the deleted global-memory prune; removed in the same work unit (they would otherwise be dead code referencing the retired globals).
4. **Compiler comment at the former `newDepMem.push` site**: replaced the memory-leak note with a state-authority note; no behavior change (rejected legs never reach state).

## Issues found

- **Reducer 30-day retention is declared but NOT yet implemented**: `Trip_State_Reducer.js` declares `DEFAULT_RETENTION_DAYS = 30` (:35) and its header documents pruning "on the next commit", but no pruning code exists — `STATE_STOP_RETENTION_APPLIED` appears only in the spec (SCN-6STATE-2). With the Override_Handler prune loop gone, the reducer is now the sole owner of departure/dropin/arrival/stop retention, but nothing enforces the 30-day bound yet. **This must land before archive** — likely as a slice-3 or post-slice-3 follow-up; flagging so verify/archive does not assume SCN-6STATE-2 is fully evidenced. The slice-2a tasks (remove the handler prune, assert no global reads) are complete; the reducer retention implementation is a separate unit.

## Not in this slice (deferred to PR 2b/3 — NOT touched)

- Slice 2b: Finaliser (`TDS_Completed_Dropins`/`TDS_Arrival_Memory` reads :93-95, writes :167-168), Sandbox `state.completedStops` read (:18), E2-2/E2-4 inversion, vestigial merge deletion.
- Slice 3: Alpha deletions, dead Sandbox `readOrigin()`, config/testing docs, canonical spec sync.
