# Design: Phase 6 Follow-ups — Batch Staging & Non-Base-Origin Departure Observation

## Technical Approach

FU1 replaces the serial last-wins `par1/par2` slot with a single `REDUCER_BATCH`
envelope. `Sandbox_Engine.stageReducerCommand` accumulates every observation
staged in one pass into a per-pass array; at pass end it stages ONE
`REDUCER_BATCH` with `par2={commands:[{command,payload},...]}` preserving order.
`TDS_State_Command` routes the envelope to the reducer as one owner entry; the
reducer `applyBatch` loops `validate→apply` per sub-command (skip-and-log invalid)
and commits once. Adapters (Depart_Now, Return_to_Base) build the full ordered
list with the primary command LAST inside the batch, so the primary-last
envelope contract is preserved semantically (primary is the last sub-command
applied) AND every secondary observation is delivered. FU2 (after FU1) adds an
edge-triggered `OBSERVE_DEPARTURE` to the Sandbox active-leg window for
non-base-origin JIT head legs, once-per-leg. Maps to REQ-6FU-1..5, SCN-6FU-1..11.

## Architecture Decisions

| # | Option | Tradeoff | Decision |
|---|--------|----------|----------|
| D1 | Batch envelope (vs queue-file / split-flush) | New command + nested validation; no Tasker wiring change, reducer stays sole writer, harness-provable | **Batch envelope.** Only option fixing production delivery without task-loop wiring (out of harness scope). Split-flush rejected: earlier envelopes lost to last-wins. |
| D2 | Adapter batch: everything-in-batch primary-last (vs primary direct + secondary batch) | A guarantees single handoff; B keeps "primary direct" but secondary batch is staged BEFORE primary → clobbered in serial → secondaries still lost | **Everything-in-batch, primary last inside the batch.** B defeats the batch in the serial model (the batch envelope would be the second-to-last `setLocal`, clobbered by the primary). A preserves the primary-last ordering *semantically* (primary is the last sub-command applied) and delivers everything in one serial handoff. |
| D3 | Partial-failure: apply-valid-in-order + log-and-skip (vs all-or-nothing) | All-or-nothing re-introduces pass-level loss (one bad `COMPLETE_TRIP` drops `OBSERVE_LIVE_BASE`); per-cmd observation independence | **Apply-valid-in-order, log-and-skip** with `BATCH_SUBCOMMAND_REJECTED`. |
| D4 | Batch commit: single commit+project after loop (vs per-sub-command commit) | Single = one atomic write, one projection, apply-valid-in-order at apply level; per-cmd = N writes + N projections, order-sensitive projection churn | **Single commit + single project after the apply loop.** Preserves the commit/project *discipline* (validate-before-mutate, read-back, project-gated-on-commit) without N writes. Partial-failure is at the apply/validate level, not the write level. |
| D5 | Finaliser dropin/arrival: dedicated `tds_obs_batch` slot + 3rd handoff (vs defer to follow-up) | 3rd handoff brushes the "no task-loop wiring changes" non-goal; deferral leaves dropin completion lost in production | **Decision Needed before apply** (see Open Questions). Recommended: defer Finaliser to slice 1b; slice 1a = Sandbox + Depart_Now + Return_to_Base (zero wiring change). |
| D6 | Nested validation: byte-exact `REDUCER_REQUIRED_FIELDS` parity at router AND reducer (vs reducer-only) | Router pre-check guarantees REQ-4CMD-1 no-mutation-on-reject; reducer re-validates (defense in depth, owner authority) | **Both.** Router rejects malformed envelope with `BATCH_ENVELOPE_REJECTED` (no mutation); reducer re-validates each sub-command, logs `BATCH_SUBCOMMAND_REJECTED` per invalid. |

## Data Flow

```
Sandbox pass / Adapter
  │  stageReducerCommand → local array (per-pass scope)
  └──► pass end: setLocal('par1','REDUCER_BATCH')
       setLocal('par2', {generationId, commands:[{command,payload},...]})
                              │
         serial Tasker: ONE TDS_State_Command invocation
                              ▼
       TDS_State_Command.validateCommand
         ├─ envelope ok  → route to Reducer (one owner entry)
         └─ envelope bad → BATCH_ENVELOPE_REJECTED (no mutation)
                              ▼
       Trip_State_Reducer.applyBatch
         for each sub-command: validateFields → apply (skip+log invalid)
         single commit (read-back) → single project()
         REDUCER_BATCH_DELIVERED
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `Sandbox_Engine.js` | Modify | `stageReducerCommand` (:432-438) appends to a per-pass array instead of clobbering `par1/par2`; at pass end (after :897 halt-reset, before block emit) stage ONE `REDUCER_BATCH`. FU2: edge-triggered `OBSERVE_DEPARTURE` in active-leg window (:612-632) when `!currentlyAtBase && leaveSec>0 && window`. |
| `TDS_State_Command.js` | Modify | Add `REDUCER_BATCH` to `REDUCER_COMMANDS` (:39-42) + `REDUCER_REQUIRED_FIELDS` (:57-80) envelope contract; special-case envelope + nested parity in `validateCommand` (:115-173); size guard `MAX_REDUCER_BATCH_SIZE`. |
| `Trip_State_Reducer.js` | Modify | Add `REDUCER_BATCH` to `COMMANDS` (:296-321); `applyBatch` loops `parseCommand`/`validateFields`+`apply*` per sub-command (skip+log `BATCH_SUBCOMMAND_REJECTED`), single `commit`+`project`; log `REDUCER_BATCH_DELIVERED`. |
| `Depart_Now.js` | Modify | Build batch `[{OBSERVE_LATENESS_HALT}, {DEPART_NOW}]` (primary last) → one `REDUCER_BATCH` setLocal; removes the sacrificed-observation comment (:27-43). |
| `Return_to_Base.js` | Modify | Batch `[{OBSERVE_STATUS}, {OBSERVE_LATENESS_HALT}, {RETURN_TO_BASE}]` (primary last) → one `REDUCER_BATCH` (:83-115). |
| `Finaliser.js` | Modify (slice 1b, D5) | Migrate clobbered `COMPLETE_DROPIN` (:143-149) + `OBSERVE_ARRIVAL` (:167-172) onto a `REDUCER_BATCH`; keep publish candidate in `par1` (:224) and `tds_release_par1/par2` mid-chain rule (:268-293). Needs dedicated slot — see D5. |
| `harness/mock_tasker.js` | Modify | Add `serialMode` option: when true, do NOT inject `reducer`/`handler`/`publish` as functions (set `undefined`) so `stageReducerCommand`'s `typeof reducer === 'function'` is false → only `setLocal` runs. |
| `harness/test_serial_batch.js` | Create | Production-faithful RED: serial-mode Sandbox run (no shim) → one `TDS_State_Command` invocation → assert all observations land. FAILS pre-fix (last-wins), PASSES post-fix. |
| `openspec/changes/.../specs/itinerary/spec.md` | — | (exists) REQ-6FU-1..5, SCN-6FU-1..11. |

## Interfaces / Contracts

`REDUCER_BATCH` envelope (staged in `par1/par2`):

```js
// par1
"REDUCER_BATCH"
// par2
{
  generationId: "gen:1700000000:ab12",       // required, GEN_REGEX
  commands: [                                // required, non-empty array
    { command: "OBSERVE_LIVE_BASE", payload: { generationId, at } },
    { command: "COMPLETE_TRIP",     payload: { generationId, tripId, at, planningDay } },
    { command: "OBSERVE_STATUS",    payload: { generationId, status, at } }
  ]                                          // length <= MAX_REDUCER_BATCH_SIZE (e.g. 32)
}
```

Router validation (`TDS_State_Command.validateCommand`, special-cased like
`ENQUEUE_REORDER`): `generationId` valid string; `commands` non-empty array;
each entry object with `command` (string, ∈ `REDUCER_COMMANDS`, ≠ `REDUCER_BATCH`
— nested batches forbidden) and `payload` (object); each sub-command validated
byte-exact against `REDUCER_REQUIRED_FIELDS` (nested parity, REQ-6FU-3).
Reject envelope → `BATCH_ENVELOPE_REJECTED`, no owner/file change.

Reducer `applyBatch(state, payload)`: loop `commands`; for each, `parseCommand`
→ if invalid, `logEvent("warn","BATCH_SUBCOMMAND_REJECTED", tripId, {command,
reason, index})` and skip; if valid, `apply` to running state. After loop:
single `commit(oldRaw, newState)` + `project(newState)` (existing discipline).
Log `REDUCER_BATCH_DELIVERED` with `{count, applied, skipped}`.

FU2 once-per-leg guard (Sandbox :612-632): before staging, read
`state.trips[tripId].departures[last]`; if it exists AND matches the current
`{planningDay, window-entry}` for this leg, skip (no `OBSERVE_DEPARTURE`, no
`departures[]` pollution — SCN-6FU-11). Guard against double observation of a
base-leave: the active-leg edge fires only when `!currentlyAtBase && !prevAtBase`
(non-base origin); the base-leave branch (:574-591) already covers
`!currentlyAtBase && prevAtBase`. Mutually exclusive `prevAtBase` conditions
prevent double observation.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Router envelope reject (missing commands / non-array / nested REDUCER_BATCH / oversized) | `test_state_command.js` reject cases → `BATCH_ENVELOPE_REJECTED`, no file write |
| Unit | Reducer partial-failure (malformed `COMPLETE_TRIP` between valid `OBSERVE_LIVE_BASE` + `OBSERVE_STATUS`) | SCN-6FU-4: skip+log, both valid apply in order |
| Unit | Reducer nested parity (sub-command failing `REDUCER_REQUIRED_FIELDS`) | SCN-6FU-7: byte-identical rejection to direct invalid command |
| Integration | Serial-faithful delivery: serial-mode Sandbox (no shim) → one `TDS_State_Command` → all observations land | New `test_serial_batch.js`: pre-fix FAILS (only last lands), post-fix PASSES (REDUCER_BATCH delivers all) |
| Integration | Adapter delivery (Depart_Now: halt+depart both reach reducer) | SCN-6FU-8: serial-mode adapter → one router → both applied |
| Integration | Finaliser release primary-last preserved | SCN-6FU-9: `tds_release` still carries RELEASE/SESSION_CLOSE primary-last |
| Integration | FU2 non-base departure observed once; re-entry no pollution | SCN-6FU-10/11: active-leg window edge + once-per-leg guard |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary. `REDUCER_BATCH` is an in-engine
command envelope routed inside the Tasker JSlet runtime; no OS process boundary
is crossed. The serial single-invocation model and single-writer contract are
unchanged (reducer remains sole writer of `TDS_Trip_State.json`).

## Migration / Rollout

No migration. `REDUCER_BATCH` is additive — old single-command staging/routing
stays intact; adapters revert to primary-last; FU2 drops the edge trigger.
Per-slice revert restores status quo without chain break. No `schemaVersion`
bump, no new single-writer resource. Deployment gate remains manual Tasker
validation (out of harness scope).

## Review Workload Forecast

| Slice | Scope | Est. Δ lines (prod+test) | 400-line budget risk |
|-------|-------|--------------------------|----------------------|
| PR 1 — FU1 core | Sandbox accumulation + `REDUCER_BATCH` (router + reducer `applyBatch`) + Depart_Now + Return_to_Base + harness `serialMode` + `test_serial_batch.js` + reject/partial-failure unit tests | ~340-380 (prod ~200, test ~140-180) | **Borderline.** Recommend **Chained PRs**: PR 1 = Sandbox + reducer/router + harness RED test + Depart_Now/Return_to_Base (~340); splitting tests into PR 1b if it creeps past 400. |
| PR 2 — FU1 Finaliser (D5) | Finaliser dropin/arrival onto batch (+ dedicated slot decision) | ~80-120 | Low if isolated. **Decision needed before apply.** |
| PR 3 — FU2 tail | Sandbox active-leg edge trigger + once-per-leg guard + SCN-6FU-10/11 tests | ~70-100 | Low. Single PR. |

**Chained PRs recommended**: Yes (PR 1 → PR 2 → PR 3). PR 1 is the gating RED→GREEN.
**Decision needed before apply**: D5 — Finaliser dropin/arrival migration requires
either (a) a dedicated `tds_obs_batch_par1/par2` slot + one extra
`TDS_State_Command` invocation (brushes the "no task-loop wiring changes"
non-goal), or (b) defer Finaliser to a follow-up change and keep slice 1 to
Sandbox + Depart_Now + Return_to_Base (zero wiring change, fixes the major loss).

## Open Questions

- [ ] **D5 (blocking slice 1b)**: add a 3rd serial handoff local for the Finaliser
      observation batch (minor Tasker task-loop addition), or defer Finaliser
      dropin/arrival to a follow-up and ship slice 1a = Sandbox + adapters only?
- [ ] `MAX_REDUCER_BATCH_SIZE` value — 32 covers the `COMPLETE_TRIP × N` manual-trip
      loop; confirm no real pass exceeds it (named constant, structured reject).
- [ ] Should the reducer bump `revision` once per applied sub-command or once per
      batch (design assumes per-apply, matching existing `apply*` functions)?