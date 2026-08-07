# Itinerary Scheduler Specification

> **Status:** First slice (tasker-tesla-upgrade) applied 2026-07-19; second slice (tasker-tesla-upgrade-slice-2) applied 2026-07-19; follow-up port (tasker-tesla-followup-id-override-port) applied 2026-08-02. AC-8, AC-9, AC-10 PASS via harness (slice 1); AC-1, AC-6 PASS via harness (slice 2). ID-2 strict occurrence-ID parsing, RULE-8C override single writer (seven former writers consolidated to staged commands/transient globals), and SCRIPT-15 adapter responsibility PASS via harness (follow-up port: harness/test_id_parsing.js, harness/test_single_writer.js, 17/17 suite green). Phase 0 follow-ups (tasker-tesla-phase0-followups) applied 2026-08-05: AC-3, AC-5, AC-7, sub-items 0B and 0E, synthetic-return suppression, INV-0.7 zero-duration fallback, and Sandbox OVR-10 cleanup PASS via harness (harness/test_ac3_sandbox.js, harness/test_ac5.js, harness/test_sandbox_ovr10.js, plus extended AC-6/DST/departure-day/compiler harnesses; 20/20 suite green; see §22). Phase 4 (tasker-tesla-upgrade-phase-4-central-state-commands) applied 2026-08-05: CMD-9 serial typed `TDS State Command` router with a 25-command exact owner table (Reducer 16, Override 4, Manual Action Handler 4, Publisher 1), RULE-8D Manual Action Handler sole ownership of sessions/manual trips, MANUAL-13 session-authoritative actions (lock migration-only), STOP-14, CLUSTER-12 reorder admission (pre-build committed generation + trusted legacy-null), SCRIPT-15 command-adapter responsibility, and LOG-17 PASS via harness (24/24 suite green; archive consolidated 14/14 reqs, 16/16 scenarios; see §23). Phase 5 (tasker-tesla-upgrade-phase-5-typed-protocols) applied 2026-08-07: typed JSON `block_queue` envelope with block_step17–21 retirement, Route Cache Manager sole-writer JSON caches with TTL/Welford, request correlation with `STALE_API_RESPONSE_DISCARDED`, and direct-reader parity that rejects invalid cache entries (CACHE_ENTRY_REJECTED LOG-17) — PASS via harness post-remediation (28/28 suite green; archive consolidated 7/7 reqs, 12/12 scenarios; see §24). Phases 1 and 6 and the remaining roadmap are open.

**Authority:** canonicalised from `_spec_source.md` (verbatim source). Requirements use RFC 2119 terms; source-section references are evidence pointers. Exceptions are only those stated below.

## Objective

Upgrade the Tasker scheduler while preserving existing behaviour where possible: correct current routing/dispatch failures; plan from calendar/time; confirm progress from location/actions; make policy and identity explicit; bound stale work; publish atomically; and assign persistent-state ownership. **Evidence:** source Objective.

## §0 Immediate behavioural invariants

### INV-0.1 — Explicit departure policy
Every planned leg MUST carry `departurePolicy: "ASAP"` or `"JIT"`; the planning engine owns it. Compiler and Dispatcher MUST consume it and MUST NOT reconstruct it from location, leg order, event type, or prior-base state. Use ASAP for between-event/attached chains, recovery, returns, manual travel, and due/in-progress legs; use JIT for a first/base/future post-overnight trip unless active state supersedes it. A multi-leg chain is ASAP when any continuation requires it. Compiler MUST use the specified `pendingChain.some(...)` `chainForcesASAP` check. **Evidence:** source §0.1. **Exception:** compatibility checks MAY remain, but explicit policy is authoritative.

The Planner (Sandbox) MUST emit `departurePolicy: "ASAP"|"JIT"` as the 19th positional column in `block_queue` and as `block_step19`. The Compiler MUST read `block_step19` and MUST NOT reconstruct policy from `pitstopState`, `_IN` suffix, or `EOD_RETURN` mode. An EOD return is a return-by-policy and MUST always be ASAP.

### INV-0.2 — Day-boundary reset
A later local calendar day MUST close the current day, create an appropriate return when plausibly away, start the next day at base unless trip state proves otherwise, and terminate drop-ins/pending chains at the boundary. Same-location consecutive-day events MUST NOT suppress the return. Day comparisons MUST use configured local timezone and be DST-safe; fixed-second “same day” inference is forbidden. **Evidence:** §0.2. **Exception:** active trip state can contradict base reset.

### INV-0.3 — Live origin precedence
Fresh-generation origin precedence is: active manual trip; active `IN_PROGRESS`; live location/`User_At_Base`; last confirmed trip-state destination; legacy itinerary. Stale itinerary MUST NOT override reliable live base; a future-day first event with no active trip starts at base. **Evidence:** §0.3. **Exception:** previous itinerary is compatibility fallback only.

On a fresh pass, when `oldItin.length > 0` and `global('User_At_Base') === "true"`, Sandbox MUST set `simAtBase = true` regardless of the prior itinerary's reconstructed `pitstopState`. Legacy itinerary is consulted only when the live priority chain yields no answer. Active `IN_PROGRESS` is approximated by `/(Driving|Walking|Public Transport|Lift)/i.test(currentStatus)`.

### INV-0.4 — No synthetic empty-day return
Unplanned movement on a day without remaining planned travel is observation, not a planning instruction. Return is permitted only for explicit Return to Base, active-chain recovery, completed-day EOD policy, or explicit safety/vehicle rule. **Evidence:** §0.4. **Exception:** those four explicit policies.

### INV-0.5 — Future-trip isolation after return
Returning home completes the current manual/active trip and makes live origin base; tomorrow’s first trip remains `PLANNED` and JIT, inherits no ASAP policy, and is unselectable before its due window. Complete/reselect before scheduling the next vehicle action. **Evidence:** §0.5. **Exception:** none.

### INV-0.6 — Actionable-trip bounds

The Dispatcher MUST NOT use an unbounded condition such as `departUnix - now <= 86400`, because it admits indefinitely stale trips. A candidate is actionable only when non-terminal, active-generation or active-manual, before relevance deadline, meaningful in timing/destination, not newer-equivalent-replaced, and predecessor-satisfied.

For this slice, a leg with `depUnix < nowSec - relevanceDeadline` is stale and MUST be excluded from candidate selection. A leg where `nowSec - relevanceDeadline <= depUnix < nowSec` remains eligible but MUST rank below future DUE legs. A negative `gapMins` MUST NOT select the tight-loop sync bucket; sync timing MUST derive from the selected actionable trip, or idle fallback when none exists.

> Source §6: "If no trip is actionable: clear stale action outputs; use the normal idle sync interval; do not enter a three-minute loop solely because a past departure time produces a negative gap."

**Exception:** active manual trips remain eligible outside the active published generation.

### INV-0.7 — Route-duration fallback
Migration contract: `block_step17` route duration seconds, `block_step18` route distance, `block_step19` departure policy. Compiler fallback order MUST be validated API metrics, Sandbox metrics, supported local active-travel estimate, then reject/log. Zero-duration planned travel MUST NOT publish. **Evidence:** §0.7. **Exception:** none.

### INV-0.8 — Stop-padding exactly once

Stop padding MUST be applied exactly once. Route duration, stop duration, event/drop-in duration, and arrival buffer remain distinct. `durationSecs` is route-only and MUST NOT include `stopPadSecs`; `stopPadSecs` is applied to the gap to the next leg (or represented by the leg's `stopDurationSecs`), never both.

> Source §0.8: "Do not add `stopPadSecs` to both the leg duration and the forward-propagation gap."

**Exception:** none.

## §1 Core architectural model

### RULE-1A — Event ingestion
Normalise Google Calendar events/tags; generate occurrence/series identity; geocode; migrate/apply overrides; validate events; emit `TDS_Events.<generationId>.json`. **Evidence:** §1A. **Exception:** none.

### RULE-1B — Planning engine
Establish origin from live/persisted state; identify local days; assign policy; select modes/routes/cache; simulate lateness/drop-ins/pitstops/recovery/EOD; compile complete itinerary; emit `Itin_Master.<generationId>.json`. **Evidence:** §1B. **Exception:** none.

### RULE-1C — Observation and trip-state engine
Track departures, arrivals, completion, manual/unplanned/completed stops, expiry, regeneration reconciliation, live origin, and prevention of stale-itinerary override; emit `TDS_Trip_State.json`. **Evidence:** §1C. **Exception:** none.

### RULE-1D — Publication and action
Validate/commit complete generations; select unfinished trip; perform Tesla actions; render dashboard and manual actions; prevent policy transfer to future trips. **Evidence:** §1D. **Exception:** Dispatcher does not decide completion.

## §2 Identity model — ID-2
Occurrence format MUST remain `<GoogleCalendarEventId>_<base36StartUnix>`. Explicit fields are `eventId`, `seriesId`, and numeric `instanceStartUnix`. `eventId` identifies an occurrence; `seriesId` a recurring event; `tripId` a leg; `stopId` a planned stop; `generationId` a build; `actionId` a manual session. Parse at `id.lastIndexOf("_")`; validate a plausible base-36 Unix suffix; MUST NOT use `id.split("_")[0]`. IDs MUST NOT encode IN/OUT/PIT/EOD/recovery/manual/overnight semantics; store those in `legType`. **Evidence:** §2. **Exception:** none.

## §3 Canonical schemas — SCH-3
Event records MUST contain the source §3 event fields, including identity, calendar timing, location/coords, type, mode, buffer, and stops. Legs MUST contain the source §3 leg fields, including `tripId`, identities, `generationId`, `legType`, mode, `departurePolicy`, `originSource`, `planningDay`, route/timing, `relevanceDeadlineUnix`, `durationSecs`, `stopDurationSecs`, distance, and completion policy. Policy is ASAP/JIT; `originSource` records origin rationale; `planningDay` is local; relevance deadline bounds overdue selection; stop duration remains separate. Valid origin sources: `ACTIVE_MANUAL_TRIP`, `ACTIVE_PLANNED_TRIP`, `LIVE_BASE`, `LIVE_LOCATION`, `CONFIRMED_LAST_DESTINATION`, `OVERNIGHT_BASE_RESET`, `LEGACY_ITINERARY_FALLBACK`. Trip state MUST contain source §3 schema/revision/current-origin/trip-observation fields. **Evidence:** §3. **Exception:** none.

## §4 Trip lifecycle — TRIP-4
States: `PLANNED`, `DUE`, `IN_PROGRESS`, `ARRIVED`, `COMPLETED`, `MISSED`, `SUPERSEDED`, `CANCELLED`; terminal: COMPLETED/MISSED/SUPERSEDED/CANCELLED. Transitions are as specified: due-window opening; movement/navigation/Depart Now to in progress; location arrival; completion policy; deadline expiry; replacement to superseded. Completion MUST NOT mutate another policy or make a later-day trip DUE. Arrival radius 150–200m, departure 250–300m; prefer two arrival samples unless well inside with acceptable accuracy. **Evidence:** §4. **Exception:** stated sample-quality exception.

## §5 Planning-day and chains — PLAN-5
Every event/leg MUST have timezone-derived `planningDay`; `currentPlanningDay !== nextPlanningDay` terminates drop-in attachment, ASAP/route/stop-delay propagation, and prior-location assumptions. Final away-from-base activity creates same-day `EOD_RETURN`/ASAP/ARRIVAL; next first leg is base/JIT unless active state contradicts. Drop-ins attach only within same day, feasible chain, and no explicit boundary; lookahead stops at local midnight. Fresh pass trusts live base over prior itinerary. Unplanned movement remains observation unless INV-0.4 permits return. **Evidence:** §5. **Exception:** active trip-state contradiction and explicit return policies.

## §6 Dispatcher selection — SEL-6
Dispatcher MUST rank: active manual; `IN_PROGRESS`; overdue DUE within relevance deadline; currently due; next future PLANNED. Before ranking exclude terminal, inactive-generation, expired, cancelled-event, redundant return while confirmed base, future-day/not-opened, and manual-superseded trips. Deadlines: explicit drop-in; strict event end plus grace; recovery arrival+2h; EOD end of day; manual action expiry; fallback arrival+4h. Dispatcher performs vehicle actions only; sync timing comes from selected actionable trip. If none, clear stale outputs, use normal idle interval, and never three-minute-loop from a negative gap. **Evidence:** §6. **Exception:** active manual ranks first.

## §7 Atomic publication — PUB-7

Published files MUST NOT be cleared or incrementally rebuilt. The Generation Publisher SHALL validate and publish complete, versioned event/master/itinerary generations, write the manifest last, and preserve the prior committed generation on any failure. Every reader SHALL discover only committed data through manifest-declared paths and SHALL follow the specified prior-or-empty fallback. **Evidence:** §7. **Exception:** none.

## §8 Persistent-state ownership — OWN-8

Each resource SHALL have one writer:

| Rule | Writer | Resources |
|---|---|---|
| RULE-8A | Generation Publisher | `TDS_Run_Manifest.json`, `TDS_Events.<generation>.json`, `TDS_Master.<generation>.json`, `Itin_Master.<generation>.json` |
| RULE-8B | Trip State Reducer | `TDS_Trip_State.json` |
| RULE-8C | Override Handler | `TDS_Overrides.json`, `TDS_Routine_Preferences.json` |
| RULE-8D | Manual Action Handler | `TDS_Manual_Trips.json`, `TDS_Action_Sessions.json` |
| RULE-8E | Route Cache Manager | `TDS_Route_Cache.json`, `TDS_Order_Cache.json` |

Entry points MUST submit commands, not directly rewrite domain files. `TDS_Routine_Preferences.json` holds `Route_Defaults` and `Route_History`; Override Handler is its sole writer. `TDS_Overrides.json` MUST have Override Handler as its sole writer. `Depart_Memory`, `Completed_Stops`, `Completed_Dropins`, and `Arrival_Memory` remain ephemeral globals pending Phase 3 migration to `TDS_Trip_State.json`. **Evidence:** §8. **Exception:** none.

## §9 Command handling — CMD-9
One serialised `TDS State Command` accepts `%par1` command type and `%par2` JSON payload. Commands: `SET_OVERRIDE`, `REMOVE_OVERRIDE`, `DEPART_NOW`, `RETURN_TO_BASE`, `COMPLETE_STOP`, `START_UNPLANNED_STOP`, `END_UNPLANNED_STOP`, `CANCEL_ACTION`, `RESET_ACTIONS`, `OBSERVE_DEPARTURE`, `OBSERVE_ARRIVAL`, `COMPLETE_TRIP`, `EXPIRE_TRIP`. Tasker MUST execute serially to prevent overlapping read-modify-write. **Evidence:** §9. **Exception:** none.

## §10 Overrides and preferences — OVR-10
Overrides MUST be schema-v2 exact-key `eventOverrides` maps keyed by occurrence ID; learned `seriesPreferences` MUST be separate, keyed by series ID plus route signature. Direct user overrides use occurrence ID; learned defaults use series identity/signature. Every `indexOf(eventId)` membership check MUST be removed. **Evidence:** §10. **Exception:** none.

## §11 Route cache — CACHE-11
Preserve spatial matches across buckets; validate temporary DRIVE/TRANSIT entries by day type/time bucket; retain unbucketed WALK caching; add TTLs; migrate delimiter records to JSON; cache manager is sole writer. Key: origin cell, destination cell, mode, weekday/weekend, time bucket. Cache miss/invalidity MUST NOT publish zero-duration travel. **Evidence:** §11. **Exception:** WALK has no time bucket.

## §12 Cluster optimisation — CLUSTER-12
Destination MUST NOT appear in intermediates. Requests carry `generationId`/`clusterId`; stale-generation results are discarded; Gatekeeper/API Parser never reorder published masters; planner consumes result before publication. Clusters MUST NOT cross local planning-day boundary or combine prior-day drop-in with next-day event. **Evidence:** §12. **Exception:** none.

## §13 Manual actions — MANUAL-13
Depart Now records `IN_PROGRESS`, `manualDeparture`, and actual departure while preserving planned times and separate estimated arrival; applies only selected trip. Return to Base creates unique manual-trip request, not committed-itinerary prepend; Dispatcher prioritises it. Completion confirms base, completes trip, closes action session, leaves future trips unchanged, and does not make tomorrow due. Action sessions replace global lock and contain source §13 action metadata/scopes. **Evidence:** §13. **Exception:** none.

## §14 Stops — STOP-14
Completed stops move from overrides to trip state. Planned IDs are `stop:<eventId>:<ordinal>`; stops MUST NOT be identified only by duration. Unplanned stops are explicit state for delay attribution and MUST NOT imply automatic EOD return. **Evidence:** §14. **Exception:** explicit INV-0.4 return policies.

## §15 Script responsibility map — SCRIPT-15

| Script | Responsibility | Owner |
|---|---|---|
| `Alpha.js` | Ingest/normalise, identity/day, migration; never clear published itinerary | (no write, ingest only) |
| `Finaliser.js` | Geocode/validate events and days; stage master; delegate location; isolate clustering | Generation Publisher |
| `Sandbox_Engine.js` | Plan origin/policy/day boundaries/EOD; emit typed instructions and migration blocks 17–19 | (no persistent writer, planning engine) |
| `Compiler.js` | Compile whole generation; fallback duration; once-only stops; stage output | Generation Publisher |
| `Gatekeeper.js` | Typed cache/API decisions; never reorder master | (no write, cache decision only) |
| `API_JSON_Build.js` | Typed request payloads with request/cluster/generation IDs | (no write, request builder) |
| `API_Parser.js` | Validate typed routes; discard stale; cache only via manager | Route Cache Manager |
| `Dashboard.js` | Read committed generation, stable actions/state display | (no write, reader) |
| `Dispatcher.js` | Lifecycle selection, bounded sync, Tesla actions; never completion | (no write, action only) |
| `Appender.js` | Command adapter | (no direct write) |
| `Override_Injector.js` | Command adapter | (no direct write) |
| `Return_to_Base.js` | Manual-action command adapter | (no direct write) |
| `Depart_Now.js` | Manual-action command adapter | (no direct write) |
| `Unlock.js` | Manual-action command adapter | (no direct write) |
| `Stop_Logger.js` | Stable stop-completion command | (no direct write) |
| `TDS_Helper.js` | Read-only migration helper; no generic setter | (no write) |
| `Default.js` | No §15 responsibility stated | (no assigned writer) |

**Discrepancy:** the inline §15 inventory says 18 scripts but repeats `API_Parser.js`; the listed set is 17 scripts. This record flags rather than silently corrects the source. **Evidence:** §15. **Exception:** none.

## §16 Implementation sequence and acceptance
Phase 0 is immediate priority before Phase 1: policy propagation, overnight boundary, live origin, empty-day movement, post-return isolation, stale containment, and route/duration contract. Phases 1–6 are the source §16 roadmap (data correctness; atomic publication; lifecycle; commands; typed protocols; decomposition). **Evidence:** §16. **Exception:** none.

| ID | Acceptance criterion |
|---|---|
| AC-1 | Between-event travel: previous event completes away; next leg ASAP. |
| | Detail: Given a head leg with `block_step19 === "ASAP"`, when Compiler schedules it, then `actualHeadDeparture` MUST equal `hardFloor`. Given `block_step19 === "JIT"`, then `actualHeadDeparture` MUST equal `Math.max(hardFloor, headLeg.depTarget)`. Compiler MUST NOT read `isPrevBase` from `pitstopState`, `_IN` suffix, or `EOD_RETURN` mode. |
| AC-2 | Attached end-of-day drop-in return uses ASAP. |
| AC-3 | Same-location overnight: today gets EOD return; tomorrow begins base/JIT. |
| AC-4 | Empty-day ad-hoc walk creates no synthetic return or three-minute loop. |
| AC-5 | Return home: tomorrow remains future PLANNED, not due now. |
| AC-6 | Stale-away itinerary loses to live base; future trip base/JIT. |
| | Detail: Given `Itin_Master` has a stale leg with `pitstopState: "handled"`, `User_At_Base: "true"`, and `Base_Arrival_Unix` = `nowSec`, when Sandbox runs its first planning pass, then `simAtBase` MUST be `true`, `targetEventId` MUST be the home base, and an `EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN` flash MUST be present. |
| AC-7 | Queue flush never removes/bypasses day boundary. |
| AC-8 | "stop padding changes timing exactly once." |
| | Detail: Given a leg with `pendingStopsRaw="5,10"`, when compiled, then its `durationSecs` MUST exclude the 15-minute total; the following leg's `depTarget` MUST be advanced by exactly 15 minutes, not 30. |
| AC-9 | "an expired past leg cannot block the next valid trip." |
| | Detail: Given a master with one past `depUnix` and one future `depUnix`, when Dispatcher selects sync timing, then it MUST select the future actionable leg and MUST NOT allow the past leg to block it. |
| AC-10 | "stale outputs are cleared; normal idle polling is used." |
| | Detail: Given an empty `Itin_Master` or an all-past master, when Dispatcher has no actionable trip, then it MUST clear stale outputs and use normal idle sync of at least 60 minutes. |

## §17 Error logging — LOG-17
Significant failures/state decisions MUST use append-only structured JSON: `timestamp`, `generationId`, `component`, `severity`, `code`, `tripId`, `details`. Required codes:
`EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN`, `EVT-OVERNIGHT_BOUNDARY_CREATED`, `EVT-CROSS_DAY_CHAIN_REJECTED`, `EVT-SYNTHETIC_RETURN_SUPPRESSED`, `EVT-FUTURE_TRIP_NOT_DUE`, `EVT-STALE_TRIP_REJECTED`, `EVT-REDUNDANT_EOD_RETURN_REJECTED`, `EVT-ZERO_DURATION_LEG_REJECTED`, `EVT-DEPARTURE_POLICY_FALLBACK_USED`, `EVT-GENERATION_VALIDATION_FAILED`, `EVT-STALE_API_RESPONSE_DISCARDED`, `EVT-IDLE_SYNC_ENGAGED`. **Evidence:** §17. **Exception:** none.

## §18 Validation and testing — VAL-18
Deterministically validate all source §18 scenarios: ordinary/ASAP/late/missed/GPS/drop-in/overnight/stops/cache/cluster/stale API/failed rebuild/active trip/live-base/ad-hoc/manual/future/stale/redundant-return/idle/manual/event removal/DST/local-midnight cases. Run shadow mode before publication switch; compare origin, policy, planning day, EOD returns, selected trip, timing, deadline, and sync interval; log old/new divergence. **Evidence:** §18. **Exception:** none.

## §19 Definition of done — DOD-19
Immediate stabilisation requires the ten source §19 behaviours: ASAP chains; overnight integrity; live base; no empty-day return; no future-trip promotion; no stale three-minute loop; nonzero duration fallback; and once-only stop padding. Full upgrade additionally requires atomic consistent generations, plausible overdue work, location confirmation, non-mutating manual actions, bounded stale work, exact identities, writer ownership, attributable logging, consistent policy, explicit tested overnight boundaries, and live state precedence. **Evidence:** §19. **Exception:** none.

## §20 Phase 2 — Atomic Publication Requirements

Requirements introduced by Phase 2 (atomic publication) supplementing PUB-7 and OWN-8.

### Requirement: Generation ID Format

The Generation Publisher SHALL mint each ID as `gen:<unixSec>:<4hex>`, where `unixSec` is exactly 10 decimal Unix-seconds digits and `4hex` is exactly four lowercase hexadecimal characters. It SHALL reject malformed IDs and SHALL mint another suffix if the candidate already exists.

#### Scenario: Collision avoidance
- GIVEN an existing generation has the candidate ID
- WHEN another generation is minted in the same second
- THEN the Publisher SHALL mint a different valid suffix

#### Scenario: Parsing
- GIVEN `gen:1784369000:ab12`
- WHEN a consumer parses it
- THEN it SHALL obtain `1784369000` and `ab12`

### Requirement: Generation Lifecycle States

Each candidate generation SHALL enter `building`, then transition to exactly one terminal state: `committed` after successful publication or `failed` after validation/publication failure. Its manifest state SHALL represent that outcome; failure SHALL log `GENERATION_VALIDATION_FAILED` and SHALL NOT promote the candidate.

#### Scenario: Build begins
- GIVEN no candidate generation
- WHEN the Publisher starts a generation
- THEN its state SHALL be `building`

#### Scenario: Successful transition
- GIVEN a generation in `building`
- WHEN every resource and the manifest are published
- THEN its state SHALL become `committed`

#### Scenario: Failed transition
- GIVEN a generation in `building`
- WHEN validation or publication fails
- THEN its state SHALL become `failed` and SHALL NOT later become `committed`

### Requirement: TDS Run Manifest Schema

`TDS_Run_Manifest.json` SHALL be updated only by the Generation Publisher and SHALL contain: `schemaVersion` (positive schema integer), `activeGeneration` (current readable ID), `previousGeneration` (recovery ID immediately preceding the current attempt, or `null`), `publishedAt` (Unix seconds), `writer` (`Generation Publisher`), `eventsPath`, `masterPath`, and `itineraryPath` (exact co-located resource paths), `eventCount` (records at `eventsPath`), `legCount` (leg records at `masterPath`), `itineraryCount` (entries at `itineraryPath`), and `state` (`building|committed|failed`). Counts SHALL equal their validated resources.

#### Scenario: First publication
- GIVEN no prior manifest
- WHEN generation A commits
- THEN active SHALL be A, previous SHALL be `null`, and counts SHALL match

#### Scenario: Superseding publication
- GIVEN committed generation A
- WHEN generation B commits
- THEN active SHALL be B and previous SHALL be A

#### Scenario: Failed publication
- GIVEN committed generation A and candidate B
- WHEN B fails
- THEN active and previous SHALL be A and state SHALL be `failed`

### Requirement: Versioned File Naming

The Publisher SHALL co-locate resources in the existing data directory as `TDS_Events.<fileGen>.json`, `TDS_Master.<fileGen>.json`, and `Itin_Master.<fileGen>.json`. `<fileGen>` SHALL replace each `:` in the canonical ID with `_`; manifest generation fields retain colons and path fields contain the encoded filenames.

#### Scenario: Colon-safe encoding
- GIVEN generation `gen:1784369000:ab12`
- WHEN paths are assigned
- THEN `<fileGen>` SHALL be `gen_1784369000_ab12`

### Requirement: Manifest-Last Publication Order

The Publisher SHALL write events, master, itinerary, then manifest. Published files MUST NOT be cleared or incrementally rebuilt. Until the final manifest succeeds, the prior committed pointer SHALL remain authoritative; a failed candidate SHALL be recoverable by a later generation.

#### Scenario: Successful order
- GIVEN a validated candidate
- WHEN it is published
- THEN writes SHALL occur events → master → itinerary → manifest

#### Scenario: Events write fails
- GIVEN a prior committed manifest
- WHEN the events write fails
- THEN the candidate SHALL fail, no later write SHALL occur, and the prior pointer SHALL remain authoritative

#### Scenario: Master write fails
- GIVEN events were written
- WHEN the master write fails
- THEN the candidate SHALL fail, later writes SHALL stop, and the prior pointer SHALL remain authoritative

#### Scenario: Itinerary write fails
- GIVEN events and master were written
- WHEN the itinerary write fails
- THEN the candidate SHALL fail, the commit manifest SHALL NOT be written, and the prior pointer SHALL remain authoritative

#### Scenario: Manifest write fails
- GIVEN all candidate resources were written
- WHEN the manifest write fails
- THEN the prior committed manifest SHALL remain authoritative and the candidate SHALL be failed

### Requirement: Committed Generation Discovery

Readers including Dispatcher, Dashboard, and Finaliser SHALL read the manifest first and SHALL consume only the exact paths it declares. A committed active generation is preferred; otherwise readers SHALL use the last readable prior generation when available, or an empty state with idle dispatch when none exists.

#### Scenario: Active generation
- GIVEN a valid committed manifest for A
- WHEN a reader loads scheduler data
- THEN it SHALL read only A's declared paths

#### Scenario: Prior-generation fallback
- GIVEN the manifest is absent, corrupt, unreadable, or non-committed and a prior generation is known
- WHEN a reader loads scheduler data
- THEN it SHALL read that prior generation

#### Scenario: Empty fallback
- GIVEN no readable active or prior generation
- WHEN a reader loads scheduler data
- THEN it SHALL return empty data and Dispatcher SHALL use idle sync

### Requirement: Generation ID Propagation

On commit the Publisher SHALL set `TDS_Active_Generation` to the canonical ID. All eleven structured-log placeholder sites identified by the proposal SHALL use that global rather than `null`. The global SHALL be cleared when publication fails and SHALL begin empty after application restart.

#### Scenario: Commit
- GIVEN generation A commits
- WHEN structured events are emitted
- THEN the global and each placeholder SHALL contain A

#### Scenario: Failure
- GIVEN a candidate publication fails
- WHEN failure handling completes
- THEN the global SHALL be empty

#### Scenario: Restart
- GIVEN the application restarts
- WHEN no generation has committed in that process
- THEN the volatile global SHALL be empty

### Requirement: RULE-8A Remediation

Only the Generation Publisher SHALL write `TDS_Events.*.json`, `TDS_Master.*.json`, `Itin_Master.*.json`, or `TDS_Run_Manifest.json`. Gatekeeper and API Parser SHALL emit typed reorder commands for application before commit; Alpha SHALL NOT clear or otherwise touch published masters.

#### Scenario: Gatekeeper write removal
- GIVEN Gatekeeper decides a cluster reorder
- WHEN it returns the decision
- THEN the write formerly at `Gatekeeper.js:56` SHALL NOT occur

#### Scenario: API Parser write removal
- GIVEN API Parser decides a cluster reorder
- WHEN it returns the decision
- THEN the write formerly at `API_Parser.js:33` SHALL NOT occur

#### Scenario: Alpha clear removal
- GIVEN Alpha starts ingestion
- WHEN published files already exist
- THEN the clears formerly at `Alpha.js:392–393` SHALL NOT occur

### Requirement: Generation Retention

After successful commit, the Publisher SHALL prune committed generations beyond `PHASE2_RETENTION = 5`, retaining current plus four previous committed generations. It SHALL NOT prune committed recovery data before commit; failed generations MAY be pruned immediately.

#### Scenario: Normal retention
- GIVEN five retained committed generations
- WHEN a sixth commits
- THEN only the newest five SHALL remain

#### Scenario: Rapid commits
- GIVEN successive commits exceed retention
- WHEN each commit completes
- THEN pruning SHALL retain the newest five regardless of elapsed time

#### Scenario: First commit
- GIVEN no prior generation
- WHEN the first generation commits
- THEN it SHALL remain and no committed generation SHALL be pruned

### Requirement: Legacy Master Migration

On the first Phase 2 commit, validated `TDS_Master.json` and `Itin_Master.json` MAY seed the new generation. The Publisher SHALL write versioned resources before switching the manifest, SHALL make legacy names non-authoritative at that switch, SHALL cut all readers over together, and SHALL retain `TDS_Master.legacy.json` and `Itin_Master.legacy.json` for one release.

#### Scenario: First migration
- GIVEN valid legacy masters and no manifest
- WHEN the first Phase 2 generation commits
- THEN versioned resources SHALL be active and both legacy backups SHALL exist

#### Scenario: Rollback
- GIVEN retained legacy backups
- WHEN Phase 2 is rolled back within one release
- THEN the backups SHALL restore the legacy readable state before versioned publication is disabled

**Evidence:** Phase 2 delta spec. **Exception:** none.

## §21 Follow-up Port — ID Parsing and Override Ownership Requirements

Requirements introduced by the follow-up port (tasker-tesla-followup-id-override-port) supplementing ID-2, RULE-8C, CMD-9, OVR-10, PUB-7, SCRIPT-15, LOG-17, and VAL-18.

### Requirement: Strict Occurrence-ID Parsing

Occurrence IDs MUST split at `lastIndexOf("_")`. The non-empty core MAY contain underscores; the base-36 suffix MUST decode within `[1000000000, 2500000000)`. All parser copies MUST reject invalid input without applying it. (ID-2, SCRIPT-15.)

#### Scenario: Valid ID
- GIVEN `google_abc123_kx8f00`
- WHEN an occurrence consumer parses it
- THEN it MUST return core `google_abc123` and Unix value `1265143536`

#### Scenario: Invalid ID
- GIVEN an empty, separator-free, empty-core, trailing-garbage, or out-of-range ID
- WHEN parsing is attempted
- THEN the consumer MUST reject and skip the occurrence or command

#### Scenario: Rejection logging
- GIVEN an ID is rejected
- WHEN the rejection is handled
- THEN JSON MUST use `ID_PARSE_REJECTED`, LOG-17 fields, `details.rawId`, and `details.reason`

### Requirement: Override Resource Single Writer

Only Override Handler MUST write `TDS_Overrides.json` or `TDS_Routine_Preferences.json`. The seven former writers—Alpha, Appender, Compiler, Default, Finaliser, Override Injector, and Stop Logger—MUST use staged commands or documented transient globals. (RULE-8C, SCRIPT-15.)

#### Scenario: Seven-writer ownership guard
- GIVEN each former writer attempts its supported workflow
- WHEN the harness records resource writes
- THEN only Override Handler MAY write either protected file, and unauthorized writes MUST be rejected

### Requirement: Serialized Override Command API

Override Handler MUST process serial commands with `par1` as operation and `par2` as JSON payload. Adapters MUST stage the next Handler action; the harness MAY call `handler(op, payload)`. Membership MUST use exact-key maps, never substrings. (CMD-9, OVR-10.)

#### Scenario: APPLY_OVERRIDE
- GIVEN a valid occurrence and override category
- WHEN `APPLY_OVERRIDE` runs
- THEN it MUST toggle that exact key and remove only exact conflicting-category keys

#### Scenario: APPEND_OVERRIDE
- GIVEN a valid occurrence, category, and route context
- WHEN `APPEND_OVERRIDE` runs
- THEN it MUST append the exact override and update compatible learned history

#### Scenario: SET_DEFAULT
- GIVEN a route preference key and set, clear, or clear-all intent
- WHEN `SET_DEFAULT` runs
- THEN it MUST update `Route_Defaults` and related `Route_History` consistently

#### Scenario: PRUNE
- GIVEN current time, whitelist, persisted overrides, and transient memories
- WHEN `PRUNE` runs
- THEN it MUST preserve whitelisted/relevant exact IDs, remove expired IDs, and retain bounded timing

#### Scenario: Substring decoy
- GIVEN `abc123_kx8f00` and `xyzabc123_kx8f00` coexist
- WHEN the first key is removed or moved
- THEN the second key MUST remain unchanged

### Requirement: Protected Preference Migration

On first Handler use, legacy `Route_Defaults` and `Route_History` MUST migrate once to preferences and leave overrides. Deployment MUST snapshot both resources; failure MUST preserve original bytes, and rollback MUST restore prior bytes or absence. (RULE-8C, OVR-10.)

#### Scenario: Successful migration
- GIVEN legacy values exist only in `TDS_Overrides.json`
- WHEN the Handler first runs
- THEN preferences MUST contain both values and overrides MUST contain neither key

#### Scenario: Failed migration rollback
- GIVEN protected snapshots and an injected write failure
- WHEN migration cannot complete
- THEN original data MUST remain recoverable without a partial authoritative state

### Requirement: Injector Committed-Generation Input

`Override_Injector.js` MUST use `readActiveGeneration('itinerary')`, including its legacy fallback, and MUST NOT create a divergent reader. (PUB-7, SCRIPT-15.)

#### Scenario: Manifest-backed injection
- GIVEN a manifest names the active versioned itinerary
- WHEN an override is injected
- THEN the target MUST come from that committed generation and dispatch through Override Handler

### Requirement: Verification and Status Evidence

The harness MUST cover parsing, four operations, exact keys, migration/rollback, manifest input, and ownership. Passing status evidence MUST cover only ID-2/RULE-8C/SCRIPT-15, not AC-3/5/7, synthetic/manual returns, or Sandbox OVR-10 cleanup. (VAL-18.)

#### Scenario: Evidence update
- GIVEN every scoped harness assertion passes
- WHEN canonical status evidence is updated
- THEN it MUST identify the scoped tests and preserve all stated exclusions as open

**Evidence:** follow-up port delta spec. **Exception:** none.

## §22 Phase 0 Follow-ups — Day Boundaries, Post-Return Isolation, Duration Fallback, and Exact Key Identity

Requirements introduced by the Phase 0 follow-up change (tasker-tesla-phase0-followups) completing AC-3, AC-5, and AC-7, sub-items 0B and 0E, synthetic-return suppression, INV-0.7 zero-duration fallback, and Sandbox OVR-10 cleanup. Supplements INV-0.2, INV-0.4, INV-0.5, INV-0.7, §2 ID-2, §4 TRIP-4, §5 PLAN-5, §6 SEL-6, §10 OVR-10, §11 CACHE-11, §13 MANUAL-13, §15 SCRIPT-15, and LOG-17.

### Requirement: REQ-AC3-1 — Explicit overnight handoff

The planner MUST create today's `EOD_RETURN`/ASAP and tomorrow's base-origin `PLANNED`/JIT head leg when same-location events cross local midnight. It MUST NOT infer the boundary from `_IN`.

#### Scenario: Same-location across midnight

- GIVEN same-location away-from-base events on consecutive local days
- WHEN the planner builds their legs
- THEN today MUST end with an EOD return and tomorrow MUST begin base/JIT
- AND `EVT-OVERNIGHT_BOUNDARY_CREATED` MUST be logged

### Requirement: REQ-AC3-2 / REQ-0B-1 — DST-safe planning day

Every leg MUST receive a timezone-derived `planningDay`; fixed-second day inference MUST NOT be used.

#### Scenario: DST-transition day

- GIVEN events span local midnight on a DST-transition day
- WHEN their planning days are assigned
- THEN the boundary MUST follow the configured timezone
- AND each leg MUST belong to the correct local day

### Requirement: REQ-AC7-1 — Boundary-safe queue flush

Queue flushing and chain propagation MUST stop at, and MUST NOT consume work beyond, the local planning-day boundary.

#### Scenario: End-of-day flush

- GIVEN current-day work reaches an EOD flush while tomorrow remains queued
- WHEN the flush executes
- THEN tomorrow's entries MUST survive unchanged
- AND `EVT-CROSS_DAY_CHAIN_REJECTED` MUST be logged for rejected propagation

### Requirement: REQ-AC5-1 / REQ-0E-1 — Manual-return completion

Confirmed base arrival MUST submit `COMPLETE_TRIP`, complete today's manual return, and leave later-day trips unchanged.

#### Scenario: Manual return completes today

- GIVEN an active manual return and a planned trip tomorrow
- WHEN base arrival is confirmed
- THEN today's trip MUST become `COMPLETED`
- AND tomorrow MUST remain `PLANNED` and JIT

### Requirement: REQ-AC5-2 — Future-day selection isolation

Dispatcher MUST NOT select a future planning-day trip before its due window.

#### Scenario: Tomorrow is the only candidate

- GIVEN tomorrow's `PLANNED`/JIT trip is the only remaining candidate
- WHEN Dispatcher selects actionable work today
- THEN it MUST select no trip
- AND `EVT-FUTURE_TRIP_NOT_DUE` MUST be logged

### Requirement: REQ-INV0_4-1 — Observable synthetic-return suppression

Unplanned empty-day movement MUST NOT create a return unless an existing permitted policy applies.

#### Scenario: Unplanned empty-day movement

- GIVEN movement occurs with no remaining planned travel or permitted return policy
- WHEN planning runs
- THEN no return leg MUST be created
- AND `EVT-SYNTHETIC_RETURN_SUPPRESSED` MUST be logged

### Requirement: REQ-INV0_7-1 — Nonzero duration fallback

Compiler MUST use validated API metrics, Sandbox metrics, or a supported local active-travel estimate, in that order; otherwise it MUST reject the leg. Zero-duration travel MUST NOT publish.

#### Scenario: Cache miss

- GIVEN validated API metrics are unavailable and positive Sandbox metrics exist
- WHEN Compiler resolves travel duration
- THEN it MUST use the Sandbox metrics and publish a positive duration
- AND `EVT-DEPARTURE_POLICY_FALLBACK_USED` MUST be logged

### Requirement: REQ-OVR10-1 — Exact-key Sandbox reads

Sandbox override and preference membership MUST use exact keys, never substring matching.

#### Scenario: Decoy occurrence IDs ev_1 vs ev_10

- GIVEN exact keys `ev_1` and `ev_10` coexist
- WHEN Sandbox reads or changes `ev_1`
- THEN `ev_10` MUST remain unchanged

### Requirement: REQ-OVR10-2 — Last-underscore core parsing

Sandbox MUST derive `coreId` using the final underscore and a valid base-36 Unix suffix.

#### Scenario: Core containing underscores team_event_alpha_kx8f00

- GIVEN occurrence ID `team_event_alpha_kx8f00`
- WHEN Sandbox parses it
- THEN the core MUST be `team_event_alpha`
- AND the suffix MUST be validated independently

### Requirement: REQ-LOG-1 — Structured decision evidence

Boundary, isolation, suppression, and fallback decisions MUST append JSON containing `timestamp`, `generationId`, `component`, `severity`, `code`, `tripId`, and `details`.

#### Scenario: Decision is logged

- GIVEN a covered decision occurs
- WHEN its evidence is emitted
- THEN `code` MUST be the applicable `EVT-OVERNIGHT_BOUNDARY_CREATED`, `EVT-CROSS_DAY_CHAIN_REJECTED`, `EVT-FUTURE_TRIP_NOT_DUE`, `EVT-SYNTHETIC_RETURN_SUPPRESSED`, or `EVT-DEPARTURE_POLICY_FALLBACK_USED`
- AND every required `LOG-17` field MUST be present

**Evidence:** Phase 0 follow-ups delta spec. **Exception:** none.

## §23 Phase 4 — Central State Commands

Requirements introduced by Phase 4 (tasker-tesla-upgrade-phase-4-central-state-commands) supplementing CMD-9, OWN-8/RULE-8D, MANUAL-13, STOP-14, CLUSTER-12, SCRIPT-15, and LOG-17.

### Requirement: REQ-4CMD-1

`TDS_State_Command` MUST serially validate `par1`/`par2`, route only to Reducer, Override Handler, Manual Action Handler, or Publisher, and reject without mutation.

#### Scenario: SCN-4CMD-1 [EVT: `STATE_COMMAND_ROUTED`]
- GIVEN a supported envelope
- WHEN routed
- THEN exactly one declared owner MUST receive it

#### Scenario: SCN-4CMD-2 [EVT: `STATE_COMMAND_REJECTED`]
- GIVEN malformed JSON or an unknown command
- WHEN validated
- THEN no owner or file MUST change

### Requirement: REQ-4ADAPTER-1

Appender MUST stage exact-ID `APPEND_OVERRIDE` and MUST NOT write state.

#### Scenario: SCN-4ADAPTER-1 [EVT: `STATE_COMMAND_ROUTED`]
- GIVEN a valid occurrence ID
- WHEN Appender runs
- THEN Override Handler MUST receive `APPEND_OVERRIDE`

### Requirement: REQ-4ADAPTER-2

Override Injector MUST stage exact-ID `APPLY_OVERRIDE` and MUST NOT write state.

#### Scenario: SCN-4ADAPTER-2 [EVT: `STATE_COMMAND_ROUTED`]
- GIVEN a valid occurrence ID
- WHEN Override Injector runs
- THEN Override Handler MUST receive `APPLY_OVERRIDE`

### Requirement: REQ-4ADAPTER-3

Depart Now MUST stage `DEPART_NOW`; only its selected lifecycle MAY change.

#### Scenario: SCN-4ADAPTER-3 [EVT: `STATE_COMMAND_ROUTED`]
- GIVEN a selected trip
- WHEN Depart Now runs
- THEN only it MAY become `IN_PROGRESS`

### Requirement: REQ-4ADAPTER-4

Return to Base MUST stage `RETURN_TO_BASE`, never serialize/prepend candidates.

#### Scenario: SCN-4ADAPTER-4 [EVT: `SESSION_OPENED`]
- GIVEN an explicit return request
- WHEN accepted
- THEN one unique manual trip/session MUST replace no itinerary

### Requirement: REQ-4ADAPTER-5

Stop Logger MUST stage `COMPLETE_STOP` with stable `stopId`, never write state.

#### Scenario: SCN-4ADAPTER-5 [EVT: `STATE_COMMAND_ROUTED`]
- GIVEN a stable `stopId`
- WHEN Stop Logger runs
- THEN Reducer MUST receive `COMPLETE_STOP`

### Requirement: REQ-4ADAPTER-6

Unlock MUST stage typed session release and MUST NOT clear files.

#### Scenario: SCN-4ADAPTER-6 [EVT: `SESSION_CLOSED`]
- GIVEN an active session
- WHEN Unlock runs
- THEN only that session MUST close

### Requirement: REQ-4ADAPTER-7

Finaliser MUST stage typed completion/release and MUST NOT clear action state.

#### Scenario: SCN-4ADAPTER-7 [EVT: `SESSION_CLOSED`]
- GIVEN manual-return completion at base
- WHEN Finaliser releases it
- THEN future JIT trips MUST remain unchanged

### Requirement: REQ-4SESSION-1

Manual Action Handler MUST solely write `TDS_Action_Sessions.json` and `TDS_Manual_Trips.json`; sessions MUST identify action, scope, lifecycle, trip.

#### Scenario: SCN-4SESSION-1 [EVT: `SESSION_OPENED`]
- GIVEN a valid manual action
- WHEN accepted
- THEN only that owner MUST commit its records

### Requirement: REQ-4SESSION-2

`TDS_Action_Lock.json` MUST be migration-only, non-authoritative, and Handler-clearable. `test_ac5` MUST replace "never write sessions" with owner/lifecycle assertions.

#### Scenario: SCN-4SESSION-2 [EVT: `LOCK_COMPATIBILITY_CLEARED`]
- GIVEN session completion and a legacy lock
- WHEN cleaned
- THEN tomorrow's trip MUST remain unchanged

### Requirement: REQ-4REORDER-1

Producers MUST stage `ENQUEUE_REORDER`; State Command MUST solely enqueue and Publisher MUST drain/clear `TDS_Reorder_Commands.json` every publish. Producers MUST NOT rewrite masters or retain `remaining`.

#### Scenario: SCN-4REORDER-1 [EVT: `REORDER_COMMAND_ENQUEUED`]
- GIVEN an exact cluster reorder
- WHEN submitted
- THEN the router MUST append without published writes

#### Scenario: SCN-4REORDER-2 [EVT: `REORDER_QUEUE_DRAINED`]
- GIVEN accepted and rejected commands
- WHEN publication ends
- THEN the queue MUST be empty

### Requirement: REQ-4REORDER-2

`APPLY_CLUSTER_REORDER` MUST match the pre-build committed generation, never the minted ID; stale/malformed commands MUST NOT apply.

#### Scenario: SCN-4REORDER-3 [EVT: `REORDER_COMMAND_REJECTED`, `STALE_REORDER_COMMAND_REJECTED`]
- GIVEN current, stale, malformed, and permitted legacy-null commands
- WHEN Publisher validates them
- THEN only current and permitted legacy-null commands MUST apply

### Requirement: REQ-4HELPER-1

`TDS_Helper` MUST expose only `readOrigin` and `readActiveGeneration`; generic getters, setters, and unknown operations MUST be rejected.

#### Scenario: SCN-4HELPER-1 [EVT: `HELPER_REQUEST_REJECTED`]
- GIVEN generic/unknown input
- WHEN Helper receives it
- THEN it MUST reject without persistent writes

### Requirement: REQ-4LOG-1

Every mutation/rejection MUST log `timestamp`, `generationId`, `component`, `severity`, `code`, `tripId`, `details`; listed EVT codes MUST remain stable.

#### Scenario: SCN-4LOG-1 [EVT: applicable Phase 4 code]
- GIVEN a mutation or rejection
- WHEN logged
- THEN all LOG-17 fields MUST exist

**Evidence:** Phase 4 delta spec. **Exception:** none.

## §24 Phase 5 — Typed Protocols

Requirements introduced by Phase 5 (tasker-tesla-upgrade-phase-5-typed-protocols) supplementing INV-0.1, INV-0.7, OWN-8/RULE-8E, RULE-8A, CLUSTER-12, CACHE-11, SCRIPT-15, LOG-17, and VAL-18. Replaces delimiter/positional queue transport with one validated typed JSON envelope; correlates every route callback against active generation and latest request state; and puts all cache mutation behind a Tasker-style `%par1`/`%par2` Route Cache Manager.

### Requirement: REQ-5QUEUE-1

Sandbox MUST emit `block_queue` as `{schemaVersion,rows,eof,skipIdxUntil,stepConflict,notifications}` JSON. Compiler MUST `JSON.parse` it inside its JSlet; Tasker Variable Split MUST NOT process it. Rows MUST contain `rowType,title,coords,mode,displayTime,departTime,pitstopState,apiTimeType,apiTimeUnix,evId,evLoc,engineLateMins,currentLegStable,dropinStatusFlag,safeDesc,adHoc,routeDurationSecs,routeDistanceMiles,departurePolicy,planningDay,originSource`.

#### Scenario: SCN-5QUEUE-1 [EVT: `TYPED_QUEUE_ACCEPTED`]
- GIVEN a valid envelope
- WHEN Compiler parses it
- THEN rows and EOF/skip/conflict/notification controls MUST retain their values

#### Scenario: SCN-5QUEUE-2 [EVT: `TYPED_QUEUE_REJECTED`]
- GIVEN malformed JSON, unsupported schema, or an invalid row
- WHEN Compiler validates it
- THEN it MUST reject the queue without compiling partial rows

### Requirement: REQ-5CUTOVER-1

Sandbox MUST shadow dual-emit head `block_step17–21` until cutover. Typed metrics, policy, day, and origin MUST then be authoritative; all step 17–21 producers/consumers MUST retire with JSON conversion. INV-0.7 MUST resolve validated API metrics, positive typed Sandbox metrics, supported local active-travel estimate, then reject/log.

#### Scenario: SCN-5CUTOVER-1 [EVT: `TYPED_QUEUE_SHADOW_DIVERGENCE`]
- GIVEN shadow values differ from the typed row
- WHEN equivalence is checked
- THEN divergence MUST be logged and typed authority MUST NOT be enabled

#### Scenario: SCN-5CUTOVER-2 [EVT: `TYPED_QUEUE_CUTOVER_COMPLETED`]
- GIVEN shadow equivalence passes
- WHEN cutover occurs
- THEN steps 17–21 MUST have no producer or consumer

#### Scenario: SCN-5CUTOVER-3 [EVT: `EVT-ZERO_DURATION_LEG_REJECTED`]
- GIVEN API and typed Sandbox durations are unavailable or nonpositive
- WHEN no supported estimate exists
- THEN Compiler MUST reject the leg and MUST NOT publish zero-duration travel

### Requirement: REQ-5REQID-1

API JSON Build MUST stamp `{generationId,clusterId,requestId}`; callbacks MUST retain it. Route Cache Manager MUST solely write `TDS_Route_Request_State.json` as `{schemaVersion,updatedAt,latestByCluster}`, exact-keyed by cluster with those IDs and request timestamps.

#### Scenario: SCN-5REQID-1 [EVT: `ROUTE_REQUEST_REGISTERED`]
- GIVEN an active-generation route request
- WHEN it is issued
- THEN latest correlation MUST be manager-recorded and callback-retained

### Requirement: REQ-5REQID-2

API Parser MUST exactly correlate callbacks with `TDS_Active_Generation` and latest request state. Mismatch MUST log `STALE_API_RESPONSE_DISCARDED` and MUST NOT update caches or enqueue reorder work.

#### Scenario: SCN-5REQID-2 [EVT: `STALE_API_RESPONSE_DISCARDED`]
- GIVEN generation, cluster, or request ID mismatch
- WHEN the callback is parsed
- THEN no cache or reorder state MUST change

#### Scenario: SCN-5REQID-3 [EVT: `ROUTE_RESPONSE_ACCEPTED`]
- GIVEN all three IDs exactly match active state
- WHEN a valid response is parsed
- THEN typed mutations MAY recurse through their declared owners

### Requirement: REQ-5CACHE-1

Route Cache Manager MUST have sole-writer ownership of `TDS_Route_Cache.json`, `TDS_Order_Cache.json`, `Temp_Route_Cache.json`, and request state. Alpha/API Parser MUST submit typed mutations. Gatekeeper/Sandbox MUST use manager reads or documented read-only JSON and MUST NOT write them.

#### Scenario: SCN-5CACHE-1 [EVT: `CACHE_WRITE_REJECTED`]
- GIVEN any non-manager attempts a protected write
- WHEN ownership is enforced
- THEN the write MUST be rejected without file mutation

### Requirement: REQ-5CACHE-2

Caches MUST contain `schemaVersion`, `updatedAt`, and exact-key entries. Route/temp entries MUST contain origin/destination cells, mode, day class, exact bucket (`null` for WALK), `meanDurationSecs`, `sampleCount`, `m2`, `distanceMiles`, `createdAt`, and `expiresAt`; order entries MUST contain cluster key, result, and expiry. Expired/invalid entries MUST be misses and MUST NOT yield zero-duration legs. WALK uses `bucket:null`.

#### Scenario: SCN-5CACHE-2 [EVT: `ROUTE_CACHE_MUTATED`]
- GIVEN valid DRIVE and WALK samples
- WHEN the manager records them
- THEN Welford fields and TTL MUST update, with an exact DRIVE bucket and null WALK bucket

#### Scenario: SCN-5CACHE-3 [EVT: `CACHE_ENTRY_REJECTED`]
- GIVEN an expired, malformed, or wrong-bucket entry
- WHEN a reader requests it
- THEN it MUST be treated as a miss without mutation

### Requirement: REQ-5LOG-1

Every mutation or rejection MUST emit LOG-17 JSON with `timestamp,generationId,component,severity,code,tripId,details`; the covered Phase 5 codes MUST remain stable.

#### Scenario: SCN-5LOG-1 [EVT: applicable Phase 5 code]
- GIVEN a covered mutation or rejection
- WHEN evidence is emitted
- THEN all LOG-17 fields and the scenario EVT code MUST be present

**Evidence:** Phase 5 delta spec. **Exception:** none.
