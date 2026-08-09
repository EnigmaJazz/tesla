# TDS Planning Task — Exact Tasker Wiring (code-verified)

This is the missing orchestration layer: the exact Tasker task actions that make
the planning scripts work on-device, in the order the code actually requires.
Every handoff variable and file below is taken from the current script sources
(Compiler.js, Sandbox_Engine.js, Gatekeeper.js, API_JSON_Build.js,
API_Parser.js, Route_Cache_Manager.js, Generation_Publisher.js). Items marked
**[device]** are Tasker-side wiring choices (HTTP action details, JSON parsing
helpers) that the scripts do not script themselves.

## 0. Why this differs from TASKER_SETUP.md §3.1

The setup doc lists the planning chain as Alpha → Compiler → Sandbox. That is
wrong against the code. The Compiler does NOT consume `%tds_temp_json`; it
consumes **`%block_queue`** — the typed queue envelope the **Sandbox** produces
(Compiler.js:229). The correct per-day order is:

```
Alpha → [dropin cluster task] → [publish events to master] → block loop:
    Sandbox (simulate one block) → API chain (per leg) → Compiler (compile
    one leg) → Generation_Publisher (publish) → router → reducer
```

The dropin cluster task runs between Alpha and the publish so the reorder is
applied to the master **before** the Sandbox simulates it.

The block loop exists because the Sandbox stops at block boundaries (travel-mode
change / end-of-day) and reports where to resume (`skipIdxUntil`) and when the
day is done (`eof`). The API chain runs per leg so the Compiler gets live or
cached route durations (tier 1: `api_duration_secs` local) before computing
leave/arrival times. Per-leg publication accumulates the full-day itinerary
because each Compiler run reads the committed itinerary, appends its leg, and
republishes (Compiler.js:430,680).

## 1. Preconditions (set by Tasker profiles before this task)

| Variable | Source | Required by |
|---|---|---|
| `%User_Loc` | location profile | Sandbox, Compiler, Gatekeeper, API builder |
| `%User_At_Base` | base enter/leave profile | Sandbox, Compiler |
| `%TDS_Previous_Loc` | previous location reading | Finaliser, Sandbox |
| `%TDS_Active_Generation` | Generation_Publisher (empty on first run) | all |
| `%Home_Coords` | device setup | Sandbox |
| `%Car_Connected` | car connectivity | Sandbox |
| `%Current_Status` | status profile | Sandbox |
| `%api_key` | device setup (Google Routes key) | HTTP action **[device]** |
| `%Arrival_Buffer_Mins`, `%Departure_Buffer_Mins`, `%Max_Walk_Meters`, `%Daily_Walk_Meters`, `%Live_Traffic_Threshold` | device setup | Sandbox, Compiler |

Bootstrap the data files per TASKER_SETUP.md §5 before the first run.

## 2. The planning task, action by action

### Step A — Ingest the calendar

1. **Read Calendar** (Tasker action) → set `%ce_title1..N`, `%ce_description1..N`,
   `%ce_start_time1..N` (epoch ms), `%ce_end_time1..N`, `%ce_location1..N`,
   `%ce_event_id1..N`, `%ce_calendar1..N`. Alpha.js loops `while (local('ce_title' + i))`.
2. **JSlet: Alpha.js** → stages `%tds_temp_json` (event candidates), `%raw_base_data`.

### Step B — Dropin cluster task (identify dropin order)

Groups of dropin events get their optimal visit order identified here, using
the existing cluster machinery (Gatekeeper CLUSTER fork, API_JSON_Build
`optimizeWaypointOrder` fork, API_Parser CLUSTER fork, order cache). The
result is an `ENQUEUE_REORDER` command; the next publish applies it to the
master before the Sandbox simulates.

For each group of consecutive dropin events (events flagged dropin via
`isDropin` / `#dropin` in title/desc) between two main anchors:

0. **JSlet: Cluster_Builder.js** — read-only adapter, no file I/O. Consumes
   `%tds_temp_json`, `%cluster_idx`, `%raw_base_data`, `%Home_Coords`; groups
   consecutive dropins (destination = the next non-dropin event, or the base
   `BASE` for the EOD tail); stages `%par1` = the cluster JSON for
   `%cluster_idx` (1-based), `%cluster_count`, `%cluster_eof` (`true` when the
   index is exhausted). Dropins with `"0,0"` coords are skipped and logged
   (`CLUSTER_SKIPPED`).

Loop: Variable Set `%cluster_idx = 1` → run Cluster_Builder.js → while
`%cluster_eof = false`: run the chain below with `%par1` = the staged cluster,
then `%cluster_idx += 1` and run Cluster_Builder.js again.

1. **JSlet: Gatekeeper.js** (CLUSTER fork) — with `%par1` = cluster JSON:
   - forced `dropinOrder` present → sorts locally, stages `%par1` =
     `ENQUEUE_REORDER` (source `Gatekeeper`), `%cluster_bypass = true`; no HTTP.
   - else order-cache lookup (`TDS_Order_Cache.json`: isClose origin + exact
     destination id + exact waypoint id set) → hit → `%cluster_bypass = true`,
     `ENQUEUE_REORDER` staged with the cached order; no HTTP.
   - miss → `%cache_hit = false`, `%cluster_bypass = false` → live call needed.
4. **If `%cluster_bypass = false`** — live cluster API chain:
   1. **JSlet: API_JSON_Build.js** (CLUSTER fork, `%par1` still the cluster) —
      stages `%api_request_body` with `optimizeWaypointOrder: true` and the
      waypoints as `intermediates`, `%api_cluster_json`, `%api_route_mode =
      CLUSTER`, `%api_correlation`; `%par1` = `REQUEST_STATE_REGISTER`.
   2. **JSlet: Route_Cache_Manager.js** — register.
   3. **HTTP POST** **[device]** — same endpoint/headers as Step E; body
      `%api_request_body`; response → `%http_response`.
   4. **Write File**: `Tasker/Tesla/Data/temp_payload.json` =
      `{"correlation":%api_correlation,"response":%http_response}`. **[device]**
   5. **JSlet: API_Parser.js** — CLUSTER fork: validates correlation, extracts
      `optimizedIntermediateWaypointIndex` → ordered ids → stages `%par1` =
      `ORDER_CACHE_UPSERT`, `%par2` = `{clusterKey: <uLoc>|<destination.id>|<wpIdStr>,
      orderedEventIds, generationId, source: 'API_Parser'}`.
   6. **JSlet: Route_Cache_Manager.js** — applies `ORDER_CACHE_UPSERT` (writes
      the order cache) **and re-stages `%par1` = `ENQUEUE_REORDER`** with the
      ordered ids (Route_Cache_Manager.js:478).
   7. **JSlet: TDS_State_Command.js** — appends `ENQUEUE_REORDER` to
      `TDS_Reorder_Commands.json` (`REORDER_COMMAND_ENQUEUED`).
   8. **Consume the request** **[device]**: Variable Set `%par1 =
      %tds_consume_par1`, `%par2 = %tds_consume_par2` (both staged by the
      parser as `REQUEST_STATE_CONSUME`), then **JSlet: Route_Cache_Manager.js**
      — the request state entry is removed so a replayed callback is stale.
      (Route_Cache_Manager handles ONE command per invocation; the consume
      rides dedicated locals and needs its own action.)
   **Else** (`%cluster_bypass = true`): the Gatekeeper already staged
   `ENQUEUE_REORDER` — run **JSlet: TDS_State_Command.js** to enqueue it.
   **End If**

> The order cache means repeat dropin patterns skip the HTTP call entirely:
> the Gatekeeper order-cache hit re-stages the learned order (`cluster_bypass`).
> A `#dropin` day with a known pattern costs zero API calls for ordering.
>
> Known limitation (judgment-day suspect A1): the cluster contract has no
> explicit origin — Gatekeeper and API_JSON_Build resolve it from the live
> `%User_Loc`. For a mid-day dropin group the true origin is the preceding
> anchor; live-location origin is accepted for now and tracked for a future
> contract extension (origin in the cluster + order-cache key).

### Step C — Publish events into the committed master (bootstrap)

The Generation_Publisher below drains `TDS_Reorder_Commands.json` and applies
the dropin order staged in Step B to the master it publishes
(`drainReorderQueue`, pre-build generation matching) — so the Sandbox in
Step D simulates the already-ordered day.

The Sandbox simulates from the **committed master** (`readActiveGeneration`).
Until the calendar events are published, the master is empty and nothing is
simulated.

3. **JSlet: Finaliser.js** — consumes `%tds_temp_json`, `%raw_base_data`,
   `%User_Loc`, `%User_At_Base`, `%TDS_Previous_Loc`, `%TDS_Active_Generation`.
   Stages `%par1` = publish candidate `{events, master, itinerary}`, plus
   `%tds_obs_batch_par1/2` and `%tds_release_par1/2` when applicable.
4. **JSlet: Generation_Publisher.js** — consumes `%par1`; writes the
   per-generation files + manifest; sets `%TDS_Active_Generation`; stages
   `%par1` = `REDUCER_BATCH` (or `RECONCILE_GENERATION`).
5. **JSlet: TDS_State_Command.js** → **JSlet: Trip_State_Reducer.js** — deliver
   the post-publish batch (reconcile + observations).

> Note: the Finaliser's publish candidate carries the ACTIVE generation's
> itinerary (manifest-discovered via `readActiveGeneration("itinerary")`,
> legacy fallback only while migration is in flight — see §6.1).

### Step D — Block loop (Sandbox simulation)

6. **Variable Set**: `%idx = 1`, `%all_cal_title = ""`, `%all_cal_start = ""`,
   `%all_cal_end = ""`, `%virtual_loc = %User_Loc`, `%virtual_time = %now`,
   `%vcar_loc = %Car_Coords` (or `%User_Loc` when no car). **[device]**
7. **Loop** (While/For):
   1. **JSlet: Sandbox_Engine.js** — consumes `%idx`, `%virtual_loc`,
      `%vcar_loc`, `%virtual_time`, the globals in §1, committed master,
      `TDS_Route_Cache.json` / `Temp_Route_Cache.json` (read-only via
      `getCachedTime`), overrides, base geocodes. Stages:
      `%block_queue` = typed envelope; `%par1` = `REDUCER_BATCH`, `%par2` =
      batch JSON (observations).
   2. **JSlet: TDS_State_Command.js** → **JSlet: Trip_State_Reducer.js** —
      deliver the Sandbox's reducer batch.
   3. **Extract envelope controls** — micro-JSlet **[device]**:
      ```js
      var env = JSON.parse(local('block_queue'));
      setLocal('tds_eof', env.eof ? 'true' : 'false');
      setLocal('tds_skip', String(env.skipIdxUntil));
      setLocal('tds_row_count', String(env.rows.length));
      setLocal('tds_row_json', JSON.stringify(env.rows));
      ```
   4. If `%tds_eof = true` and no rows remain → exit loop (go to Step F).

### Step E — Per-leg loop (API chain + Compile + Publish)

For `%r = 1` to `%tds_row_count` **[device]**: extract row `%r` from
`%tds_row_json` (micro-JSlet or Tasker JSON plugin) into:
`%row_coords`, `%row_mode`, `%row_api_time_unix`, `%row_ev_id`,
`%row_origin` (= previous row's coords, or `%User_Loc` for the first leg).

8. **Variable Set**: `%par11 = %row_origin`, `%par12 = %row_coords`,
   `%par13 = %row_mode`, `%par14 = %row_api_time_unix`.
9. **JSlet: Gatekeeper.js** — reads the caches read-only; decides:
   - future leg (> `%Live_Traffic_Threshold`, default 2h) or WALK + cache match
     (±60 min tod bucket, same day class, 200 m GPS drift) → `%cache_hit = true`,
     `%api_return_json` = `{durationSecs, distanceMeters, distanceMiles,
     transitSteps}`.
   - otherwise → `%cache_hit = false` (live call required; legs inside the 2h
     live-traffic window always miss).
10. **If `%cache_hit = false`** — live API chain:
    1. **JSlet: API_JSON_Build.js** — stages `%api_request_body` (Google Routes
       payload), `%api_correlation` `{generationId, clusterId, requestId}`,
       `%api_route_mode`; `%par1` = `REQUEST_STATE_REGISTER`, `%par2` = payload.
    2. **JSlet: Route_Cache_Manager.js** — applies `REQUEST_STATE_REGISTER`
       (records the latest request for exact correlation).
    3. **HTTP Request** **[device]**: POST
       `https://routes.googleapis.com/directions/v2:computeRoutes`; headers
       `Content-Type: application/json`, `X-Goog-Api-Key: %api_key`,
       `X-Goog-FieldMask: routes.duration,routes.distanceMeters,routes.legs`;
       body `%api_request_body`; response → `%http_response`.
    4. **Write File**: `Tasker/Tesla/Data/temp_payload.json`, content
       `{"correlation":%api_correlation,"response":%http_response}`. **[device]**
     5. **JSlet: API_Parser.js** — validates correlation exactly (stale →
        `STALE_API_RESPONSE_DISCARDED`, zero mutation); extracts
        duration/distance/transit steps; stages `%api_return_json`;
        `%par1` = `SESSION_CACHE_UPSERT` (or `ORDER_CACHE_UPSERT` for clusters),
        `%par2` = payload; stages `%tds_consume_par1/2` = `REQUEST_STATE_CONSUME`.
     6. **JSlet: Route_Cache_Manager.js** — applies the upsert (session sample;
        the master Welford rollup runs via `ROLLUP_DUE_TEMP`, step 15b).
     7. **Consume the request** **[device]**: Variable Set `%par1 =
        %tds_consume_par1`, `%par2 = %tds_consume_par2`, then **JSlet:
        Route_Cache_Manager.js** — removes the request-state entry so a
        replayed callback is stale. (One RCM command per invocation; the
        consume rides the dedicated locals and needs its own action.)
     **Else** (cache hit): skip the HTTP chain.
     **End If**
11. **Parse `%api_return_json`** — micro-JSlet **[device]**:
    ```js
    var j = JSON.parse(local('api_return_json'));
    setLocal('api_duration_secs', String(j.durationSecs));
    setLocal('api_distance_miles', String(j.distanceMiles));
    setLocal('api_transit_steps', String(j.transitSteps || ''));
    ```
12. **Stage the single-row envelope** — micro-JSlet **[device]**:
    ```js
    var row = /* row %r from %tds_row_json */;
    setLocal('block_queue', JSON.stringify({
      schemaVersion: 1, rows: [row], eof: true,
      skipIdxUntil: 0, stepConflict: null, notifications: []
    }));
    ```
    (One row per Compiler run so tier-1 API metrics apply to the right leg —
    `api_duration_secs` is a single local, Compiler.js:288.)
13. **JSlet: Compiler.js** — consumes `%block_queue`, `%api_duration_secs`,
    `%api_distance_miles`, `%api_transit_steps`, `%virtual_time`, committed
    master/itinerary. Stages:
    - `%par1` = publish candidate (events + master + itinerary **with this leg
      appended** — reads the committed itinerary at Compiler.js:430);
    - `%cal_title_out` / `%cal_start_out` / `%cal_end_out` (this leg's
      emoji+destination title, leave ms, arrival ms);
    - `%depart_changed`, `%depart_diff_mins`, `%api_conflict`, `%live_late_mins`.

    **HOLD branch**: an attached-dropin row stages `%cal_title_out = HOLD` and
    `%par1 = HOLD`-path locals with NO candidate — the leg is appended to
    `Pending_Compiler.json` and compiles when the chain head arrives. On HOLD,
    SKIP steps 14–15 (no publisher, no router); continue to step 16.
14. **JSlet: Generation_Publisher.js** — ONLY when `%par1` is the candidate
    JSON (starts with `{`): publishes `%par1` (mints genId, writes
    per-generation files + manifest, sets `%TDS_Active_Generation`, stages the
    reconcile batch). This per-chain publication is what accumulates the
    full-day itinerary.
15. **JSlet: TDS_State_Command.js** → **JSlet: Trip_State_Reducer.js** —
    deliver the post-publish batch.
15b. **Rollup (recommended per block)**: `%par1 = ROLLUP_DUE_TEMP`,
    `%par2 = {nowSec, prune: true}` → **JSlet: Route_Cache_Manager.js** —
    session samples whose target time has passed roll into the master Welford
    cache (`now >= targetUnix` gate; future samples stay in the session cache).
    Without this, future legs only ever read the session cache.
16. **Accumulate calendar output** **[device]**:
    `%all_cal_title = %all_cal_title | %cal_title_out` (same for start/end).
17. **Loop** `%r` → next row.

After the row loop, resume the block loop:
18. **Variable Set**: `%idx = %tds_skip`; if `%tds_eof = false` → repeat Step D;
    else exit.

### Step F — Calendar feedback (user output)

19. For each accumulated entry (split `%all_cal_*` by `|`), **Calendar Insert**
    **[device]**: title = `%all_cal_title` entry, start = `%all_cal_start` entry
    (ms), end = `%all_cal_end` entry (ms). Skip entries equal to `SKIP_CALENDAR`
    / `IGNORE` / `HOLD`.

### Step G — Notifications (optional)

20. `%block_queue`'s `stepConflict`/`notifications` (and `%api_conflict`,
    `%live_late_mins`) drive lateness menus — flash or show a Scene per
    TASKER_SETUP.md §3.1 note. Tasker never Variable-Splits `%block_queue`.

## 3. Execution summary (dropin cluster + one block, one leg)

```
Dropin cluster (per dropin group, before publish):
  micro-JSlet   → %cluster_json, %par1 = cluster JSON
  Gatekeeper    → forced/cached order? %cluster_bypass=true + ENQUEUE_REORDER
                  | miss → live cluster chain
  API_JSON_Build→ %api_request_body (optimizeWaypointOrder) + correlation
  Route_Cache_Manager → REQUEST_STATE_REGISTER
  HTTP POST     → %http_response
  temp_payload.json = {correlation, response}
  API_Parser    → ORDER_CACHE_UPSERT (staged)
  Route_Cache_Manager → order cache write + re-stage ENQUEUE_REORDER
  TDS_State_Command → append ENQUEUE_REORDER

Per block, per leg:
  Sandbox_Engine  → %block_queue (block rows) + %par1=REDUCER_BATCH
  router+reducer  → deliver observations
  Gatekeeper      → cache_hit? api_return_json (cache) | live chain
  API_JSON_Build  → %api_request_body + %api_correlation + REQUEST_STATE_REGISTER
  Route_Cache_Manager → register
  HTTP POST       → %http_response  (only on miss)
  temp_payload.json = {correlation, response}
  API_Parser      → %api_return_json + SESSION_CACHE_UPSERT (staged)
  Route_Cache_Manager → upsert (Welford rollup) + consume
  micro-JSlet     → %api_duration_secs / %api_distance_miles / %api_transit_steps
  Compiler        → %par1 candidate + %cal_title_out/%cal_start_out/%cal_end_out
  Generation_Publisher → new generation (itinerary grows)
  router+reducer  → reconcile
```

## 4. What to watch in the flash log (verification)

- `TYPED_QUEUE_ACCEPTED` / `TYPED_QUEUE_CUTOVER_COMPLETED` — Compiler consumed the queue.
- `DEPARTURE_POLICY_FALLBACK_USED` — tier fallback: API → SANDBOX → LOCAL_ESTIMATE.
- `ZERO_DURATION_LEG_REJECTED` — a leg had no duration anywhere; the API chain for that leg failed or the cache is empty.
- `STALE_API_RESPONSE_DISCARDED` — correlation mismatch; temp_payload.json or request state is wrong.
- `CACHE_ENTRY_REJECTED` — cache read/write contract violation.
- `STALE_TRIP_REJECTED` (Dispatcher) — old itinerary, expected on first runs.
- `REDUCER_BATCH_DELIVERED` — reducer applied each batch.
- `REORDER_COMMAND_ENQUEUED` / `REORDER_QUEUE_DRAINED` — the dropin order was
  staged and applied at publish.
- `STALE_REORDER_COMMAND_REJECTED` — reorder staged against a generation that
  is no longer pre-build (stale), e.g. the cluster task ran after a publish;

## 5. Known code gaps (fixes needed, not wiring)

1. ~~Finaliser carries the legacy itinerary~~ — **fixed**: Finaliser.js now
   resolves the active-generation itinerary via `readActiveGeneration("itinerary")`
   (manifest-discovered, legacy fallback only while migration is in flight),
   with the regression covered by `harness/test_serial_finaliser_batch.js`
   (candidate-carries-active-generation-itinerary-not-legacy).
2. **Compiler's `pendingChain` file clear** — Compiler.js:428 writes
   `Pending_Compiler.json` = `[]` after pushing the head leg; attached-dropin
   chains accumulate across runs via that file, so per-leg runs preserve it.
   Verified consistent with per-leg wiring; do not clear it from Tasker.
3. **Sandbox `%virtual_*` locals** — the simulation state (`%virtual_loc`,
   `%virtual_time`, `%vcar_loc`) has no production writer; initialize them from
   live state each pass (§2 Step D.6) as shown.
4. ~~No production cluster builder~~ — **resolved**: `Cluster_Builder.js` (new)
   assembles the cluster JSON from `%tds_temp_json` (read-only adapter, staged
   `%par1` per `%cluster_idx`, `%cluster_eof` loop control), with harness
   coverage in `harness/test_cluster_builder.js`.

## 6. Manual action tasks

Unchanged from TASKER_SETUP.md §3.3: each adapter (Depart_Now, Return_to_Base,
Unlock, Stop_Logger, Appender, Override_Injector) is its own entry task:
JSlet(adapter) → TDS_State_Command → owner. Override_Injector also stages
`%do_engine_rerun = true` — trigger the planning task again from the override
task when that flag is set.
