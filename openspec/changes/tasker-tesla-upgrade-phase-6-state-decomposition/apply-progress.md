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
