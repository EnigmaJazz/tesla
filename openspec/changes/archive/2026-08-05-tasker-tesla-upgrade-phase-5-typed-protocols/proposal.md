# Proposal: Phase 5 — Typed Protocols

## Intent

Replace delimiter protocols with JSON contracts, reject stale API data, and restore cache single-writer ownership.

## Current-State Gap

Sandbox’s 21-column queue can leak head-row `block_step17`–`19` values. API responses are uncorrelated. Caches are pipe/CSV text files—not JSON—and lack their mandated manager; `Temp_Route_Cache.txt` has two writers.

## Scope

### In Scope
- JSON queue/typed rows and `block_step17`–`19` removal after shadow cutover.
- Route Cache Manager, JSON route/order/temp caches, TTLs, and sole-writer enforcement.
- Request correlation, stale rejection, and focused harness migration.

### Out of Scope
- Reducer migration of four transient memory globals (Phase 6).
- Published-itinerary protocol changes, new dependencies, or SDD ledger edits.

## Capabilities

### New Capabilities
- `typed-planning-protocols`: JSON queue, cache ownership, correlated route responses.

### Modified Capabilities
- `itinerary`: replaces positional/delimiter protocols; adds stale API rejection.

## Approach

1. Make `block_queue` a JSON envelope: `{schemaVersion,rows,eof,skipIdxUntil,stepConflict,notifications}`. Compiler parses it; rows carry `routeDurationSecs`, `routeDistanceMiles`, and `departurePolicy`.
2. Shadow dual-emits legacy head steps. Cutover makes row fields authoritative and removes `block_step17`–`19` together while retaining typed nonzero-duration fallback.
3. Builder stamps `{generationId,clusterId,requestId}`. Manager-owned `TDS_Route_Request_State.json` records the latest request per cluster; callbacks retain it. Parser requires exact correlation with active generation/state; mismatch logs `STALE_API_RESPONSE_DISCARDED` with no cache/reorder update.
4. Defer the four bounded transient-global shims to Phase 6.
5. Create Route Cache Manager. It owns JSON route/order/temp/request-state files; route entries have exact bucket, Welford fields, distance, timestamps, TTL, and null WALK bucket.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `Sandbox_Engine.js`, `Compiler.js` | Modified | Queue schema and cutover |
| `Route_Cache_Manager.js`, `Alpha.js`, `API_Parser.js`, `Gatekeeper.js` | New/Modified | Cache ownership |
| `API_JSON_Build.js` | Modified | Correlation envelope |
| `harness/` | Modified | Protocol and stale-response coverage |

## Slice Plan / PR Forecast

Stacked-to-main work units (tests/docs included): (1) queue shadow parser, ~330 lines; (2) cache manager/migration, ~390; (3) API correlation/rejection, ~300; (4) cutover/regression evidence, ~280. Each is below 400 changed lines and depends on prior contracts.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Queue loses control data | High | Envelope/shadow tests |
| Cache migration changes routing | Med | Snapshots and fixtures |
| Callback falsely rejects | Med | Exact context/retry tests |

## Rollback Plan

Snapshot caches and retain legacy queue emission before cutover. Revert the current slice, restore snapshots, retain itinerary, and reject uncorrelated responses.

## Dependencies

- Callback wiring must retain request correlation with `temp_payload.json`.

## Success Criteria

- [ ] 24/24 baseline plus queue, cache-owner, and stale-response scenarios pass.
- [ ] No consumer reads `block_step17`–`19`; every cache has one writer.

## Proposal Question Round

Assumption: callback preserves correlation without external API changes.
