# Proposal: tasker-tesla-upgrade-slice-3: DST-safe day boundaries + post-return future-trip (0B + 0E)

## Why

The 19-section specification makes Phase 0 invariants the immediate priority. Slice 1 closed AC-8/9/10 (stale departure, idle sync, stop padding); slice 2 closed AC-1/6 (explicit `departurePolicy`, live origin).

The remaining Phase 0 work is 0B (overnight-boundary + DST safety) and 0E (post-return future-trip + AC-5). Current day math uses `setHours(0,0,0,0)` and `getDate()`, which are DST-unsafe; AC-5 is UNKNOWN because manual return lacks a completion signal.

Closing this requires UTC day-comparison helpers at 13 sites, a `TDS_Manual_Return_Completed` global, and next-day AC-5 enforcement.

## What changes

- `Alpha.js:60-65,182-187`: UTC day comparison for rollover and `Tesla_Last_Sync`.
- `Sandbox_Engine.js:117-119,657-687,1197-1219`, `state.loc` rebind, and `enqueuePlannedRow`: UTC comparison for geofence, horizon, and EOD math; enforce the next-day JIT first trip after manual return.
- `Finaliser.js:117-120,201-237`, `Compiler.js`, `Dispatcher.js`, and `Dashboard.js`: use UTC policy/day-boundary math; retain local human-facing display.
- `Return_to_Base.js`: set `TDS_Manual_Return_Completed` when writing a manual return.
- Emit `EVT-FUTURE_TRIP_NOT_DUE` and `EVT-SYNTHETIC_RETURN_SUPPRESSED` via `flash()`.
- Add `harness/test_dst_*.js` (UK BST/GMT fixtures) and `harness/test_ac5.js`.

## What does not change

- AC-1/2/3 happy path/4/6/7 happy path/8/9/10; ID parsing; single-writer, trip-state, action-session, `originSource`, and atomic-publication migrations.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `itinerary`: DST-safe UTC day boundaries and manual-return isolation of future JIT trips.

## Approach

1. **PR-A — DST fix:** add UTC comparison helpers, replace 13 sites, and add DST tests (~400–600 lines).
2. **PR-B — AC-5:** write/consume the manual-return signal, preserve next-day `PLANNED`/`JIT`, and add AC-5 test (~300–500 lines).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Broken UTC boundary invalidates overnight contract | Med | Test both BST→GMT and GMT→BST transitions. |
| Transient global ownership is unclear | Med | One writer, documented reader; Phase 4 migrates it. |
| Events are not persistent | Low | Match current `flash()` pattern; Phase 2 persists events. |

## Rollback Plan

Revert PR-B independently, then PR-A. Clear the transient global on rollback; no JSON migration occurs.

## Acceptance

- [ ] AC-3, AC-5, and AC-7 pass via harness.
- [ ] AC-1, AC-2, AC-4, AC-6, AC-8, AC-9, and AC-10 remain passing.

## Workload forecast

PR-A ~400–600 lines; PR-B ~300–500 lines. Deliver as two chained PRs.

## Roadmap

Slice 4: ID parsing and single-writer consolidation. Slice 5: DST-aware API parser and 0G typed zero-duration protocol. Phase 2: atomic publication.
