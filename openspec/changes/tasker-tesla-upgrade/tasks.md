- [x] 1. Action: Apply the Compiler.js stop-padding fix per design §2.
   Files: Compiler.js (lines 60-100, plus 230-260, 300-320 if any of those need a touch — design says they do NOT, but read the file before deciding).
   Verify: After the edit, `git diff Compiler.js` shows the `duration += stopPadSecs` line removed, no new lines added, and lines 241 and 308 unchanged.
   Done when: AC-8 passes: `pendingStopsRaw="5,10"` yields route-only `durationSecs` and advances the next `depTarget` by exactly 15 minutes, not 30.
   Work unit: one commit, conventional type `fix`, scope `compiler`, subject `fix(compiler): route-only durationSecs; stop padding once (AC-8)`. Body cites `MODIFIED INV-0.8` and `AC-8`, and notes Sandbox `adHocObj.secs` is out of scope.

- [x] 2. Action: Run `git commit` on Patch A and let the GGA pre-commit hook review against AGENTS.md.
   Files: Compiler.js (modified by task 1).
   Verify: GGA accepts; fix only blocking AGENTS.md findings and re-run review. Do not change the user's identity: `Enigmajazz <jamesdow1@btinternet.com>`.
   Done when: `git log --oneline` shows the Patch A commit with no follow-up fixes required.

- [ ] 3. Action: Run `gentle-ai review validate --gate pre-commit --cwd . --lineage tasker-tesla-upgrade` to bind Patch A's receipt.
   Verify: The command exits 0 and emits a terminal receipt.
   Done when: The receipt is bound and its hash is recorded by the orchestrator.

- [ ] 4. Action: Apply the Dispatcher.js fix per design §3.
   Files: Dispatcher.js (lines 30-60, 200-230, plus top-of-file for `IDLE_SYNC_MINS`).
   Verify: `git diff Dispatcher.js` shows `const IDLE_SYNC_MINS = 60;`, stale departures skipped with `continue` and structured `STALE_DEPARTURE_REJECTED` flash event, idle sync first, and the negative-gap 3-minute branch removed.
   Done when: AC-9 and AC-10 pass. Commit as `fix(dispatcher): skip stale departures; idle sync at 60 min (AC-9, AC-10)`, citing `MODIFIED INV-0.6`, `AC-9`, and `AC-10`; note 60 minutes is the first-slice default and `relevanceDeadlineUnix` is deferred.

- [ ] 5. Action: Run `git commit` on Patch B and let GGA review against AGENTS.md.
   Files: Dispatcher.js (modified by task 4).
   Verify: The hook accepts; fix only blocking AGENTS.md findings.
   Done when: `git log --oneline` shows both Patch A and Patch B commits with no follow-up fixes required.

- [ ] 6. Action: Run `gentle-ai review validate --gate pre-commit --cwd . --lineage tasker-tesla-upgrade` to bind Patch B's receipt.
   Verify: The command exits 0 and the receipt binds both patches.
   Done when: Both patches have a bound terminal receipt.

- [ ] 7. Action: Run design §5's manual scenarios in a real Tasker instance.
   Scenarios: After Patch A, verify `#stop:5,#stop:5` advances the next departure by 10 minutes, not 20. After Patch B, test a first leg at `nowSec - 3600` (AC-9), an empty master (AC-10, 60-minute idle and `IDLE_SYNC_ENGAGED`), and a first leg at `nowSec + 600` (10-minute bucket).
   Verify: Capture `syncIntervalMins` and emitted event code for each observation.
   Done when: All AC-8/AC-9/AC-10 scenarios pass and the user signs off; the orchestrator documents checks that require the user's Android device.

## Workload forecast (final)

Total: 2 files, ~25-50 changed lines, 2 commits. Well under the 400-line review budget. Single PR is appropriate — no chained PR needed for the first slice. The user's "ask-always" chained-PR strategy is not triggered because the forecast is under budget.
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low
