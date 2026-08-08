# Proposal: Finaliser Dropin/Arrival Observation Migration

## Intent

In one Finaliser pass, three `setLocal` writes to `par1`/`par2` run in sequence: `COMPLETE_DROPIN` (Finaliser.js:143-149), `OBSERVE_ARRIVAL` (:167-172), then `publishCandidate` (:224). Serial Tasker delivers only the LAST `par1`/`par2` per pass — both reducer observations are lost in production. Harness tests E2-2, AC-5, `testFinaliserCutover` all run shim mode (synchronous reducer) and mask this; none asserts serial-mode staging. Deferred by decision D5 (phase-6-followups design.md:26); REQ-6FU-4 carries the annotation (spec.md:957).

## Scope

### In Scope
- **Finaliser.js** (:143-149, :167-172): replace raw `setLocal` staging with dual-path accumulation — stage the observation list into a dedicated local (name TBD in design) AND shim-deliver synchronously when reducer is a function (keeps E2-2/AC-5 green). **Flush-skip**: skip when generation id is invalid — fallback `"gen:0:0000"` (Finaliser.js:145,168) fails `STATE_CMD_GEN_REGEX`.
- **Generation_Publisher.js** serial branch (:219-223): when the obs local is present, stage `REDUCER_BATCH` = `[RECONCILE_GENERATION, ...obs]`, re-stamping each obs `generationId` to the new genId; else plain `RECONCILE_GENERATION`.
- **New serial-mode harness test** (mirror `test_serial_batch.js`): both observations reach the reducer in one pass, publish candidate last.
- **Spec**: REQ-6FU-4 — remove D5 annotation, add Finaliser batch scenario mirroring SCN-6FU-8.

### Out of Scope
- NO Tasker task-loop wiring / third handoff slot (D5 rejected).
- NO TDS_State_Command.js / Trip_State_Reducer.js changes (FU1 machinery landed).
- NO Sandbox_Engine, Depart_Now, Return_to_Base changes.
- Release chain (:261-309) untouched; `par1` MUST keep the publish candidate (:224) — SCN-6FU-9 mid-chain rule (test_ac5.js:415-416,440).

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `itinerary`: REQ-6FU-4 — drop Finaliser-deferral annotation; add scenario asserting dropin+arrival deliver in one pass with candidate primary-last.

## Approach

Publisher merge (Option B, user decision 2026-08-08). Finaliser accumulates observations into a dedicated local instead of clobbering `par1`; Generation_Publisher merges them into the post-publish `REDUCER_BATCH` with per-sub-command genId re-stamp. Dual shim path keeps 28/28 harness tests green.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `Finaliser.js` | Modified | :143-149, :167-172 → accumulate + shim-deliver; flush-skip on invalid genId |
| `Generation_Publisher.js` | Modified | :219-223 merges `[RECONCILE_GENERATION, ...obs]` with genId re-stamp |
| `harness/test_*.js` | New | serial-mode test (serialMode, staged-owner routing after router) |
| `openspec/specs/itinerary/spec.md` | Modified | REQ-6FU-4 deferral removed + Finaliser scenario |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Envelope all-or-nothing rejection (unset generation, >32 obs) | Med | Flush-skip on invalid genId; design caps burst to MAX_REDUCER_BATCH_SIZE=32 |
| par1 clobber regression breaking SCN-6FU-9 | Low | Candidate stays last; release chain untouched; serial test asserts ordering |
| No serial coverage → regression slips through | Med | New serial-mode test is a deliverable, not optional |

## Rollback Plan

Revert Finaliser staging to direct `setLocal`, Generation_Publisher to plain `RECONCILE_GENERATION`, delete the serial test. No reducer/state-command changes to unwind — two-file, byte-localized, zero data migration.

## Dependencies

- FU1 REDUCER_BATCH machinery (Sandbox_Engine, TDS_State_Command, Trip_State_Reducer) — already landed.

## Success Criteria

- [ ] Serial-mode test proves COMPLETE_DROPIN + OBSERVE_ARRIVAL both deliver in one pass, candidate last.
- [ ] All existing harness tests stay green (E2-2, AC-5, testFinaliserCutover).
- [ ] No functional change to TDS_State_Command.js / Trip_State_Reducer.js.
- [ ] REQ-6FU-4 deferral annotation removed.
