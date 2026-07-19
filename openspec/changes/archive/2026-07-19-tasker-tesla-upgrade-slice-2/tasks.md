# Tasks: tasker-tesla-upgrade-slice-2

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Low

- [x] 1. Action: Change `Sandbox_Engine.js:438-449` per design §2.1 (INV-0.3, AC-6): consult live base with stale itinerary, approximate IN_PROGRESS by `Current_Status`, and flash only on contradiction. Files: `Sandbox_Engine.js`. Verify: lines 264-388 unchanged. Done when: AC-6 passes; Patch D commit body cites fresh-pass behavior and regex approximation.
- [x] 2. Action: Change queue emission per design §2.2 (INV-0.1, AC-1): append policy as column 19, reserve 17–18, and set head `block_step19`; include all row kinds. Files: `Sandbox_Engine.js`. Verify: `~`/`|` splitting preserves fields 1–16. Done when: every row has ASAP/JIT and chains promote ASAP.
- [x] 3. Action: Create AC-6 harness per §2.4 (INV-0.3, AC-6), seeding handled stale leg, live base, arrival time, home geocode, and future event. Files: `harness/test_sandbox_ac6.js`, `harness/README.md`. Verify: `node harness/test_sandbox_ac6.js` prints the specified PASS line. Done when: flash and home origin assert.
- [x] 4. Action: GGA-review and commit Patch D as `feat(sandbox): explicit departurePolicy + live origin (AC-1 emit, AC-6)`, citing MODIFIED INV-0.1/AC-1/AC-6. Files: Sandbox and AC-6 harness files. Verify: `git log --oneline`; fix new findings before any approved `--no-verify`. Done when: commit exists.
- [x] 5. Action: Run fresh-lineage gentle-ai review for Patch D (`--base-ref 33e070f --committed-only --projection staged`), then capture/finalize/validate. Files: `openspec/.../apply-progress.md`. Verify: receipt or documented manual readability review if system remains broken. Done when: Patch D is bound or documented.
- [x] 6. Action: Change `Compiler.js:245-260` per §3.1 (INV-0.1, AC-1) to consume `local('block_step19')`, persist policy, and flash `DEPARTURE_POLICY_FALLBACK_USED` before ASAP fallback. Files: `Compiler.js`. Verify: hardFloor lines 200-204 preserved. Done when: AC-1 passes; Patch E body cites migration safety.
- [x] 7. Action: Remove `isPrevBase` reconstruction at `Compiler.js:158-172` (INV-0.1) and read explicit previous-leg policy. Files: `Compiler.js`. Verify: no pitstop/`_IN`/EOD inference; legacy chain math remains safe. Done when: legacy fixtures retain hardFloor behavior.
- [x] 8. Action: Create AC-1 harness per §3.4 (INV-0.1, AC-1), testing `block_step19=ASAP` and `JIT`. Files: `harness/test_compiler_ac1.js`, `harness/README.md`. Verify: specified PASS line from `node harness/test_compiler_ac1.js`. Done when: ASAP=`hardFloor`, JIT=`Math.max(hardFloor, depTarget)` and no steady-state fallback flash.
- [x] 9. Action: GGA-review and commit Patch E as `fix(compiler): consume explicit departurePolicy; remove isPrevBase reconstruction (AC-1)`, citing MODIFIED INV-0.1/AC-1. Files: Compiler and AC-1 harness files. Verify: no new silent fallback, magic number, or unstructured event. Done when: commit exists.
- [x] 10. Action: Run Patch E gentle-ai review and pre-commit validation using Task 5’s caveat. Files: `openspec/.../apply-progress.md`. Verify: bound receipt or documented manual review. Done when: Patch E is bound or documented.
- [ ] 11. Action: Run design §5 manual Tasker checks (INV-0.1/0.3, AC-1/AC-6): live base wins; ASAP uses hardFloor; JIT uses max. Files: Android Tasker runtime only. Verify: inspect flashes and itinerary. Done when: user signs off.

## Workload forecast (final)

- Patch D: ~150-200 lines (Sandbox_Engine.js ~70-110 + test ~120-160). Should fit under 400.
- Patch E: ~130-180 lines (Compiler.js ~30-50 + test ~100-130). Should fit under 400.
- Two chained PRs, one per patch.
