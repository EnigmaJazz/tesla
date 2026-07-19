# Proposal: tasker-tesla-upgrade-slice-2: explicit departurePolicy and live origin (0A + 0C)

## Why

The 19-section specification makes Phase 0 invariants the immediate priority. Slice 1 closed AC-8, AC-9, AC-10, and relevance-deadline semantics.

The remaining 0A and 0C work closes AC-1 and AC-6. Today Sandbox reconstructs policy from `pitstopState`, `_IN`, and `EOD_RETURN`, and reads live origin only when `oldItin` is empty.

Two paths need correction: Sandbox queue emission gains explicit policy, and fresh-pass origin consults live `User_At_Base` despite a stale itinerary.

## What changes

- `Sandbox_Engine.js:1188-1189`: append `departurePolicy` as queue column 19. Emit ASAP for chains, recovery, returns/EOD, manual, and due/in-progress travel; emit JIT for first/base/future post-overnight travel unless active state supersedes it.
- `Sandbox_Engine.js:438-449`: at pass start, live `User_At_Base === "true"` overrides contradictory legacy `simAtBase`; flash `EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN`.
- `Compiler.js:160-168,247-256`: consume `block_step19`; remove policy reconstruction. Preserve non-policy `hardFloor` math.
- Add `harness/test_compiler_ac1.js`, `harness/test_sandbox_ac6.js`, and document them in `harness/README.md`.

## What does not change

- ID parsing, DST boundaries, AC-5/0E, override-store consolidation, trip-state schema, and `originSource` enum.
- The external Tasker queue consumer is outside the 18-script footprint, but MUST split column 19 in the same Tasker action.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `itinerary`: explicit planner-owned departure policy and fresh-pass live-origin precedence.

## Approach

1. **Patch D:** Sandbox live origin, then queue emission (AC-6 first).
2. **Patch E:** Compiler consumes column 19 (AC-1).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Positional consumer silently misreads column 19 | High | Update external consumer atomically |
| Full Sandbox VM test is heavy | Med | Assert pass-start origin, not full queue |
| `isPrevBase` affects `hardFloor` | Med | Retain explicit `prevEnd` math; test JIT |

## Rollback Plan

Revert Patch E then Patch D, and restore the external consumer's prior queue shape in the same Tasker action. No data migration occurs.

## Acceptance

- [ ] AC-1 and AC-6 pass via new harness tests.
- [ ] AC-8, AC-9, and AC-10 remain passing.

## Workload forecast

Sandbox 40-60 lines; Compiler 20-30; AC-1 harness 100-130; AC-6 harness 120-160; README update: **300-450 lines**, likely over the 400-line review budget. User-selected `ask-always` requires a chained-PR decision.

## Roadmap

Slice 3: 0B DST-safe overnight boundaries, 0E/AC-5, and 0G zero-duration rejection. Phase 1+ covers typed protocols and `TDS_Trip_State.json`.
