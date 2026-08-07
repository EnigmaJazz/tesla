# Proposal: Phase 6 Follow-ups — Batch Staging & Non-Base-Origin Departure Observation

## Intent

FU1 is a real production gap: serial Tasker delivers only the LAST staged `par1`/`par2` per pass to `TDS_State_Command`. Sandbox stages up to four observations per pass (Sandbox_Engine.js:538-634, :897); all but the last are silently dropped on device — `userAtBase`, `currentStatus`, `departures[]`, base-arrival `COMPLETE_TRIP` never reach trip state. Harness masks it (mock_tasker.js:94-103 sync shim; 28/28 green). FU2 completes REQ-6STATE-4 for non-base-origin JIT departures; low stakes (AUTO_REPLAN is departure-independent, Compiler.js:603-611 — archive trigger unmet); never before FU1.

## Scope

**In**: batch envelope (Sandbox accumulation → `REDUCER_BATCH` `par2={commands:[...]}` → router → reducer order-apply); production-faithful harness RED test; adapter migration (Depart_Now, Return_to_Base, Finaliser clobbered observations); FU2 edge-triggered `OBSERVE_DEPARTURE` tail slice, once-per-leg guard.
**Out**: Tasker task-loop wiring (unverifiable from harness); queue-file resource (`TDS_Reorder_Commands` stays reorder-only; no new single-writer); schemaVersion bump; FU2 if budget tight.

## Capabilities

**New**: None.
**Modified**: `itinerary` (`openspec/specs/itinerary/spec.md`)
- §9 CMD-9 (:100-101): add `REDUCER_BATCH` — ordered sub-command array in `par2.commands`.
- §23 REQ-4CMD-1 (:573): batch validation parity — envelope byte-exact (reject-without-mutation); nested sub-commands mirror `REDUCER_REQUIRED_FIELDS`.
- REQ-6STATE-4 (:851): extend `OBSERVE_DEPARTURE` caller scope to non-base-origin departures.

Canonical-spec sync required on archive merge: CMD-9 command list, REQ-4CMD-1 scenarios, REQ-6STATE-4 text.

## Approach

Approach 1 (batch envelope): only option fixing production delivery without task-loop wiring; reducer stays sole writer; harness-provable. Slices: 1 = FU1 core (accumulation, route, reducer loop-apply, RED test first, adapter migration); 2 = FU2 tail.

**Partial-failure: apply-valid-in-order, log-and-skip invalid (structured code).** Not all-or-nothing: top-level envelope rejection already preserves REQ-4CMD-1 no-mutation; all-or-nothing re-introduces pass-level loss (one bad COMPLETE_TRIP payload drops OBSERVE_LIVE_BASE); observations are independent state facts; per-command validate/commit/project preserved.

**Batch size**: loop apply, no recursion; split-flush rejected (earlier envelopes lost to last-wins); named-constant guard rejects absurd batches with structured log.

## Affected Areas

| Area | Impact | Change |
|---|---|---|
| `Sandbox_Engine.js` (:432-438, :538-634, :897, :612-632) | Modified | Batch accumulation; pass-end `REDUCER_BATCH`; FU2 edge trigger |
| `TDS_State_Command.js` (:39-42, :57-80, :443-456) | Modified | `REDUCER_BATCH` route + nested field parity |
| `Trip_State_Reducer.js` | Modified | Batch apply loop; partial-failure log; size guard |
| `Depart_Now.js`, `Return_to_Base.js` | Modified | Sacrificed observations onto batch |
| `Finaliser.js` (:143-172, :268-293) | Modified | Clobbered observations onto batch; keep release mid-chain rule |
| `harness/mock_tasker.js` (:94-103) | Modified | Production-faithful serial path (no shim) |
| `harness/test_ac5.js` + new serial test | Modified/New | RED test: last-wins loss → batch delivery |
| `openspec/specs/itinerary/spec.md` | Modified | CMD-9 / REQ-4CMD-1 / REQ-6STATE-4 |

## Risks & Rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Harness divergence persists | Med | RED test is the gate: sandbox w/o shim, then `TDS_State_Command` once |
| Batch validation parity | Med | Nested `REDUCER_REQUIRED_FIELDS` byte-exact; reject-without-mutation |
| Variable batch size | Low | Loop apply; named-constant guard; no split-flush |
| Adapter migration incomplete | Med | Migrate all three in slice 1; only Finaliser release chain keeps primary-last |
| FU2 edge spam | Med | Once-per-leg guard vs last `departures[]` record; no double-observation |
| Device validation manual-only | High | Manual Tasker validation remains deployment gate |

**Rollback**: per-slice revert; `REDUCER_BATCH` additive — old single-command staging/routing intact, revert restores status quo without chain break; adapters revert to primary-last; FU2 drops the edge trigger only.

## Dependencies

None external; 28/28 harness baseline is the gate. FU1 MUST precede FU2.

## Success Criteria

- [ ] Serial-faithful test FAILS pre-fix (only last staged command lands), PASSES post-fix
- [ ] All Sandbox per-pass observations reach trip state in the serial-faithful test
- [ ] 28/28 existing harness green (29+ with new tests)
- [ ] Adapter secondary observations delivered — none sacrificed
- [ ] FU2: non-base JIT departure observed once per leg; no `departures[]` pollution; base-leave not double-observed
