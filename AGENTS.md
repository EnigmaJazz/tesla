# Code Review Rules

Tasker JavaScript scheduler for a Tesla. Runs inside the Tasker Android
automation engine, not Node.js. There is no test runner, no linter, no
type checker, no formatter — code review is the safety net.

The scheduler is mid-upgrade against a 19-section architectural
specification (Phase 0 invariants are the immediate priority; later
phases introduce typed protocols, atomic publication, and a trip
lifecycle model). The spec is the source of truth for behaviour. These
rules are the high-signal subset the reviewer should look for on every
commit.

## Hard rules — any violation is blocking

- **No silent state inference.** Every persistent value the planner or
  dispatcher relies on must be explicit on the leg or in trip state.
  Reconstructing departure policy, origin, or completion from location,
  leg order, or event type is forbidden.
- **No zero-duration published travel leg.** If a route duration cannot
  be established, the leg must be rejected or logged. Zero is never an
  acceptable fallback.
- **No unbounded time conditions.** Expressions like
  `departUnix - now <= 86400` are forbidden. Actionability requires an
  explicit relevance deadline.
- **No `id.split("_")[0]` for occurrence IDs.** The separator is
  `lastIndexOf("_")`; the suffix is a base-36 Unix timestamp.
- **No substring matching for event/series IDs.** Overrides and learned
  preferences use exact-key maps. `indexOf(eventId)` membership checks
  are forbidden.
- **No synthetic return for an empty day.** A return-to-base leg
  requires an explicit policy (manual, recovery, EOD, safety, vehicle).
  Unplanned movement is observation, not a planning instruction.
- **No day-boundary crossing chains.** Pending drop-in lookahead, ASAP
  propagation, and route chains must terminate at the local planning day.
  Day comparisons use the configured timezone and must be DST-safe.
- **No stale itinerary override of live location.** A fresh planning
  pass honours live `User_At_Base` and active trip state ahead of
  legacy itinerary assumptions.
- **No completion transferring ASAP to a later trip.** Tomorrow's first
  trip must remain `PLANNED` and `JIT` after today's trip completes.
- **No stop padding applied twice.** Stop duration and route duration
  are distinct. `stopPadSecs` may not be added to both the leg duration
  and the forward-propagation gap.
- **No direct writes to the published itinerary.** Entry-point scripts
  submit commands; they do not rewrite `Itin_Master.*` or
  `TDS_Master.*`. One writer per resource.
- **No negative-gap loops.** A past departure producing a negative gap
  must not enter a tight polling loop. Idle sync is the fallback.

## Single-writer contract

| File | Writer |
| --- | --- |
| `TDS_Run_Manifest.json`, `TDS_Master.*`, `Itin_Master.*` | Generation Publisher |
| `TDS_Trip_State.json` | Trip State Reducer |
| `TDS_Overrides.json`, `TDS_Routine_Preferences.json` | Override Handler |
| `TDS_Manual_Trips.json`, `TDS_Action_Sessions.json` | Manual Action Handler |
| `TDS_Route_Cache.json`, `TDS_Order_Cache.json` | Route Cache Manager |

Any other script that writes one of these is a bug.

## Script responsibility

- `Alpha.js` — event ingestion only. No published-itinerary mutation.
- `Finaliser.js` — geocodes, validates final events, validates local-day
  boundaries, publishes staged master data, delegates location-state
  transitions to the Trip State Reducer.
- `Compiler.js` — accumulates the full itinerary for one generation.
  Never publishes one leg at a time.
- `Sandbox_Engine.js` — emits typed planning instructions with explicit
  `departurePolicy`. Until the typed protocol lands, exports
  `block_step17` (route duration seconds), `block_step18` (route
  distance), `block_step19` (departure policy).
- `Gatekeeper.js` — returns typed cache-hit/API-required decisions.
  Never reorders master files directly.
- `API_JSON_Build.js` / `API_Parser.js` — build and validate route
  requests. Parser must discard stale-generation responses; updates
  caches through the cache manager only.
- `Dispatcher.js` — performs vehicle actions only. Never determines
  trip completion. Sync timing comes from the selected actionable trip.
- `Dashboard.js` — reads one committed generation. Uses stable `tripId`
  for actions. Distinguishes future JIT trips from currently
  actionable trips.
- `Appender.js`, `Override_Injector.js` — command adapters. No direct
  file writes.
- `Return_to_Base.js`, `Depart_Now.js`, `Unlock.js` — manual-action
  command adapters.
- `Stop_Logger.js` — submits stable stop-completion commands.
- `TDS_Helper.js` — read-only during migration. No generic setter.

## Logging expectations

Significant state mutations and rejections must be logged in structured
JSON with `timestamp`, `generationId`, `component`, `severity`, `code`,
`tripId`, `details`. Required event codes include
`LIVE_BASE_OVERRIDES_LEGACY_ORIGIN`, `OVERNIGHT_BOUNDARY_CREATED`,
`CROSS_DAY_CHAIN_REJECTED`, `SYNTHETIC_RETURN_SUPPRESSED`,
`FUTURE_TRIP_NOT_DUE`, `STALE_TRIP_REJECTED`,
`REDUNDANT_EOD_RETURN_REJECTED`, `ZERO_DURATION_LEG_REJECTED`,
`DEPARTURE_POLICY_FALLBACK_USED`, `GENERATION_VALIDATION_FAILED`,
`STALE_API_RESPONSE_DISCARDED`. Free-form console output is not a
substitute.

## Code style

- The codebase mixes ES5 (`var`) and ES6 (`let`/`const`). New code
  uses `let`/`const`. Do not refactor legacy `var` to `let` in
  unrelated commits.
- No magic numbers. Constants for route radii (150-200m arrival,
  250-300m departure), grace periods, and bucket sizes must be named.
- Errors should be handled, not swallowed. Intentional fallbacks log
  with the appropriate event code.
- No new dependencies. This is a closed-environment Tasker engine.
- Do not introduce Node-style `setTimeout` / `setInterval` /
  `Promise` constructs that don't exist in the Tasker runtime.
