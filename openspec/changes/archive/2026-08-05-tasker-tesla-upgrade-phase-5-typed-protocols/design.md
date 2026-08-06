# Design: Phase 5 — Typed Protocols

## Technical Approach

Replace delimiter transport with one validated queue envelope, correlate every route callback, and put all cache mutation behind a Tasker-style `%par1`/`%par2` Route Cache Manager. Production remains standalone JSlets: no imports, dependencies, promises, or timers.

## Architecture Decisions

| Choice | Alternative | Rationale |
|---|---|---|
| Parse and validate the complete envelope once before compiling rows. | Tasker Variable Split/partial parsing. | Prevents column leakage and partial compilation. |
| Use exact-key JSON maps and manager commands. | Shared text-file writes. | Enforces RULE-8E and atomic read-modify-write. |
| Correlate generation, cluster, and latest request. | Generation-only check. | Rejects superseded callbacks in the same generation. |
| Keep transient completion globals unchanged. | Expand Phase 5. | Their reducer migration belongs to Phase 6. |

## Queue Contract and Cutover

`block_queue` is JSON:

```text
{schemaVersion:1,rows:TypedRow[],eof:boolean,skipIdxUntil:integer,
 stepConflict:string|null,notifications:string[]}
TypedRow={rowType:string,title:string,coords:string,mode:string,
 displayTime:integer,departTime:integer,pitstopState:string,
 apiTimeType:string,apiTimeUnix:integer,evId:string,evLoc:string,
 engineLateMins:number,currentLegStable:boolean,dropinStatusFlag:string,
 safeDesc:string,adHoc:number[],routeDurationSecs:positive integer|null,
 routeDistanceMiles:positive number|null,departurePolicy:"ASAP"|"JIT",
 planningDay:"YYYY-MM-DD",originSource:SCH3OriginSource}
```

Sandbox changes `enqueuePlannedRow(fields,...)` to `buildTypedRow(row)` and converts all 11 current invocations (the proposal's nine-site count predates recovery/EOD variants) from arrays to objects. Tail locals map atomically: `queue→rows`, `EOF→eof`, `skip_idx_until→skipIdxUntil`, `step_conflict→stepConflict`, and `notifQueue` (formerly `^^` joined) directly to `notifications`. EOF is an empty-row envelope. Compiler calls `JSON.parse(local('block_queue'))` once, validates every row, then iterates `compileTypedRow`; malformed input logs `TYPED_QUEUE_REJECTED` and compiles nothing.

Commit 1 in PR1 adds typed parsing plus shadow dual-emission of head `block_step17`–`21`; divergence logs `TYPED_QUEUE_SHADOW_DIVERGENCE` and rejects typed activation. Commit 2, in the same PR after equivalence tests pass, makes row metrics/policy/day/origin authoritative and removes every step 17–21 producer, consumer, fixture, and Tasker split. INV-0.7 becomes API metrics → positive `row.routeDurationSecs`/`routeDistanceMiles` → supported `ACTIVE_TRAVEL` estimate → `EVT-ZERO_DURATION_LEG_REJECTED`.

## Correlation and Cache Manager

```text
API_JSON_Build → REGISTER_REQUEST → Route_Cache_Manager → request state
HTTP callback → temp_payload {correlation,response} → API_Parser
API_Parser → exact active/latest check → cache/reorder commands | stale reject
```

The builder creates `req:<unixSec>:<4hex>`, an exact cluster ID from destination plus ordered waypoint IDs (or route cells/mode), and an internal `{generationId,clusterId,requestId,routeRequest}` body. The HTTP projection sends only `routeRequest`; callback staging retains `{correlation:{generationId,clusterId,requestId},response}`. Parser compares correlation with `TDS_Active_Generation` and `latestByCluster[clusterId].requestId`; any missing/mismatched field logs LOG-17 `STALE_API_RESPONSE_DISCARDED` and performs no cache/reorder mutation. The manager revalidates, removes an accepted latest record, and prunes records from other generations or older than named `REQUEST_TTL_SECS`.

`Route_Cache_Manager.js` accepts `REGISTER_REQUEST`, `PUT_TEMP_SAMPLE`, `PUT_ORDER_RESULT`, `ROLLUP_DUE_TEMP`, and `PRUNE`; it snapshots, writes, read-backs, and restores like Override Handler. Schemas are:

```text
TDS_Route_Cache.json={schemaVersion:1,updatedAt,entries:{routeKey:RouteEntry}}
Temp_Route_Cache.json={schemaVersion:1,updatedAt,entries:{routeKey:RouteEntry}}
RouteEntry={originCell,destinationCell,mode,dayClass,bucket,
 meanDurationSecs,sampleCount,m2,distanceMiles,createdAt,updatedAt,expiresAt}
TDS_Order_Cache.json={schemaVersion:1,updatedAt,entries:{clusterKey:
 {clusterKey,result:string[],createdAt,expiresAt}}}
TDS_Route_Request_State.json={schemaVersion:1,updatedAt,latestByCluster:
 {clusterId:{generationId,clusterId,requestId,emittedAt}}}
```

Keys are exact; DRIVE/TRANSIT use exact day/bucket keys, WALK uses `bucket:null`. Expired, malformed, wrong-bucket, or nonpositive entries are misses. Named TTL constants are master 30 days, temp 24 hours, order 7 days, request 2 hours. Alpha stages the existing capped-Welford/outlier rollup instead of lines 69–193 writes; API Parser stages session/order samples. Manager alone migrates legacy text, temporarily projects compatibility text, then PR4 retires it. Gatekeeper/Sandbox parse documented read-only JSON and probe adjacent 200m cells; they never mutate.

| Resource | Sole writer |
|---|---|
| `TDS_Route_Cache.json`, `TDS_Order_Cache.json` | Route Cache Manager |
| `Temp_Route_Cache.json`, `TDS_Route_Request_State.json` | Route Cache Manager |

## Four-PR Chain, Tests, and Rollback

| PR | Scope / estimate | Verification and revert boundary |
|---|---|---|
| 1 | Queue shadow + cutover, 350–400 | Add `test_typed_queue.js`; revise `test_ac3_sandbox`, `test_dst_utc`, `test_sandbox_ac6`, `test_compiler_ac1`, `test_atomic_publication`, `test_id_parsing`, `test_ac5`, and `test_sandbox_ovr10`. Revert both commits together. |
| 2 | Manager core/schemas/guards, 250–300 | Add `test_route_cache_manager.js`; extend `mock_tasker.js` guards. Revert manager and restore cache snapshots. |
| 3 | Request correlation, 150–250 | Add `test_request_correlation.js`; stale callback proves no cache/reorder writes. Revert builder/parser while retaining manager. |
| 4 | Alpha/API Parser migration and Gatekeeper/Sandbox JSON reads, 150–200 (manager total 400–500) | TTL/Welford/WALK/order fixtures; retire text projection. Revert readers and restore compatibility snapshots. |

Every PR includes its harness changes, `node --check`, focused RED/GREEN evidence, then all 24 baseline scripts; top-level entry identifiers use unique names/`var` to avoid shared-vm redeclaration.

## Threat Matrix and Risks

| Boundary | Applicability / response | RED tests |
|---|---|---|
| Documentation-like paths | N/A — no executable classification. | None |
| Git repository selection | N/A — no Git invocation. | None |
| Commit state | N/A — no commit automation. | None |
| Push state | N/A — no push automation. | None |
| PR commands | N/A — no PR automation. | None |

| Risk | Level | Mitigation |
|---|---|---|
| Metadata leaks into the Google wire body. | CRITICAL | Separate internal envelope from `routeRequest` projection; callback fixture checks retention. |
| Cache cutover changes route selection. | CRITICAL | Snapshot migration, adjacent-cell/bucket parity, per-slice rollback. |
| A slice exceeds 400 lines. | WARNING | Stop under `ask-on-risk`; split without separating tests. |

## Open Questions

None.
