- [x] 1. Action: Add isSameUTCDay and utcDayBoundaryUnix helpers near the other helpers in Sandbox_Engine.js.
   Files: Sandbox_Engine.js.
   Verify: After the edit, both helpers are defined and reference UTC date methods.
   Done when: A standalone Node script or test exercising known UTC timestamps passes.
   Work unit: combined with Task 2 into PR-A (single commit).

- [x] 2. Action: Replace the DST-unsafe sites per design §2.2; apply each listed fix or document why it is UTC-equivalent.
   Files: Alpha.js, Sandbox_Engine.js, Finaliser.js, Compiler.js, Dispatcher.js, Dashboard.js only if a day-boundary comparison is found.
   Verify: `grep -n 'getDate()' *.js` has no DST-unsafe sites and `grep -n 'setHours(0,0,0,0)' *.js` has no matches.
   Done when: AC-3 and AC-7 still pass and the new DST test passes.
   Work unit: combined with Tasks 1 and 3 into PR-A (single commit).

- [x] 3. Action: Create UK BST→GMT and GMT→BST transition fixtures for the UTC helper and Sandbox boundary behavior.
   Files: harness/test_dst_utc.js (new), harness/README.md (updated).
   Verify: `node harness/test_dst_utc.js` exits 0 with `PASS: DST: UTC day-boundary math is correct across UK BST→GMT and GMT→BST transitions`.
   Done when: Both transitions and the design assertions pass.
   Work unit: combined with Tasks 1 and 2 into PR-A.

- [x] 4. Action: Run GGA review, then commit PR-A with the prescribed conventional message and body citing MODIFIED INV-0.2, AC-3, and AC-7.
   Files: Alpha.js, Sandbox_Engine.js, Finaliser.js, Compiler.js, Dispatcher.js, harness/test_dst_utc.js, harness/README.md.
   Verify: GGA reviews the commit; `--no-verify` is acceptable only for pre-existing out-of-scope issues.
   Done when: `git log --oneline` shows the PR-A commit.

- [x] 5. Action: Try gentle-ai review for tasker-tesla-upgrade-slice-3-pr-a; document manual review if the system remains broken.
   Files: apply-progress documentation only if needed.
   Verify: Bound receipt or documented manual review exists.
   Done when: PR-A is bound or documented.

- [ ] 6. Action: Add `setGlobal('TDS_Manual_Return_Completed', nowSec)` at the existing manual-return write point alongside the itinerary write.
   Files: Return_to_Base.js.
   Verify: The global is set alongside the Itin_Master.json write.
   Done when: The AC-5 test finds the global in the sandbox.
   Work unit: combined with Tasks 7-10 into PR-B (single commit).

- [ ] 7. Action: At Sandbox pass start, read the global; when it is from a previous day, force the head legPolicy to JIT, emit FUTURE_TRIP_NOT_DUE, and clear the one-shot signal.
   Files: Sandbox_Engine.js.
   Verify: The override is applied before normal policy selection.
   Done when: AC-5 passes.
   Work unit: combined with Tasks 6, 8, and 9 into PR-B.

- [ ] 8. Action: Create the manual-return-completed acceptance fixture and assertions for a future PLANNED/JIT first trip.
   Files: harness/test_ac5.js (new), harness/README.md (updated).
   Verify: `node harness/test_ac5.js` exits 0 with `PASS: AC-5: post-return future trip remains PLANNED/JIT`.
   Done when: The AC-5 scenario and FUTURE_TRIP_NOT_DUE assertion pass.
   Work unit: combined with Tasks 6, 7, and 9 into PR-B.

- [ ] 9. Action: Emit SYNTHETIC_RETURN_SUPPRESSED when the Sandbox EOD-skip path is taken on an empty day with the user away.
   Files: Sandbox_Engine.js.
   Verify: The event appears in the empty-day scenario.
   Done when: AC-4 still passes and the event is documentation only.
   Work unit: combined with Tasks 6, 7, and 8 into PR-B.

- [ ] 10. Action: Run GGA review, then commit PR-B with the prescribed conventional message and body citing MODIFIED INV-0.5 and AC-5.
   Files: Return_to_Base.js, Sandbox_Engine.js, harness/test_ac5.js, harness/README.md.
   Verify: GGA reviews the commit; `--no-verify` is acceptable only for pre-existing issues.
   Done when: `git log --oneline` shows the PR-B commit.

- [ ] 11. Action: Try gentle-ai review for tasker-tesla-upgrade-slice-3-pr-b; document manual review if unavailable.
   Files: apply-progress documentation only if needed.
   Verify: Bound receipt or documented manual review exists.
   Done when: PR-B is bound or documented.

- [ ] 12. Action: Run design §5 manual scenarios on the Android device: BST→GMT fixture after PR-A and a manual return completed yesterday after PR-B.
   Files: Android device/runtime only; no repository files.
   Verify: INV-0.2, AC-3, AC-5, and AC-7 behavior is observed.
   Done when: User signs off.

## Workload forecast (final)
- PR-A: ~400-600 lines; fit under 400-line review budget only with careful refactor, otherwise split.
- PR-B: ~300-500 lines; fit under 400-line review budget where possible.
- Two chained PRs: PR-A (DST fix) → PR-B (manual-return signal + AC-5).

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
