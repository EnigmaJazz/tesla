# Itinerary Phase 5 Delta

> **Status:** Proposed.

## Canonical Impact

- ADDED: queue, request correlation, cache ownership.
- MODIFIED: `INV-0.1; INV-0.7; RULE-8E; CACHE-11; CLUSTER-12; SCRIPT-15; LOG-17; VAL-18`.
- UNCHANGED: `TDS_Depart_Memory`, `TDS_Completed_Stops`, `TDS_Arrival_Memory`, and `TDS_Completed_Dropins` remain string globals until Phase 6; zero-duration, day-boundary, synthetic-return, exact-key, and occurrence-ID invariants remain binding.

## ADDED Requirements

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
Sandbox MUST shadow dual-emit head `block_step17`–`21` until cutover. Typed metrics, policy, day, and origin MUST then be authoritative; all step 17–21 producers/consumers MUST retire with JSON conversion. INV-0.7 MUST resolve validated API metrics, positive typed Sandbox metrics, supported local active-travel estimate, then reject/log.

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
- THEN its typed mutations MAY be submitted to their declared owners

### Requirement: REQ-5CACHE-1
Route Cache Manager MUST solely write `TDS_Route_Cache.json`, `TDS_Order_Cache.json`, `Temp_Route_Cache.json`, and request state. Alpha/API Parser MUST submit typed mutations. Gatekeeper/Sandbox MUST use manager reads or documented read-only JSON and MUST NOT write them.

#### Scenario: SCN-5CACHE-1 [EVT: `CACHE_WRITE_REJECTED`]
- GIVEN any non-manager attempts a protected write
- WHEN ownership is enforced
- THEN the write MUST be rejected without file mutation

### Requirement: REQ-5CACHE-2
Caches MUST contain `schemaVersion`, `updatedAt`, and exact-key entries. Route/temp entries MUST contain origin/destination cells, mode, day class, exact bucket (`null` for WALK), `meanDurationSecs`, `sampleCount`, `m2`, `distanceMiles`, `createdAt`, and `expiresAt`; order entries MUST contain cluster key, result, and expiry. Expired/invalid entries MUST be misses and MUST NOT yield zero-duration legs.

#### Scenario: SCN-5CACHE-2 [EVT: `ROUTE_CACHE_MUTATED`]
- GIVEN valid DRIVE and WALK samples
- WHEN the manager records them
- THEN Welford fields and TTL MUST update, with an exact DRIVE bucket and null WALK bucket

#### Scenario: SCN-5CACHE-3 [EVT: `CACHE_ENTRY_REJECTED`]
- GIVEN an expired, malformed, or wrong-bucket entry
- WHEN a reader requests it
- THEN it MUST be treated as a miss without mutation

### Requirement: REQ-5LOG-1
Every mutation or rejection MUST append LOG-17 JSON fields `timestamp,generationId,component,severity,code,tripId,details`; `STALE_API_RESPONSE_DISCARDED` MUST remain stable.

#### Scenario: SCN-5LOG-1 [EVT: Phase 5 code]
- GIVEN a covered mutation or rejection
- WHEN evidence is emitted
- THEN all LOG-17 fields and the scenario EVT code MUST be present
