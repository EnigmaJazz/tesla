# Tasks: Phase 6 Follow-ups (Batch Staging & Non-Base Departure)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | PR1 ~340-380; PR2 ~80-120; PR3 ~70-100 |
| Chained PRs recommended | Yes |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | FU1 core: batch staging, router+reducer, adapters | PR 1 | `node harness/test_serial_batch.js` | serial-mode Sandbox → one router call | revert accumulation + `REDUCER_BATCH` route |
| 2 | Finaliser obs onto batch (D5) | PR 2 | `node harness/test_state_command.js` | serial-mode Finaliser; release primary-last | revert Finaliser migration |
| 3 | FU2 departure edge + guard | PR 3 | `node harness/test_ac5.js` | active-leg window, non-base head leg | drop edge trigger + guard |

## PR 1 — FU1 Core (RED → GREEN)

- [x] 1.1 `harness/mock_tasker.js` (:94-103): add `serialMode`: no `reducer`/`handler`/`publish`, `setLocal` only (REQ-6FU-1, SCN-6FU-1A)
- [x] 1.2 Create `harness/test_serial_batch.js` (RED): serial-mode Sandbox staging LIVE_BASE/COMPLETE_TRIP/STATUS/HALT → one router call → only halt lands (REQ-6FU-1, SCN-6FU-1A)
- [x] 1.3 `Sandbox_Engine.js` `stageReducerCommand` (:432-438): append `{command,payload}` per pass; pass end (after :897) stage `REDUCER_BATCH` `par2={generationId,commands}` (REQ-6FU-1, SCN-6FU-2)
- [x] 1.4 `TDS_State_Command.js`: `REDUCER_BATCH` in `REDUCER_COMMANDS` (:39-42) + fields (:57-80); `validateCommand` (:115-173): non-empty array, entries `{command∈REDUCER_COMMANDS,≠REDUCER_BATCH,payload}`, nested parity; reject → `BATCH_ENVELOPE_REJECTED` no-mutation; size constant (REQ-6FU-3, REQ-4CMD-1, SCN-6FU-6/7, SCN-4CMD-3)
- [x] 1.5 `Trip_State_Reducer.js`: `REDUCER_BATCH` in `COMMANDS` (:296-321); `applyBatch` loops validate+apply, skip+log (`BATCH_SUBCOMMAND_REJECTED`), single commit+project; log delivered (REQ-6FU-2, SCN-6FU-4/5)
- [x] 1.6 GREEN: `test_serial_batch.js` passes — all observations land in order (SCN-6FU-2)
- [x] 1.7 `Depart_Now.js` (:27-43): batch `[{OBSERVE_LATENESS_HALT},{DEPART_NOW}]` primary last (REQ-6FU-4, SCN-6FU-8)
- [x] 1.8 `Return_to_Base.js` (:83-115): batch `[{OBSERVE_STATUS},{OBSERVE_LATENESS_HALT},{RETURN_TO_BASE}]` primary last (REQ-6FU-4)
- [x] 1.9 `test_state_command.js`: router rejects missing/non-array `commands`, nested, oversized → no write (SCN-6FU-6); partial-failure bad `COMPLETE_TRIP` in valid pair (SCN-6FU-4/5); nested parity (SCN-6FU-7)
- [x] 1.10 Full `node harness/test_*.js` → 28/28 + new green

## PR 2 — FU1 Finaliser (D5 GATE)

- [x] 2.0 D5: user chose (b) defer Finaliser — record deferral (task 2.4); no Tasker wiring change
- [ ] 2.1 (a) `Finaliser.js` (:143-172): move `COMPLETE_DROPIN`+`OBSERVE_ARRIVAL` onto `REDUCER_BATCH` in `tds_obs_batch`; publish stays `par1` (:224), `tds_release` rule (:268-293) primary last (REQ-6FU-4, SCN-6FU-9)
- [ ] 2.2 (a) Tasker task-loop: third handoff draining `tds_obs_batch` → router (REQ-6FU-4, SCN-6FU-9)
- [ ] 2.3 (a) Integration test: serial-mode Finaliser → publish primary-last, obs delivered (SCN-6FU-9)
- [x] 2.4 (b) DEFERRED: Finaliser dropin/arrival obs becomes its own follow-up change (D5 user decision 2026-08-08)

## PR 3 — FU2 Tail (never before PR 1)

- [x] 3.1 `Sandbox_Engine.js` (:612-632): if `!currentlyAtBase && !prevAtBase && leaveSec>0` head leg in window, stage `OBSERVE_DEPARTURE` `oldItin[0].targetEventId` (REQ-6FU-5, REQ-6STATE-4, SCN-6FU-10, SCN-6STATE-8)
- [x] 3.2 Once-per-leg guard: skip when last `departures[]` matches day/window; exclusive with base-leave (:574-591) (REQ-6FU-5, SCN-6FU-11)
- [x] 3.3 Tests: SCN-6FU-10 observed once; SCN-6FU-11 re-entry no stage/pollution; base-leave not double-observed (REQ-6FU-5)
- [x] 3.4 Suite regression `node harness/test_*.js`

## Docs

- [ ] 4.1 Archive canonical-sync note: §9 CMD-9, REQ-4CMD-1, REQ-6STATE-4
