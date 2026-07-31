# Spec Delta: itinerary — Phase 3 Trip-State Migration

## Purpose
Phase 3 persists restart-safe progress/origin. Tags map to `harness/test_<tag>.js`.

## ADDED Requirements

### Requirement: Trip State Reducer is the sole writer of TDS_Trip_State.json
The Reducer alone SHALL write state; callers MUST submit serialised commands. Manifest reconciliation SHALL commit generation/supersessions in one revision.

#### Scenario: Unauthorized writer [reducer_commands]
- **GIVEN** another writer
- **WHEN** writing
- **THEN** reject

#### Scenario: Reconciliation [reducer_commands]
- **GIVEN** committed generation
- **WHEN** reconciled
- **THEN** generation/supersessions share one revision

#### Scenario: Concurrency [reducer_commands]
- **GIVEN** same-tick commands
- **WHEN** executed
- **THEN** second reads first commit

### Requirement: Eight-state trip lifecycle
Trips SHALL use `PLANNED|DUE|IN_PROGRESS|ARRIVED|COMPLETED|MISSED|SUPERSEDED|CANCELLED`; transitions MUST be explicit; terminals immutable.

#### Scenario: Progression [trip_lifecycle]
- **GIVEN** PLANNED
- **WHEN** due/departure/arrival/completion triggers occur
- **THEN** advance `DUE>IN_PROGRESS>ARRIVED>COMPLETED`

#### Scenario: Terminals [trip_lifecycle]
- **GIVEN** eligible trip
- **WHEN** deadline/regeneration/cancellation occurs
- **THEN** `MISSED|SUPERSEDED|CANCELLED` respectively

### Requirement: Thirteen-command input protocol
The endpoint SHALL validate generation plus typed payloads: `SET_OVERRIDE(key,value)|REMOVE_OVERRIDE(key)|DEPART_NOW(tripId,at)|RETURN_TO_BASE(actionId,tripId,policy)|COMPLETE_STOP(stopId,at)|START_UNPLANNED_STOP(stopId,at)|END_UNPLANNED_STOP(stopId,at)|CANCEL_ACTION(actionId,at)|RESET_ACTIONS(actionId,at)|OBSERVE_DEPARTURE(tripId,at)|OBSERVE_ARRIVAL(tripId,at,accuracyM)|COMPLETE_TRIP(tripId,at)|EXPIRE_TRIP(tripId,at)`. Overrides MUST delegate without state mutation; others MUST apply named effects.

#### Scenario: Matrix [reducer_commands]
- **GIVEN** each valid schema
- **WHEN** submitted
- **THEN** specified effect occurs

#### Scenario: Invalid [reducer_commands]
- **GIVEN** malformed input
- **WHEN** submitted
- **THEN** reject with structured code

### Requirement: Explicit origin precedence
Per INV-0.3, origin SHALL follow `ACTIVE_MANUAL_TRIP>ACTIVE_PLANNED_TRIP>LIVE_BASE>LIVE_LOCATION>CONFIRMED_LAST_DESTINATION>OVERNIGHT_BASE_RESET>LEGACY_ITINERARY_FALLBACK`; evidence MUST be explicit.

#### Scenario: Precedence [origin_precedence]
- **GIVEN** each adjacent pair
- **WHEN** resolved
- **THEN** earlier source wins

#### Scenario: Inference [origin_precedence]
- **GIVEN** no explicit evidence
- **WHEN** planning
- **THEN** location/order/event-type SHALL NOT imply origin

### Requirement: Explicit empty-day return policy
Per INV-0.4, return SHALL require `MANUAL|RECOVERY|EOD|SAFETY|VEHICLE`; movement remains observation.

#### Scenario: Missing [synthetic_return_rejection]
- **GIVEN** empty day
- **WHEN** policy-less return arrives
- **THEN** suppress and log

#### Scenario: Policies [synthetic_return_rejection]
- **GIVEN** each allowed policy
- **WHEN** requested
- **THEN** accept matching return

### Requirement: Local planning-day boundary
Per INV-0.2, local boundaries SHALL be DST-safe; chains MUST stop there.

#### Scenario: Cross-day [day_boundary]
- **GIVEN** different local days
- **WHEN** chained
- **THEN** reject

#### Scenario: DST [day_boundary]
- **GIVEN** DST transition
- **WHEN** days resolve
- **THEN** preserve local dates

#### Scenario: UTC [day_boundary]
- **GIVEN** UTC/local dates differ
- **WHEN** compared
- **THEN** local date governs

### Requirement: Four override-state keys migrate to trip state
`Depart_Memory|Completed_Stops|Completed_Dropins|Arrival_Memory` SHALL be trip-state-only.

#### Scenario: Keys [reducer_commands]
- **GIVEN** each key
- **WHEN** read
- **THEN** state wins; reject legacy

### Requirement: Five globals migrate to reducer-managed state
`User_At_Base|Base_Arrival_Unix|TDS_Lateness_Halt|Current_Status|TDS_Manual_Return_Completed` SHALL be state-backed; globals MAY project committed state.

#### Scenario: Globals [reducer_commands]
- **GIVEN** each value
- **WHEN** read
- **THEN** state wins; reject legacy

### Requirement: Central active-generation resolution
Five resolution paths SHALL share one read-only resolver; copies MUST be removed.

#### Scenario: Readers [reducer_commands]
- **GIVEN** each reader
- **WHEN** resolving
- **THEN** central resolver SHALL run

### Requirement: Thirty-day retention
Records beyond 30 local days SHALL be pruned next commit; active/manual/current-generation records are exempt.

#### Scenario: Pruning [reducer_commands]
- **GIVEN** unexempt day 31
- **WHEN** reducer commits
- **THEN** prune within that revision

#### Scenario: Exemptions [reducer_commands]
- **GIVEN** each exemption
- **WHEN** retention runs
- **THEN** preserve

### Requirement: Trip-state schema versioning
State SHALL use `schemaVersion:1` plus monotonic `revision`; mutations increment once; schema changes MUST migrate.

#### Scenario: Revision [reducer_commands]
- **GIVEN** current state
- **WHEN** mutation commits
- **THEN** increment once

#### Scenario: Compatibility [reducer_commands]
- **GIVEN** future schema/revision or older revision
- **WHEN** loaded
- **THEN** accept supported valid data; otherwise reject explicitly

### Requirement: Atomic state and observable failures
State SHALL pass write/read-back before projection. Events MUST contain `timestamp,generationId,component,severity,code,tripId,details` and applicable `EVT-GENERATION_VALIDATION_FAILED|EVT-STALE_TRIP_REJECTED`.

#### Scenario: Write [reducer_commands]
- **GIVEN** read-back mismatch
- **WHEN** validated
- **THEN** stop projection and log

#### Scenario: Observability [reducer_commands]
- **GIVEN** projection failure or significant event
- **WHEN** logged
- **THEN** audit/reconciliation fields and applicable code SHALL exist

## MODIFIED Requirements
None.

## REMOVED Requirements
None.
