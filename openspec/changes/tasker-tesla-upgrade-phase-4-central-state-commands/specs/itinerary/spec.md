# Itinerary Phase 4 Delta

> **Status:** Proposed.

## Canonical Impact

- ADDED: `CMD-9; OWN-8` router, queue, lock compatibility.
- MODIFIED: `RULE-8D; MANUAL-13; STOP-14; CLUSTER-12; SCRIPT-15; LOG-17`.
- UNCHANGED: `INV-0.2; INV-0.4; INV-0.7; ID-2; OVR-10; PUB-7`.

## ADDED Requirements

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
`TDS_Action_Lock.json` MUST be migration-only, non-authoritative, and Handler-clearable. `test_ac5` MUST replace “never write sessions” with owner/lifecycle assertions.

#### Scenario: SCN-4SESSION-2 [EVT: `LOCK_COMPATIBILITY_CLEARED`]
- GIVEN session completion and a legacy lock
- WHEN cleaned
- THEN tomorrow’s trip MUST remain unchanged

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
