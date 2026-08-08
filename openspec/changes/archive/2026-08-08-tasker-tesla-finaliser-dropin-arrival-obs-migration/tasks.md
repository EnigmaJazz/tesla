# Tasks: Finaliser Dropin/Arrival Observation Migration

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~250–320 (Finaliser ~70, Publisher ~50, new test ~170, AGENTS.md ~3) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR (work-unit commits: RED test → GREEN impl → AGENTS.md codes) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Serial REDUCER_BATCH merge: test + Finaliser + Publisher + log codes | PR 1 | `node harness/test_serial_finaliser_batch.js`; regression: `for f in harness/test_*.js; do node $f; done` | serial-mode harness (`sandbox.stateCommand` after router) proxies the serial Tasker chain; on-device persistence check is manual post-merge, not a harness step | revert Finaliser staging + Publisher serial branch, delete the new test, drop 3 AGENTS.md codes — no reducer/state unwind |

## Phase 1: RED — serial-mode harness proof (test-first)

- [x] 1.1 Create `harness/test_serial_finaliser_batch.js` mirroring `harness/test_serial_batch.js` (`serialMode: true`, no shims): Finaliser pass staging `COMPLETE_DROPIN` then `OBSERVE_ARRIVAL` then candidate → assert one `stateCommand('REDUCER_BATCH')` applies both obs in order, candidate `par1` primary-last, `REDUCER_BATCH_DELIVERED` count=3 skipped=0, no `BATCH_ENVELOPE_REJECTED`. (REQ-6F2-4, SCN-6F2-7) — RED: fails pre-fix (last-wins clobber).
- [x] 1.2 Add parity sections: no-obs pass stages plain `RECONCILE_GENERATION` (SCN-6F2-5); invalid genId pass → `OBS_BATCH_FLUSH_SKIPPED`, no envelope staged (SCN-6F2-3). (REQ-6F2-2, REQ-6F2-3)

## Phase 2: GREEN — implementation

- [x] 2.1 `Finaliser.js`: add `observedReducerCommands` accumulator + byte-copied `STATE_CMD_GEN_REGEX`; convert `COMPLETE_DROPIN` (:143-156) and `observeArrival` (:51-58) to gen-check → push `{command,payload}` (invalid genId → flash `OBS_BATCH_FLUSH_SKIPPED` with per-obs `tripId`, not pushed) + shim-deliver via `reducer()` when present; after loop (:180) stage `tds_obs_batch_par1='OBSERVATION_BATCH'` + `par2`=JSON when non-empty; `publishCandidate` (:224) and release chain (:261-309) untouched. (REQ-6F2-1 SCN-6F2-2, REQ-6F2-2 SCN-6F2-3)
- [x] 2.2 `Generation_Publisher.js` serial branch (:219-223): read `tds_obs_batch_par2`; when present re-stamp each `payload.generationId=genId`, keep first 31 (excess → `OBS_BATCH_TRUNCATED`), stage `REDUCER_BATCH` = `[RECONCILE_GENERATION, ...obs]` + `OBS_BATCH_MERGED`; else plain `RECONCILE_GENERATION` byte-identical; both branches and shim branch (:212-218) clear `tds_obs_batch_par1/par2`. (REQ-6F2-3 SCN-6F2-4/5/6)

## Phase 3: Verification

- [x] 3.1 Run new test green, then full suite `for f in harness/test_*.js; do node $f; done`: E2-2 (`test_single_writer.js:582`), AC-5 (`test_ac5.js:415`), `testFinaliserCutover` (`test_atomic_publication.js:321`) stay green; confirm shim-mode dual-path preserved. (REQ-6F2-1/4, regression)

## Phase 4: Documentation

- [x] 4.1 `AGENTS.md`: add `OBS_BATCH_FLUSH_SKIPPED`, `OBS_BATCH_TRUNCATED`, `OBS_BATCH_MERGED` to required event codes.

**Post-merge note (not a task)**: one-time manual device confirmation that `tds_obs_batch_par1/par2` persist across Tasker task invocations (positive `tds_release_par1/par2` precedent), recommended before archive. tripId decision resolved: per-obs `tripId` carried in `OBS_BATCH_FLUSH_SKIPPED` (task 2.1).
