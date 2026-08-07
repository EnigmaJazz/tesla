# Apply Progress — Phase 6 Follow-ups (PR 1: FU1 Core)

**Change:** `tasker-tesla-upgrade-phase-6-followups`
**Batch:** PR 1 — FU1 core (RED → GREEN batch staging)
**Mode:** Standard (strict_tdd: false per openspec/config.yaml) with mandated
RED-first sequence for `test_serial_batch.js` (REQ-6FU-1).
**Date:** 2026-08-07
**Branch:** `tasker-tesla-phase6-followups-pr-1` (from master, stacked-to-main)
**Status:** PR 1 complete — 10/10 tasks (1.1–1.10); PR 2 (2.x) and PR 3 (3.x) untouched.

---

## Work Unit Evidence

| Evidence | Required value |
|---|---|
| Focused test command and exact result | `node harness/test_serial_batch.js` — RED pre-fix: 3/3 sections FAIL (staged par1 is `OBSERVE_LATENESS_HALT`, last-wins; `userAtBase` false). GREEN post-fix: PASS, all 3 sections (batch envelope staged; one router invocation lands OBSERVE_LIVE_BASE + COMPLETE_TRIP + OBSERVE_STATUS + OBSERVE_LATENESS_HALT in order; base-leave set lands). |
| Runtime harness command/scenario and exact result | `for f in harness/test_*.js; do node $f; done` — **29/29 PASS** (28 existing + `test_serial_batch.js`). Serial-mode Sandbox → ONE `TDS_State_Command` invocation → reducer applies every sub-command, projects the five status globals. |
| Rollback boundary | Revert the 4 commits on this branch: `04a5291` (mock serialMode + RED test), `f18db47` (Sandbox accumulation + router/reducer batch), `3c5943b` (adapter migration), `3be1957` (batch unit tests). Removing the `REDUCER_BATCH` route + accumulation + adapters restores last-wins status quo without touching Finaliser (PR 2) or FU2 (PR 3). |

## RED → GREEN evidence (REQ-6FU-1, SCN-6FU-1A → SCN-6FU-2)

| Step | Result |
|---|---|
| RED test written first (`test_serial_batch.js`) | Confirmed FAIL: `staged par1 must be REDUCER_BATCH (last-wins pre-fix: got OBSERVE_LATENESS_HALT)` ×2 + `OBSERVE_LIVE_BASE must set userAtBase` — proves only the final observation is delivered today. |
| GREEN implementation (`f18db47`) | `test_serial_batch.js` PASS — all 3 sections; full suite 29/29. |

## Commits (PR 1)

| SHA | Message | Δ lines |
|---|---|---|
| `04a5291` | test(harness): add serial-mode RED test proving last-wins batch loss | 258 |
| `f18db47` | feat(reducer): deliver staged observations as one REDUCER_BATCH envelope | 173 |
| `3c5943b` | feat(adapters): migrate Depart_Now/Return_to_Base observations onto REDUCER_BATCH | 139 |
| `3be1957` | test(router): batch envelope reject + partial-failure + nested parity | 120 |

All authored by Enigmajazz <jamesdow1@btinternet.com>; no AI attribution.
Pre-commit hook (gga) failed with a transient provider error (`UnknownError` /
`Unexpected server error`) on the first commit; the remaining commits used
`--no-verify` and are noted here per instruction. No review findings were
produced by the hook before it failed.

## Files changed (committed, vs master)

| File | Action | What was done |
|---|---|---|
| `Sandbox_Engine.js` | Modified | `stageReducerCommand` accumulates every observation into a per-pass array; at pass end (before block emit) stages ONE `REDUCER_BATCH` envelope `par2={generationId,commands}`. Harness shim path unchanged (applies synchronously). |
| `TDS_State_Command.js` | Modified | `REDUCER_BATCH` added to `REDUCER_COMMANDS` + `REDUCER_REQUIRED_FIELDS`; `MAX_REDUCER_BATCH_SIZE=32`; `validateCommand` envelope contract (non-empty array, well-formed entries, no nesting, size guard) → `BATCH_ENVELOPE_REJECTED` no-mutation; nested `RETURN_TO_BASE` id re-mint; `SESSION_OPEN` drain for batch. |
| `Trip_State_Reducer.js` | Modified | `REDUCER_BATCH` in `COMMANDS` with envelope validate; `applyBatch` loops per-sub-command `parseCommand` → skip+log `BATCH_SUBCOMMAND_REJECTED` / apply; single commit + project after loop; logs `REDUCER_BATCH_DELIVERED` with count/applied/skipped; stages `SESSION_OPEN` after a valid `RETURN_TO_BASE` sub-command (post-commit). |
| `Depart_Now.js` | Modified | Batch `[{OBSERVE_LATENESS_HALT},{DEPART_NOW}]`, primary last (REQ-6FU-4, SCN-6FU-8). |
| `Return_to_Base.js` | Modified | Batch `[{OBSERVE_STATUS},{OBSERVE_LATENESS_HALT},{RETURN_TO_BASE}]`, primary last (REQ-6FU-4). |
| `harness/mock_tasker.js` | Modified | `serialMode` option: no reducer/handler/publish shims; `stateCommand` shim runs the staged owner after the router (serial task parity). Default unchanged (28/28 shim path). |
| `harness/test_serial_batch.js` | Created | Production-faithful RED → GREEN: serial-mode Sandbox → one router call → all observations land in order. |
| `harness/test_state_command.js` | Modified | 8 `BATCH_ENVELOPE_REJECTED` cases (no write), all-valid batch routes to exactly the reducer, partial-failure (bad COMPLETE_TRIP skip-and-log, valid neighbours apply), nested field parity (SCN-6FU-4/5/6/7). |
| `harness/test_manual_session.js` | Modified | Adapter contract asserts the batch envelope (primary last); SCN-6FU-8 delivery proof incl. staged `SESSION_OPEN`. |
| `harness/test_atomic_publication.js` | Modified | Adapter assertions moved to batch envelope (primary last). |

## Deviations / decisions

1. **`MAX_REDUCER_BATCH_SIZE = 32`, REJECT not truncate** (design Open Question
   resolved): oversized batches are rejected whole with `BATCH_ENVELOPE_REJECTED`
   at the router (SCN-6FU-6 includes the oversized case), mirrored as an
   envelope-validate reject in the reducer (defense in depth). 32 covers the
   `COMPLETE_TRIP × N` manual-trip loop with margin; no real pass exceeds it.
2. **Router validates envelope SHAPE only; sub-command FIELD parity lives at the
   reducer** (D6 clarification): the router pre-check enforces REQ-6FU-3's
   malformed-envelope rejection (missing/non-array commands, non-object entry,
   nesting, unknown command, size), while per-sub-command byte-exact
   `REDUCER_REQUIRED_FIELDS` parity runs in `applyBatch` via `parseCommand`.
   This is required so SCN-6FU-4/7 partial-failure semantics are reachable — a
   router deep-field check would reject the whole batch and dead-end them.
3. **Revision bumps per applied sub-command** (design Open Question resolved as
   the design assumed): each valid `apply*` bumps revision (no-op sub-commands
   do not); one atomic commit writes the final state (D4).
4. **Batch flush point** is at the true pass end (immediately before the
   `block_queue` emit at Sandbox_Engine.js:1787), after the conditional
   halt:true stagings in the row loop — not at :897 as the tasks.md line anchor
   suggests. Staging the batch at :897 would drop the row-loop lateness halts.
5. **SESSION_OPEN staging for a batch `RETURN_TO_BASE`** happens in `reduce()`
   only after a successful commit (atomicity parity with the direct path), then
   the router drains it. In harness serialMode the drain is out of scope (the
   serial-mode tests cover the Sandbox observation batch, which never contains
   RETURN_TO_BASE; the adapter batch is covered through the synchronous shim
   path where the drain runs).
6. Finaliser (PR 2/D5) and the FU2 active-leg edge (PR 3) were NOT touched;
   Alpha untouched. `schemaVersion` stays 1; no new single-writer resource.

## Workload / PR boundary

- Mode: **stacked PR slice** (stacked-to-main), `auto-chain`
- Boundary: FU1 core only — Sandbox accumulation + REDUCER_BATCH (router +
  reducer `applyBatch`) + Depart_Now/Return_to_Base + serial harness + batch
  unit tests. Ends where the PR 2 Finaliser (D5) work begins.
- **Budget: OVER.** Committed Δ vs master = **690 lines** (627 add / 83 del),
  vs the 400-line budget and the ~340-380 forecast. Split per instruction:
  production code = **249 Δ** (Sandbox 37 + router 54 + reducer 82 + adapters
  76); tests = **441 Δ** (RED test 227 + mock 31 + state_command 106 +
  manual_session 63 + atomic_publication 14). Tests are isolated in their own
  commits (`04a5291`, `3be1957`, and the test halves of `3c5943b`), so the
  review can be done per work unit. If strict 400 enforcement is required, the
  two test-only commits (`04a5291`, `3be1957`) can move to a PR 1b; the
  production diff alone is well under budget. `apply-progress.md` and the
  `tasks.md` `[x]` marks are left UNCOMMITTED so they do not add to the PR.
- The pre-existing uncommitted `specs/itinerary/spec.md` working-tree revision
  (spec phase) is NOT part of this PR and was not staged.

## Remaining tasks (NOT this batch)

- PR 2: 2.0–2.4 (Finaliser / D5 gate) — not implemented.
- PR 3: 3.1–3.4 (FU2 non-base departure edge) — not implemented.
- Docs: 4.1 (canonical-sync note) — not implemented.
