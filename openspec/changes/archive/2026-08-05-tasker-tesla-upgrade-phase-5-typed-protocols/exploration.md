# Exploration Handoff: Phase 5 — Typed Protocols

## Scope Source

Convert Sandbox queue entries, overrides/caches, and order caches to JSON; introduce request IDs and stale-response rejection; remove `block_step17`–`19` compatibility fields after typed cutover. Overrides are already schema-v2 JSON and Override Handler is sole writer; Phase 5 therefore targets the queue and caches, not an override rewrite.

## Verified Current State

### Sandbox queue

- `Sandbox_Engine.js` is the only writer of `block_queue`; it serializes 21 pipe-separated columns, joins rows with `~`, and sends EOF, `skip_idx_until`, `step_conflict`, and `notif_queue` separately.
- Row fields are: `rowType`, `title`, `coords`, `mode`, `displayTime`, `departTime`, `pitstopState`, `apiTimeType`, `apiTimeUnix`, `evId`, `evLoc`, `engineLateMins`, `currentLegStable`, `dropinStatusFlag`, `safeDesc`, `adHoc`, `routeDurSecs`, `routeDistMiles`, `departurePolicy`, `planningDay`, `originSource`.
- `enqueuePlannedRow` has nine call sites. Tasker Variable Split is outside the repository; it currently feeds Compiler `block_step1`–`21`. No production script reads `block_queue` directly.
- Compiler has 20 `block_step` reads. Six harness files assert the delimiter contract; `test_ac3_sandbox` requires at least 21 columns. INV-0.1’s “19th positional column” must be amended.

### Compatibility fields

- Compiler is the only production consumer of `block_step17`–`19`: INV-0.7 fallback at lines 188–205 and planning day/origin from steps 20–21 at 288–289.
- Sandbox mirrors steps 17–21 only when the queue head is present. If Tasker delivers fewer columns, rows after the head can inherit stale values: the typed queue removes this latent hazard.
- INV-0.7 calls this a migration contract, authorizing removal only when typed rows provide positive `routeDurationSecs`, `routeDistanceMiles`, and `departurePolicy`.

### Transient globals

- `TDS_Depart_Memory`: `evId~unix` CSV; Compiler writes and Override Handler PRUNE prunes.
- `TDS_Completed_Dropins`: CSV; Finaliser writes.
- `TDS_Arrival_Memory`: CSV; Finaliser writes.
- `TDS_Completed_Stops`: `evId_mins` CSV; Stop Logger writes and Sandbox reads.
- Phase 3 classified these as read-side shims pending trip-state migration. Migrating them now expands Compiler, Finaliser, Stop Logger, Sandbox, Override Handler PRUNE, and the single-writer harness; defer to Phase 6.

### Route and order caches

- `RouteCache.txt` is the master Welford cache: ten `~` fields per row, `|` joined, written by `Alpha.js` (116–193).
- `Temp_Route_Cache.txt` is a session cache: seven `~` fields, `|` joined, written by both Alpha and `API_Parser.js`. This violates single writer today.
- `TDS_Order_Cache.txt` is newline joined with four `|` fields, written by API Parser.
- Gatekeeper consumes all three; Sandbox reads route tiers via `getCachedTime`; Alpha rolls temp values into master. No manager exists despite RULE-8E and AGENTS.md naming Route Cache Manager as owner.

### API correlation

- `API_JSON_Build.js` emits no `generationId`, `clusterId`, or `requestId`.
- `API_Parser.js` trusts `temp_payload.json`, has no correlation comparison, and never emits `STALE_API_RESPONSE_DISCARDED`.
- Existing Publisher reorder validation concerns a different command. CLUSTER-12 requires requests to carry generation/cluster identity and stale-generation results to be discarded.

### Baseline and constraints

- Harness baseline is 24/24 green. `test_atomic_publication` drives Compiler locals rather than parsed queue rows.
- Production runs in Tasker JSlets: no `require`, imports, `module.exports`, dependencies, Node timers, or Promises. Cross-script communication uses Tasker locals/globals/staging.
- Maintain exact-key maps, last-underscore occurrence parsing, structured JSON log fields, no direct published-itinerary writes, and nonzero travel durations.

## Recommended Decisions

1. Use a direct JSON `block_queue` envelope rather than a parallel queue: `{schemaVersion, rows, eof, skipIdxUntil, stepConflict, notifications}`. Compiler `JSON.parse`s it; this removes split-column leakage and keeps controls atomic.
2. Rows use named `routeDurationSecs`, `routeDistanceMiles`, and `departurePolicy`. During a bounded shadow window Sandbox dual-emits legacy head steps. Cutover removes all `block_step17`–`19` producer/consumer paths in the same Phase 5 change.
3. Use exact `{generationId, clusterId, requestId}` correlation. Builder creates a request ID; Cache Manager owns `TDS_Route_Request_State.json`, recording latest request per cluster. Tasker callback stores correlation with raw response. Parser requires equality with `TDS_Active_Generation` and the exact current state record; mismatch logs `STALE_API_RESPONSE_DISCARDED` and makes no cache/reorder mutation.
4. Defer the four transient globals to Phase 6 as explicit, bounded compatibility shims.
5. Create Route Cache Manager in Phase 5. It owns `TDS_Route_Cache.json`, `TDS_Order_Cache.json`, `Temp_Route_Cache.json`, and request state. Cache documents use `schemaVersion`, `updatedAt`, and exact-key entries. Route entries contain origin/destination cells, mode, day class, time bucket (null for WALK), `meanDurationSecs`, `sampleCount`, `m2`, `distanceMiles`, `createdAt`, and `expiresAt`; order entries use cluster key/result/expiry.

## Delivery Forecast

This exceeds the 400-line review budget. Use cached `stacked-to-main` strategy: queue shadow parser (~330), cache manager/migration (~390), request correlation (~300), then compatibility removal and regression evidence (~280). Each is a releasable work unit with its own tests/docs/rollback.
