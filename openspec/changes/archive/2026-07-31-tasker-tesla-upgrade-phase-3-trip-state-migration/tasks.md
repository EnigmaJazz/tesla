# Tasks: Phase 3 — Trip-State Migration
Date: 2026-07-31 | Status: planned
Refs: design.md, specs/itinerary/spec.md, proposal.md

## PR-A: Reducer shell (~370 lines) ✅ merged
**Goal:** Create the serialized sole writer and schema foundation. **Deps:** none.
- [x] **Task 1.1:** Create `Trip_State_Reducer.js` and `harness/mock_tasker.js`; implement parse/load/validate, schema v1, revision, atomic read-back/restore, projection gate. Test: RED malformed/future-schema/torn-write/concurrency; verify `node harness/test_reducer_commands.js`; commit `feat(trip-state): add serialized reducer`; ~220 lines. [PR-A #13, merged `4c9f4ad`]
- [x] **Task 1.2:** Add `harness/test_reducer_commands.js`; cover unauthorized writer, reconciliation supersession, retention, revision, and all command schemas/effects. Verify RED then GREEN after 1.1; commit `test(trip-state): cover reducer protocol`; ~150 lines. [PR-A #13, merged `4c9f4ad`]
**Acceptance:** one writer; second same-tick command reloads first; projection follows read-back; 30-day exemptions hold. **Risks:** Tasker serialization mismatch—mock `%par1/%par2/%par3`; torn files—restore old bytes.

## PR-B: Arrival and lifecycle (~390 lines)
**Goal:** Migrate arrival/base evidence and implement lifecycle progression. **Deps:** A.
- **Task 2.1:** RED tests in `harness/test_trip_lifecycle.js`; cover eight states, progression, terminals, qualified arrival, stale/future rejection. Verify focused harness; commit `test(trip-state): specify lifecycle and arrival`; ~120 lines.
- **Task 2.2:** Modify `Trip_State_Reducer.js`, `Finaliser.js`, `Alpha.js`, `Sandbox_Engine.js`; migrate arrival/base fields, explicit planningDay/origin, and remove Arrival/Dropin OVR writes. Verify lifecycle and existing harnesses; commit `feat(trip-state): migrate arrival evidence`; ~270 lines.
**Acceptance:** explicit transitions; no legacy arrival reads/writes; local dates preserved. **Risks:** DST—UTC calendar ordinals; stale evidence—generation validation.

## PR-C: Stops (~300 lines)
**Goal:** Make stop completion reducer-owned and idempotent. **Deps:** B.
- **Task 3.1:** RED tests in `harness/test_reducer_commands.js`; cover stable stop IDs, duplicate completion, once-only duration/padding. Verify focused harness; commit `test(trip-state): specify stop commands`; ~100 lines.
- **Task 3.2:** Modify `Stop_Logger.js`, `Sandbox_Engine.js`, `Trip_State_Reducer.js`; add COMPLETE/START/END stop adapters and migrate Completed_Stops. Verify full harness; commit `feat(trip-state): migrate stop state`; ~200 lines.
**Acceptance:** duplicate commands are harmless; stop duration is not route padding. **Risk:** adapter payload drift—shared fixtures.

## PR-D: Departures and boundaries (~330 lines)
**Goal:** Remove departure memory and enforce day boundaries. **Deps:** A,C.
- **Task 4.1:** Add RED cases to `harness/test_day_boundary.js`; cover cross-day rejection, DST/UTC-local disagreement, stale generation. Verify focused harness; commit `test(trip-state): specify departure boundaries`; ~120 lines.
- **Task 4.2:** Modify `Compiler.js`, `Alpha.js`, `Trip_State_Reducer.js`; migrate Depart_Memory, explicit departure policy/deadline, and terminate chains at local day. Verify all harnesses; commit `feat(trip-state): migrate departures`; ~210 lines.
**Acceptance:** no unbounded actionability or cross-day chain; no negative-gap loop. **Risk:** timezone disagreement—pinned dates.

## PR-E: Reader cutover (~380 lines)
**Goal:** Establish one active-generation/state resolver and cut readers over. **Deps:** A–D.
- **Task 5.1:** Add RED `harness/test_origin_precedence.js`; cover seven adjacent precedence pairs and no inference. Verify focused harness; commit `test(trip-state): specify origin precedence`; ~100 lines.
- **Task 5.2:** Modify `TDS_Helper.js`, `Compiler.js`, `Dispatcher.js`, `Dashboard.js`, `Sandbox_Engine.js`; centralize read-only generation/state reads and state-backed origin/globals. Verify no duplicate resolver/legacy migrated reads; commit `refactor(reads): centralize trip-state authority`; ~280 lines.
**Acceptance:** live base/active trip beats legacy itinerary; Tasker return handoff is validated. **Risk:** stale UI globals—file-first reads.

## PR-F: Reconciliation, adapters, hardening (~390 lines)
**Goal:** Complete post-commit reconciliation, return policy, projections, and integration proof. **Deps:** A–E.
- **Task 6.1:** Add RED `harness/test_synthetic_return_rejection.js` and `harness/test_post_return_isolation.js`; cover missing/five policies, duplicate EOD, tomorrow PLANNED/JIT. Verify focused harness; commit `test(trip-state): specify return isolation`; ~120 lines.
- **Task 6.2:** Modify `Generation_Publisher.js`, `Depart_Now.js`, `Return_to_Base.js`, `Trip_State_Reducer.js`; add reconcile command, adapters, projections, legacy manual-return import, structured failures. Verify `for t in harness/test_*.js; do node "$t" || break; done`; commit `feat(trip-state): finish reconciliation and adapters`; ~270 lines.
**Acceptance:** same-revision supersession; policy-less return suppressed; projections never precede commit. **Risks:** post-commit lag—cycle repair; global failure—audit/retry.

## Coverage matrix
| Requirement | PR | Tasks |
|---|---|---|
| R-TRIP-1 sole writer | A,F | 1.1,1.2,6.2 |
| R-TRIP-2 eight states | B,F | 2.1,2.2,6.2 |
| R-TRIP-3 thirteen commands | A–F | 1.1,1.2,2.2,3.2,4.2,6.2 |
| R-TRIP-4 origin precedence | E | 5.1,5.2 |
| R-TRIP-5 return policy | F | 6.1,6.2 |
| R-TRIP-6 day boundary | D | 4.1,4.2 |
| R-TRIP-7 four OVR keys | B–D | 2.2,3.2,4.2 |
| R-TRIP-8 five globals | E,F | 5.2,6.2 |
| R-TRIP-9 central resolver | E | 5.2 |
| R-TRIP-10 retention | A | 1.1,1.2 |
| R-TRIP-11 versioning | A | 1.1,1.2 |
| R-TRIP-12 atomic observability | A,F | 1.1,6.2 |

## Scenario matrix
| Scenario | Test file |
|---|---|
| R-TRIP-1.1–1.3 | `harness/test_reducer_commands.js` |
| R-TRIP-2.1–2.2 | `harness/test_trip_lifecycle.js` |
| R-TRIP-3.1–3.2 | `harness/test_reducer_commands.js` |
| R-TRIP-4.1–4.2 | `harness/test_origin_precedence.js` |
| R-TRIP-5.1–5.2 | `harness/test_synthetic_return_rejection.js` |
| R-TRIP-6.1–6.3 | `harness/test_day_boundary.js` |
| R-TRIP-7.1 | `harness/test_reducer_commands.js` |
| R-TRIP-8.1 | `harness/test_reducer_commands.js` |
| R-TRIP-9.1 | `harness/test_reducer_commands.js` |
| R-TRIP-10.1–10.2 | `harness/test_reducer_commands.js` |
| R-TRIP-11.1–11.2 | `harness/test_reducer_commands.js` |
| R-TRIP-12.1–12.2 | `harness/test_reducer_commands.js` |

## Review Workload Forecast
**Total chain estimate:** 2160 lines across 17 files. **Per-PR:** A 370, B 390, C 300, D 330, E 380, F 390.
**400-line budget risk:** high. **Decision needed before apply:** no; auto, ask-on-risk already resolved to stacked-to-main. **Chained PRs recommended:** yes. **Chain strategy:** stacked-to-main.

## Out of scope
Three pre-existing AGENTS violations; `TDS_Previous_Loc`; schema-v2 exact-key `eventOverrides`; `TDS_Routine_Preferences.json`; `TDS_Manual_Trips.json`; `TDS_Action_Sessions.json`.
