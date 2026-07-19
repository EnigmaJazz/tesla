# Proposal: Phase 0 first slice: stop padding, stale-departure containment, idle sync

## Why

The 19-section upgrade makes Phase 0 invariants the immediate priority (§16). Exploration found three high-impact FAILs: stop padding is counted twice (**AC-8**); the first expired departure blocks a valid later trip (**AC-9**); and no actionable trip falls into a three-minute loop instead of idle sync (**AC-10**).

## What changes

- `Compiler.js:68-81, 241, 308` — retain route-only `durationSecs`; apply stop padding once to the next-leg gap (**MODIFIED INV-0.8**).
- `Dispatcher.js:40-53` — reject stale past departures and select the next actionable leg (**MODIFIED INV-0.6**).
- `Dispatcher.js:209-222` — derive sync from the selected leg; use idle sync if none is actionable (**MODIFIED INV-0.6**).

## What does not change

- Deferred: `TDS_Run_Manifest.json`, full §17 structured logging, occurrence-ID migration, `TDS_Overrides.json` single-writer consolidation, DST-safe boundaries, explicit `departurePolicy`, and full AC-1/AC-5/AC-6 acceptance.
- Phases 1–6 are out of scope. No live file beyond `Compiler.js` and `Dispatcher.js` changes; no architecture merge into Alpha.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `itinerary`: bounded dispatcher selection/idle fallback and once-only stop-padding semantics.

## Approach

Two patches in order: (1) one Compiler function removes duration padding duplication; (2) two Dispatcher functions reject stale work and select idle sync. Each is one file, one commit, and changes no behaviour beyond the fix.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `Compiler.js` | Modified | AC-8 stop timing |
| `Dispatcher.js` | Modified | AC-9/AC-10 selection and sync |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Idle branch fires for a legitimately-due head leg | Med | Verify selected due leg retains normal timing |
| Sandbox ad-hoc stop addition (`Sandbox_Engine.js:916-917`) interacts | Med | Defer and inspect in second slice |
| GGA review hook fires | High | Review against `AGENTS.md` hard rules |

## Rollback Plan

Revert either independent commit; staged paper contracts remain valid and no data migration occurs.

## Dependencies

- Canonical `itinerary` spec and manual Tasker scenario verification.

## Acceptance

- [ ] **AC-8:** “stop padding changes timing exactly once.”
- [ ] **AC-9:** “an expired past leg cannot block the next valid trip.”
- [ ] **AC-10:** “stale outputs are cleared; normal idle polling is used.”

## Workload forecast

`Compiler.js` ~10–20 lines, one function; `Dispatcher.js` ~15–30 lines, two functions; total ~25–50 lines. Well below 400 lines: no chained PR; one PR per commit is suitable.

## Roadmap

Second slice: AC-1/AC-5/AC-6, explicit `departurePolicy`, ID parsing migration, and `TDS_Overrides.json` ownership. Phases 1–6 remain out of scope.
