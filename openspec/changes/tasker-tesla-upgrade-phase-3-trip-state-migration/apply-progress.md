# Phase 3 Trip-State Migration — Apply Progress

## PR-A: reducer shell and command contract

- **PR URL:** https://github.com/EnigmaJazz/tesla/pull/13
- **Merge SHA:** `4c9f4ad`
- **Branch:** `phase-3-pr-a` (deleted after merge)
- **Worktree:** `/home/james/ai-workspace/tasker/tesla-worktrees/phase-3-pr-a` (removed)

## Files touched

| File | Action | Notes |
|------|--------|-------|
| `Trip_State_Reducer.js` | created | 204 lines. Reducer shell, 13-command protocol, schema v1/revision 0, write+read-back, structured logging. |
| `harness/mock_tasker.js` | modified | +19/-1 lines. Added `reducer` shim and sole-writer guard for `TDS_Trip_State.json`. |
| `harness/test_reducer_commands.js` | created | 128 lines. Contract, validation, versioning, atomicity, observability, and same-tick reload tests. |

**Total diff:** 350 lines (≤ 400 line budget).

## Spec requirements addressed

- R-TRIP-1 (partial): sole-writer contract enforced by harness mock.
- R-TRIP-3: 13-command typed schemas validated; invalid commands rejected with `GENERATION_VALIDATION_FAILED`.
- R-TRIP-11.1: `TDS_Trip_State.json` written with `schemaVersion: 1` and `revision: 0`.
- R-TRIP-12.1/12.2 (partial): atomic write/read-back path before projection; structured JSON logging.

## Test evidence

- All 9 baseline harness tests pass (no regression).
- New `harness/test_reducer_commands.js` passes (8 sub-scenarios).
- GGA pre-commit review passed for the reducer shell.

## Lessons learned

1. **Worktree index corruption from .atl skill-registry.** Loading the SDD skills updated `.atl/.skill-registry.cache.json` and `.atl/skill-registry.md` in the worktree. The staged changes left a corrupt cache-tree in the index, causing `git commit` to fail with `invalid object`. The fix was to remove the worktree index and run `git read-tree HEAD` to rebuild it from scratch.
2. **Top-level `const` in vm-rerun scripts.** Because the harness runs `Trip_State_Reducer.js` multiple times in the same `vm` context, top-level `const` declarations cause redeclaration errors on the second run. The GGA advisory flagged this as a `var` vs `let/const` style issue; the underlying reason is test-harness re-entry, not legacy style. The reducer uses `var` for top-level immutable constants to stay re-runnable, while function bodies keep `let`/`const`.
3. **Event code prefix alignment.** The initial draft used `EVT-GENERATION_VALIDATION_FAILED`. The AGENTS.md hard-rule code list uses `GENERATION_VALIDATION_FAILED` (no prefix). The reducer now emits the canonical code for spec-required events; non-spec codes (e.g., `STATE_RESTORED_AFTER_READBACK_FAILURE`) are kept without the `EVT-` prefix.
4. **Read-back restore.** The first commit draft caught `writeWithReadback` failures but did not restore the previous state bytes. The design contract promises rollback, so `commit(oldRaw, newState)` now rewrites the old raw bytes on failure and logs the event before returning the error.

## Next recommended step

- Apply PR-B (origin precedence / live base override / OVR key migration) or move to verification of PR-A, depending on the orchestrator's planned batch.
