# Proposal: Phase 3 — Trip-State Migration

## Goal & Intent

Persist progress/origin; restart cannot reconstruct stale state.

## Scope

### In Scope
- Schema/API; `Trip_State_Reducer.js` sole writer; CMD-9 lifecycle.
- Migrate OVR: Depart Memory, completed stops/drop-ins, arrival memory.
- Own/project globals: base, base-arrival, lateness, status, manual-return completion.
- Commands/reads: Compiler, Finaliser, Stop Logger, Alpha, Sandbox, Dispatcher, Dashboard, adapters; centralize five readers.
- Six harnesses: commands, lifecycle, origin, boundary, post-return, synthetic-return.

### Out of Scope
- Existing Override-Injector, occurrence-split, substring-ID violations; schema-v2 overrides.
- Routine preferences; manual/action files; DST; `var`; `TDS_Previous_Loc`; publisher deduplication.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `itinerary`: persistent lifecycle, explicit origin, command ownership, and state-backed reads.

## Approach & Architecture Decisions

| Question | Decision |
|---|---|
| Q1 | Serialized Tasker action `%par1`/`%par2`, not JS call: CMD-9/Phase-2 serialization. |
| Q2 | File write/read-back, then globals: file failure no-op; global failure audited/reconciled. Other orders expose uncommitted state. |
| Q3 | Retain 30 local days, exempt active/manual/current generation: bounded and diagnostically useful. |
| Q4 | `schemaVersion:1`; increment `revision`; explicit migration/version bump for schema changes. |
| Q5 | Reducer writes global; consumes legacy true once, clears/completes return, keeps tomorrow `PLANNED`/JIT, logs `EVT-FUTURE_TRIP_NOT_DUE` if early. |
| Q6 | Leave dead `TDS_Previous_Loc` untouched; reducer does not invent a writer. |

Defer `publishCandidate`: bounded Phase 2 adapter, not lifecycle correctness.

## High-Level Requirements

- Reducer alone writes state; commands only; origin/policy/day/deadline/completion explicit.
- Reject/log zero duration, unbounded actionability, policy-less return, cross-day chain.
- Active/manual/live beats legacy; no future ASAP/DUE transfer; stable stops, once-only padding, idle fallback.

## Tradeoffs

File-first tolerates stale UI globals; 30-day retention limits history; device serialization remains weakest.

## Chain Strategy

- **PR-A Reducer shell** — reducer/mock/command test; 3/~370; boundary; none.
- **PR-B Arrival** — Finaliser/Alpha/Sandbox/tests; 5/~390; key migration; A.
- **PR-C Stops** — Stop Logger/Sandbox/tests; 3/~300; stable commands; B.
- **PR-D Departures** — Compiler/Alpha/tests; 3/~330; remove memory; A.
- **PR-E Readers** — Helper + four readers; 5/~380; remove drift; A–D.
- **PR-F Hardening** — adapters/projections/harnesses; 6/~390; proof; A–E.

Stacked-to-main: each slice is reversible and below 400 lines.

## Risks

- RMW races — serialized action.
- Torn file/global — read-back/reconcile.
- Retention — active/manual exemption.
- Publisher — post-commit supersession.
- Origin — explicit precedence tests.
- Empty/cross-day/future leakage — rejection tests.

## Rollback Plan

Revert slice, retain state backup, restore adapter read path; never re-enable migrated OVR writers while reducer is active.

## Acceptance Criteria

- No critical re-verify; 9 baseline + 6 new + 30 Phase-2 scenarios pass.
- Eight states and four OVR/five-global migrations state-backed; no migrated reads.

## Out-of-Band Follow-Ups

- Fix Override Injector, ID splitting/substrings; later repair/remove previous-location and dedupe publisher adapter.
