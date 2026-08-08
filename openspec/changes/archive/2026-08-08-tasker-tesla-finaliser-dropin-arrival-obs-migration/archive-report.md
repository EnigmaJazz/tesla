# Archive Report — Finaliser Dropin/Arrival Observation Migration

**Change**: `finaliser-dropin-arrival-obs-migration`
**Archived**: 2026-08-08
**Status**: COMPLETE — all 6 tasks, 5/5 requirements, 10/10 scenarios, 31/31 harness green on master.

## Final State (at close)

Delivered as a stacked chain, all PRs reviewed (native gentle-ai lifecycle: consent → review-reliability lens → finalize → pre-pr gate allow) and merged to master on 2026-08-08:

| PR | Content | Merge |
|----|---------|-------|
| #43 | Serial-mode harness proof (test) | `d9a8e62` |
| #46 | Corrective test-fix (assertion alignment) | `6dbb57b` |
| #44 | Implementation (Finaliser + Publisher + AGENTS.md) | `d67c108` |
| #45 | SDD planning/verification docs (size:exception) | `b779ed5` |

- PR #46 was required because PR #43 carried the original RED test whose strict assertions (`strictEqual('')` on never-set locals; burst section reading `logs` before `stateCommand`) failed 2/6 even against the correct implementation. The apply-final assertion wording is the shipped state.
- Master final state: **31/31 harness tests green** (verified after all merges).
- Canonical spec synced: REQ-6F2-1..4 (ADDED), REQ-6FU-4 MODIFIED (Finaliser migration in scope, D5 annotation removed), SCN-6FU-12 added — `openspec/specs/itinerary/spec.md`.

## Known Issues (non-blocking)

1. **R3-LET-REDECLARATION (reviewer WARNING, merged content).** Module-level `let observedReducerCommands = []` (Finaliser.js:37) contradicts the documented shared-vm `var` convention (the same patch declares `STATE_CMD_GEN_REGEX` with `var` for that reason). No current test re-runs Finaliser twice in one sandbox, so the suite is green; a future test re-running the script in a shared context would hit `SyntaxError: Identifier 'observedReducerCommands' has already been declared`. Convert to `var` in a future cleanup.
2. **Pending manual step (device).** One-time on-device confirmation that `tds_obs_batch_par1/par2` persist across Tasker task invocations (positive `tds_release_par1/par2` precedent) before final production rollout. Recorded in design.md Open Questions and verify-report WARNING #1.

## Verification Evidence

- verify-report: PASS WITH WARNINGS (W1 device persistence check — above; W2 pre-commit GGA hook infra failure during apply; W3 authored-line forecast 452 vs ~250-320 — resolved via chain split).
- Reviewer evidence per PR: clean results (0 findings) for #43/#46/#45; #44 carried only the R3-LET-REDECLARATION WARNING (non-blocking, recorded above).
- Master suite: `node harness/test_*.js` → 31/31 PASS, 0 FAIL.

## Rollback

Revert the four PR merges in reverse order (45, 44, 46, 43); the change is byte-localized to Finaliser.js, Generation_Publisher.js, the new serial test, AGENTS.md event codes, and SDD artifacts. No TDS_State_Command / Trip_State_Reducer / Sandbox_Engine / Tasker task-loop changes exist to unwind.
