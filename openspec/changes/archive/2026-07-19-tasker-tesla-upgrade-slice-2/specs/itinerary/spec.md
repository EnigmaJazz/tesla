## MODIFIED Requirements

### INV-0.1 — Explicit departure policy

> Every planned leg MUST carry `departurePolicy: "ASAP"` or `"JIT"`; the planning engine owns it. Compiler and Dispatcher MUST consume it and MUST NOT reconstruct it from location, leg order, event type, or prior-base state. Use ASAP for between-event/attached chains, recovery, returns, manual travel, and due/in-progress legs; use JIT for a first/base/future post-overnight trip unless active state supersedes it. A multi-leg chain is ASAP when any continuation requires it. Compiler MUST use the specified `pendingChain.some(...)` `chainForcesASAP` check. **Evidence:** source §0.1. **Exception:** compatibility checks MAY remain, but explicit policy is authoritative.

The Planner (Sandbox) MUST emit `departurePolicy: "ASAP"|"JIT"` as the 19th positional column in `block_queue` and as `block_step19`. The Compiler MUST read `block_step19` and MUST NOT reconstruct policy from `pitstopState`, `_IN` suffix, or `EOD_RETURN` mode. An EOD return is a return-by-policy and MUST always be ASAP.

### INV-0.3 — Live origin precedence

> Fresh-generation origin precedence is: active manual trip; active `IN_PROGRESS`; live location/`User_At_Base`; last confirmed trip-state destination; legacy itinerary. Stale itinerary MUST NOT override reliable live base; a future-day first event with no active trip starts at base. **Evidence:** §0.3. **Exception:** previous itinerary is compatibility fallback only.

On a fresh pass, when `oldItin.length > 0` and `global('User_At_Base') === "true"`, Sandbox MUST set `simAtBase = true` regardless of the prior itinerary's reconstructed `pitstopState`. Legacy itinerary is consulted only when the live priority chain yields no answer. Active `IN_PROGRESS` is approximated by `/(Driving|Walking|Public Transport|Lift)/i.test(currentStatus)`.

## ADDED Requirements

### AC-1 detail — explicit policy timing

Given a head leg with `block_step19 === "ASAP"`, when Compiler schedules it, then `actualHeadDeparture MUST equal hardFloor`. Given `block_step19 === "JIT"`, then `actualHeadDeparture MUST equal Math.max(hardFloor, headLeg.depTarget)`. Compiler MUST NOT read `isPrevBase` from `pitstopState`, `_IN` suffix, or `EOD_RETURN` mode.

### AC-6 detail — stale-away itinerary loses to live base

Given `Itin_Master` has a stale leg with `pitstopState: "handled"`, `User_At_Base: "true"`, and `Base_Arrival_Unix: nowSec`, when Sandbox runs its first planning pass, then `simAtBase MUST be true`, `targetEventId MUST be the home base`, and an `EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN` flash MUST be present.

### EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN

Sandbox MUST flash at least `{"timestamp":nowSec,"generationId":null,"component":"Sandbox","severity":"WARN","code":"LIVE_BASE_OVERRIDES_LEGACY_ORIGIN","tripId":null,"details":{"oldItinLength":N,"userAtBase":"true","priorSimAtBase":false}}` when live base overrides legacy origin.

### EVT-DEPARTURE_POLICY_FALLBACK_USED

As a migration safety net, Sandbox MUST flash at least `{"timestamp":nowSec,"generationId":null,"component":"Sandbox","severity":"WARN","code":"DEPARTURE_POLICY_FALLBACK_USED","tripId":"<legId>","details":{"block_step19":null,"reconstructed":"ASAP"}}` when explicit policy is unavailable. It MUST NOT fire in steady state after this slice.
