# Itinerary Delta: Phase 0 first slice

## MODIFIED Requirements

### INV-0.6 — Actionable-trip bounds

The Dispatcher MUST NOT use an unbounded condition such as `departUnix - now <= 86400`, because it admits indefinitely stale trips. A candidate is actionable only when non-terminal, active-generation or active-manual, before relevance deadline, meaningful in timing/destination, not newer-equivalent-replaced, and predecessor-satisfied.

For this slice, a leg with `depUnix < nowSec - relevanceDeadline` is stale and MUST be excluded from candidate selection. A leg where `nowSec - relevanceDeadline <= depUnix < nowSec` remains eligible but MUST rank below future DUE legs. A negative `gapMins` MUST NOT select the tight-loop sync bucket; sync timing MUST derive from the selected actionable trip, or idle fallback when none exists.

> Source §6: “If no trip is actionable: clear stale action outputs; use the normal idle sync interval; do not enter a three-minute loop solely because a past departure time produces a negative gap.”

**Exception:** active manual trips remain eligible outside the active published generation.

### INV-0.8 — Stop-padding exactly once

Stop padding MUST be applied exactly once. Route duration, stop duration, event/drop-in duration, and arrival buffer remain distinct. `durationSecs` is route-only and MUST NOT include `stopPadSecs`; `stopPadSecs` is applied to the gap to the next leg (or represented by the leg’s `stopDurationSecs`), never both.

> Source §0.8: “Do not add `stopPadSecs` to both the leg duration and the forward-propagation gap.”

**Exception:** none.

## ADDED Requirements

### AC-8 — Stop duration detail

Given a leg with `pendingStopsRaw="5,10"`, when compiled, then its `durationSecs` MUST exclude the 15-minute total; the following leg’s `depTarget` MUST be advanced by exactly 15 minutes, not 30.

### AC-9 — Stale departure detail

Given a master with one past `depUnix` and one future `depUnix`, when Dispatcher selects sync timing, then it MUST select the future actionable leg and MUST NOT allow the past leg to block it.

### AC-10 — No actionable trip detail

Given an empty `Itin_Master` or an all-past master, when Dispatcher has no actionable trip, then it MUST clear stale outputs and use normal idle sync of at least 60 minutes. Sixty minutes is the first-slice default and MAY become configurable later.

### EVT-STALE_DEPARTURE_REJECTED — Minimum dispatcher event

When Dispatcher rejects a stale departure, it MUST emit structured JSON:

```json
{"timestamp": 0, "generationId": null, "component": "Dispatcher", "severity": "WARN", "code": "STALE_DEPARTURE_REJECTED", "tripId": "<tripId-or-null>", "details": {}}
```

`generationId: null` is a Phase-2 placeholder; all other §17 shape fields are required.

### EVT-IDLE_SYNC_ENGAGED — Minimum dispatcher event

When no actionable trip triggers idle fallback, Dispatcher MUST emit:

```json
{"timestamp": 0, "generationId": null, "component": "Dispatcher", "severity": "INFO", "code": "IDLE_SYNC_ENGAGED", "tripId": null, "details": {"syncIntervalMins": 60}}
```

`generationId: null` is a Phase-2 placeholder; all other §17 shape fields are required.
