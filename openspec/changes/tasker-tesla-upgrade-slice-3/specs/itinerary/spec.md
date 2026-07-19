## MODIFIED Requirements

### INV-0.2 — Day-boundary reset

> A later local calendar day MUST close the current day, create an appropriate return when plausibly away, start the next day at base unless trip state proves otherwise, and terminate drop-ins/pending chains at the boundary. Same-location consecutive-day events MUST NOT suppress the return. Day comparisons MUST use configured local timezone and be DST-safe; fixed-second “same day” inference is forbidden. **Evidence:** §0.2. **Exception:** active trip state can contradict base reset.

For this slice, day-boundary comparisons MUST use UTC math (Unix-second differences, no local-time zones). The rest of the system uses local time for human-facing display. The 12-hour geofence limit, the 7-day horizon, and the cluster's `validEvents` filter MUST use UTC day boundaries.

### INV-0.5 — Future-trip isolation after return

> Returning home completes the current manual/active trip and makes live origin base; tomorrow’s first trip remains `PLANNED` and JIT, inherits no ASAP policy, and is unselectable before its due window. Complete/reselect before scheduling the next vehicle action. **Evidence:** §0.5. **Exception:** none.

When a manual return completes (`setGlobal('TDS_Manual_Return_Completed', nowSec)` is set), the next planning pass MUST keep the next-day first trip `PLANNED` and `JIT`. Sandbox MUST emit `EVT-FUTURE_TRIP_NOT_DUE` to record the override.

## ADDED Requirements

### AC-3 detail — DST-safe same-location overnight

Given a same-location overnight sequence with today's drop-in and tomorrow's strict event, when Sandbox plans across the UTC day boundary, then it MUST create today's EOD return and a base-anchored JIT trip tomorrow. The new DST test MUST verify UTC day-boundary math.

### AC-5 detail — manual return isolates future trip

Given `TDS_Manual_Return_Completed` is set after a manual return, when the next-day planning pass runs, then its first trip MUST remain `PLANNED` and `JIT`. Sandbox MUST read and apply the global override.

### AC-7 detail — UTC chain flush

Given a pending chain crosses a UTC day boundary, when Dispatcher evaluates it, then it MUST terminate the chain at that boundary. Dispatcher's `d1 !== d2` chain break MUST use UTC math.

### EVT-FUTURE_TRIP_NOT_DUE

Sandbox MUST flash at least `{"timestamp":nowSec,"generationId":null,"component":"Sandbox","severity":"INFO","code":"FUTURE_TRIP_NOT_DUE","tripId":"<legId>","details":{"manualReturnCompletedUnix":<unixSec>,"nextDayFirstTripPolicy":"JIT"}}` when applying the manual-return future-trip override.

### EVT-SYNTHETIC_RETURN_SUPPRESSED

Sandbox MUST flash at least `{"timestamp":nowSec,"generationId":null,"component":"Sandbox","severity":"INFO","code":"SYNTHETIC_RETURN_SUPPRESSED","tripId":null,"details":{"reason":"no_planned_activity_today","userAtBase":false}}` when suppressing a return after unplanned empty-day movement. Per INV-0.4, an unplanned walk on an empty day MUST NOT auto-create a return; this event is its audit trail.
