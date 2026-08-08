# Delta for itinerary

> Supplements §25 REQ-6FU-4. Removes the D5 Finaliser-deferral annotation; new requirements use prefix `REQ-6F2-x` (canonical `REQ-6FU-*` pattern).

## ADDED Requirements

### Requirement: REQ-6F2-1 — Finaliser observation accumulation (dual path)

The serial model delivers only the LAST `par1`/`par2` per pass, so raw `setLocal` for `COMPLETE_DROPIN` then `OBSERVE_ARRIVAL` clobbers the first — the defect this change fixes. The Finaliser SHALL accumulate the pass's reducer observations into a dedicated local and, when a reducer shim is present, shim-deliver each in order (keeps E2-2, AC-5, `testFinaliserCutover` green). The publish candidate MUST remain final `par1`; accumulated observations MUST NOT touch `par1`/`par2`.

#### Scenario: SCN-6F2-2 — accumulate + shim-deliver (dual-path green)
- GIVEN a reducer shim present and one pass staging `COMPLETE_DROPIN` then `OBSERVE_ARRIVAL`
- WHEN the pass runs, THEN each MUST shim-deliver in order AND accumulate into the dedicated local
- AND `par1` SHALL remain the publish candidate (primary-last)

### Requirement: REQ-6F2-2 — Flush-skip guard on invalid generation id

When `TDS_Active_Generation` is unset, the fallback `"gen:0:0000"` fails `STATE_CMD_GEN_REGEX = /^gen:\d{10}:[0-9a-f]{4}$/`. The Finaliser MUST NOT stage a batch whose genId would fail the envelope pre-check; such observations SHALL be flush-skipped (logged, not staged) so the device sees no `BATCH_ENVELOPE_REJECTED`. Valid observations in the pass SHALL still stage.

#### Scenario: SCN-6F2-3 — flush-skip on fallback genId
- GIVEN `TDS_Active_Generation` unset, fallback fails `STATE_CMD_GEN_REGEX`
- WHEN the Finaliser stages an observation
- THEN it MUST skip staging, log a structured rejection, AND no envelope must reach `TDS_State_Command` for it

### Requirement: REQ-6F2-3 — Publisher REDUCER_BATCH merge envelope

The Generation_Publisher serial branch SHALL, when the Finaliser's observation local is present, stage one `REDUCER_BATCH` with `commands` = `[RECONCILE_GENERATION, ...observations]` in staging order, each obs `generationId` re-stamped to the new `genId`. The reducer SHALL apply every sub-command; the publisher SHALL log `REDUCER_BATCH_DELIVERED`. When the local is absent, it SHALL stage plain `RECONCILE_GENERATION` byte-identical to current behavior. Total sub-commands MUST NOT exceed `MAX_REDUCER_BATCH_SIZE = 32`; obs beyond the 31-obs cap (one slot for reconcile) MUST be dropped with a structured log — all-or-nothing loss is forbidden.

#### Scenario: SCN-6F2-4 — merge with genId re-stamp
- GIVEN N observations staged and a fresh `genId` published
- WHEN the serial branch runs with the observation local present
- THEN it MUST stage `[RECONCILE_GENERATION, ...obs]` with each obs `generationId` = new `genId`
- AND the reducer MUST apply all and the publisher MUST log `REDUCER_BATCH_DELIVERED`

#### Scenario: SCN-6F2-5 — no-observation byte-identical parity
- GIVEN no staged observations
- WHEN the serial branch runs, THEN it MUST stage plain `RECONCILE_GENERATION` byte-identical to pre-change behavior

#### Scenario: SCN-6F2-6 — burst exceeds the cap
- GIVEN > 31 observations staged (total > `MAX_REDUCER_BATCH_SIZE = 32`)
- WHEN the Publisher builds the envelope, THEN it MUST keep the first 31 and drop the excess with a structured log
- AND the envelope MUST NOT be all-or-nothing rejected

### Requirement: REQ-6F2-4 — Serial-mode harness proof

A serial-mode harness test (mirroring `test_serial_batch.js`, `serialMode: true`, no reducer/publish shims) SHALL prove `COMPLETE_DROPIN` and `OBSERVE_ARRIVAL` both reach the reducer in one pass in event order with the candidate primary-last. Deliverable, not optional.

#### Scenario: SCN-6F2-7 — serial-mode one-pass delivery proof
- GIVEN the serial-mode harness running one pass that stages dropin completion then arrival
- WHEN the staged `REDUCER_BATCH` reaches `TDS_State_Command` once
- THEN both observations MUST commit in staging order AND the publish candidate MUST remain primary-last

#### Scenario: SCN-6F2-1 — production-loss clobber baseline (why)
- GIVEN the serial model with no reducer shim, a pass staging `COMPLETE_DROPIN` then `OBSERVE_ARRIVAL` via raw `setLocal`
- WHEN the next action reads `par1`, THEN only the LAST value reaches `TDS_State_Command`
- AND the first observation SHALL be silently lost — the defect this change fixes

## MODIFIED Requirements

### Requirement: REQ-6FU-4 — Adapter observation migration

`Depart_Now.js`, `Return_to_Base.js`, and `Finaliser.js` observations the serial model would clobber SHALL route through the batch mechanism so no secondary observation is sacrificed. Where the primary command MUST be the delivered envelope (the Finaliser publish/release sequence), the `tds_release_par1/par2` mid-chain rule SHALL be retained so the primary remains last. The Finaliser migration is now in scope (REQ-6F2-1..6F2-4).

(Previously: Finaliser migration deferred by decision D5; REQ-6FU-4 carried the annotation at spec.md:957. Removed.)

#### Scenario: SCN-6FU-8 [EVT: `REDUCER_BATCH_DELIVERED`]
- GIVEN Depart_Now stages `OBSERVE_LATENESS_HALT` then `DEPART_NOW`
- WHEN delivered serially, THEN both MUST reach the reducer with neither sacrificed

#### Scenario: SCN-6FU-9 [EVT: `STATE_PROJECTION_SKIPPED`]
- GIVEN the Finaliser publish/release chain, WHEN staged
- THEN the release candidate MUST remain primary-last and the `tds_release_par1/par2` rule SHALL be preserved

#### Scenario: SCN-6FU-12 [EVT: `REDUCER_BATCH_DELIVERED`] — Finaliser batch (added)
- GIVEN a pass stages `COMPLETE_DROPIN` then `OBSERVE_ARRIVAL` then the publish candidate
- WHEN the merged `REDUCER_BATCH` reaches the reducer in one pass
- THEN both observations MUST apply in event order with neither sacrificed AND the candidate SHALL remain primary-last