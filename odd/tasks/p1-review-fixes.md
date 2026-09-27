# ODD tasks — p1-review-fixes

- **Project:** tesla (/home/james/ai-workspace/tasker/tesla)
- **Feature:** p1-review-fixes
- **Created:** 2026-09-23
- **Mirror key:** ODD_TASKS key=odd/tesla/p1-review-fixes/tasks
- **Baseline:** a2d51a189c85392c45913120cb780aac994521ad
- **Source:** ce:review of origin/master..master (18 commits, 3112 lines) + follow-up commit a2d51a1
- **Delivery strategy:** single-pr (forecast ~250 authored lines, under the ~400 advisory)
- **Route:** route: delegated | specialist: general (sandbox writer) | trigger: substantial work, >=2 meaningful implementation steps

## Objective

Resolve the seven P1 findings from the advisory review so that a transient read
failure can never publish a truncated or empty day, never re-route a completed
trip, and never let a rejected API metric leak into a leg.

## Problem

1. Geocode_Updater.js:26 hardcodes `Tasker/Tesla/Data/Geocode_Cache.json` while
   Alpha.js:91 and Finaliser.js:149 read `DATA_ROOT + "Geocode_Cache.json"`.
   Under a non-default TESLA_CONFIG dataRoot the writer commits where nobody
   reads, so geocodes never resolve and events drop from routing while the
   updater still logs success.
2. readActiveGeneration returns `[]` on total read failure in Compiler.js (~201),
   Finaliser.js (~95) and Sandbox_Engine.js (~254). Only Dispatcher was changed
   to return `null`. A transient unreadable generation therefore publishes a
   one-leg itinerary (Compiler) or an empty itinerary (Finaliser).
3. Dispatcher's completed-trip/dropin exclusion is built only from readable trip
   state; on unreadable state it degrades to "no exclusion", so a completed trip
   still in the committed itinerary can be re-selected and re-routed.
4. API_Parser's two rejection paths stage `api_return_json = '{}'` but never
   clear `api_duration_secs` / `api_distance_miles` / `api_transit_steps`; if the
   Tasker JSON step only overwrites present fields, the previous leg's positive
   metrics survive and Compiler consumes them as API-tier.
5. Dispatcher selects IDLE_SYNC_MINS (60) when the master read failed, treating
   "unread" the same as "no actionable trip"; a real departure 10-50 minutes out
   can fall outside the nav window before the next run.
6. Cluster_Builder groups consecutive dropins with no local planning-day check,
   so two dropins straddling local midnight merge into one cluster. Violates the
   AGENTS.md hard rule and canonical spec CLUSTER-12.
7. The API metrics-rejection path (nonpositive/oversized duration or distance)
   has no direct harness coverage; the only end-to-end simulation supplies valid
   positive metrics, so the path can regress silently.

## Scope (authorized)

In scope: Geocode_Updater.js, Compiler.js, Finaliser.js, Sandbox_Engine.js,
Dispatcher.js, Cluster_Builder.js, API_Parser.js, harness/*.

Out of scope: the 19 P2 findings, the 3 pre-existing findings, any refactor not
strictly required by a P1, and any change to TASKER_SETUP.md or AGENTS.md
beyond what a P1 strictly requires.

## Constraints

- Tasker runtime: standalone JS scripts, no Node modules, no promises/timers;
  cross-script communication is via Tasker locals and JSON files only.
- Single-writer contract per AGENTS.md — one writer per data file.
- Hard rules: no zero-duration published travel leg; no silent state inference;
  no day-boundary-crossing chains; no substring matching for event/series IDs.
- Structured logs: lowercase severity (`info`/`warn`/`error`), epoch-seconds
  timestamp, fields timestamp/generationId/component/severity/code/tripId/details.
- No new dependencies. No unrelated refactors. Keep legacy `var` where it is.
- `node` is NOT available in the sandbox worker; the harness is run with `bun`.
  Every check must record which runtime was used.

## Tasks

| ID | Task | Files | Route / specialist | Status |
|---|---|---|---|---|
| P1-1 | Resolve the geocode cache path from DATA_ROOT like every sibling script | Geocode_Updater.js, harness/test_geocode_updater.js | route: delegated / general | done |
| P1-2 | Distinguish UNKNOWN from empty generation reads and refuse to publish on UNKNOWN | Compiler.js, Finaliser.js, Sandbox_Engine.js | route: delegated / general | done |
| P1-3 | Do not re-route a completed trip when trip state is unreadable | Dispatcher.js | route: delegated / general | done |
| P1-4 | Clear derived metric locals on both API rejection paths | API_Parser.js | route: delegated / general | done |
| P1-5 | Short retry interval plus a distinct code on a failed master read | Dispatcher.js | route: delegated / general | done |
| P1-6 | Terminate dropin clusters at the local planning day | Cluster_Builder.js, harness/test_cluster_builder.js | route: delegated / general | done |
| P1-7 | Direct harness coverage for the API metrics-rejection path | harness/* | route: delegated / general | done |

## Follow-up tasks — scope change (2026-09-23)

Root cause: the repo's file reads are two-state — `readJson(path)` returns the
parsed value or `null`, collapsing file-missing, empty, `%`-unexpanded, read
failure and parse failure into one `null`, so three P1 fixes each guessed the
distinction differently. This follow-up introduces a THREE-state read
(`ok` / `missing` / `unreadable`) and applies it where the distinction changes
behaviour. (`readJson` keeps its signature and behaviour.)

| ID | Task | Files | Route / specialist | Status |
|---|---|---|---|---|
| R1 | Add a tri-state `readJsonState` (ok / missing / unreadable) per reader | Compiler.js, Finaliser.js, Sandbox_Engine.js, Dispatcher.js | route: delegated / general | done |
| R2 | Resume UNKNOWN in the three generation resolvers; delete bare `readFile` calls; audit every `null` caller | Compiler.js, Finaliser.js, Sandbox_Engine.js, harness/test_generation_read_unknown.js | route: delegated / general | done |
| R3 | Dispatcher: distinguish an ABSENT trip state from an UNREADABLE trip state | Dispatcher.js, harness/test_dispatcher_state_unknown.js | route: delegated / general | done |
| R4 | Dispatcher: distinguish an ABSENT/BUILDING master from an UNREADABLE master | Dispatcher.js, harness/test_atomic_publication.js, harness/test_dispatcher_state_unknown.js | route: delegated / general | done |

**R3 rationale:** the §5 bootstrap mandates `TDS_Trip_State.json`, and a
migrated legacy system can have a committed master but no state file yet.
Absence is a valid "nothing recorded yet" (known-empty, the overdue class
proceeds); a read/parse failure is not (UNKNOWN, the overdue class is withheld).

## Acceptance criteria

- P1-1: with a custom TESLA_CONFIG dataRoot, Geocode_Updater writes to
  `<dataRoot>/Geocode_Cache.json`; with no config it falls back to
  `Tasker/Tesla/Data/Geocode_Cache.json`. Harness asserts the custom-dataRoot path.
- P1-2: with every itinerary source unreadable, Compiler stages NO publish
  candidate and logs `ITINERARY_READ_UNKNOWN`; Finaliser publishes nothing;
  Sandbox does not treat an unreadable master as an empty day.
- P1-3: with trip state unreadable, a trip already recorded completed cannot be
  selected as the navigation target.
- P1-4: after API_METRICS_INVALID or API_PARSER_FAULT the three metric locals are
  empty, so Compiler falls to its documented metric tiers instead of a stale value.
- P1-5: a failed master read selects the short retry interval and logs
  `GENERATION_READ_UNKNOWN_SYNC`.
- P1-6: two dropins straddling local midnight produce two clusters, not one, and
  the split is asserted by the harness.
- P1-7: harness cases cover zero, negative, missing, nonnumeric and oversized
  duration/distance with a valid correlation and assert API_METRICS_INVALID,
  empty api_return_json and no cache command staged.

## Checks

- Run every `harness/test_*.js` under `bun` (record that `node` was unavailable).
- Confirm no `return []` remains on a total-failure path in the three resolvers.
- Confirm every new log uses lowercase severity and epoch-seconds timestamp.
- Confirm the single-writer table in AGENTS.md is still honoured.

## Progress / evidence

- **Runtime:** `bun` for every check (`node` is not installed in the worker).
  Commands were run as `bun harness/<test>.js` (absolute `/work/...` in the
  worker, one command per `sandbox_bash` call).

- **P1-1 DONE.** `Geocode_Updater.js`: before line 26 was
  `const GEOCODE_CACHE_PATH = "Tasker/Tesla/Data/Geocode_Cache.json";`; after,
  the function opens with the verbatim Alpha.js TESLA_CONFIG preamble
  (lines 1-8: `TESLA_CFG`/`DATA_ROOT` with the `"Tasker/Tesla/Data/"` fallback and
  trailing-slash normalization) followed by
  `const GEOCODE_CACHE_PATH = DATA_ROOT + "Geocode_Cache.json";`. Nothing else
  changed. `harness/test_geocode_updater.js` gained T11 (custom
  `dataRoot: "Custom/Data"` -> write at `Custom/Data/Geocode_Cache.json`, default
  path untouched). Result: `PASS: geocode-updater — ..., custom dataRoot`.

- **P1-2 DONE.** In `Compiler.js`, `Finaliser.js` and `Sandbox_Engine.js` the
  resolver terminal `return [];` was replaced with a manifest-aware decision:
  when `TDS_Run_Manifest.json` exists (readable, corrupt or unexpanded) but no
  candidate yields usable data -> `return null;` (UNKNOWN); only the true
  first-publish case (no manifest, no readable fallback) -> `return [];`. This
  keeps the documented active -> previous -> legacy chain intact and preserves
  the bootstrap publish (proved by a first-publish control).
  - `Compiler.js`: added an `ITINERARY_READ_UNKNOWN` guard (severity `error`,
    `tripId: evId`) immediately after `readActiveGeneration("master")` and again
    before `itinerary.length`/`publishCandidate`; both `return` without staging a
    publish candidate.
  - `Finaliser.js`: guarded the `publishCandidate({...})` call so an UNKNOWN
    `currentItin` flashes `ITINERARY_READ_UNKNOWN` instead of publishing; the
    base-file write and observation/release staging that follow still run.
  - `Sandbox_Engine.js`: `masterReadable` guard flashes `ITINERARY_READ_UNKNOWN`
    and, when unreadable, the EOF envelope carries
    `stepConflict: "ITINERARY_READ_UNKNOWN"` with `rows: []` (schema unchanged);
    `readActiveItinerarySafe` degrades an UNKNOWN itinerary read to `[]` so the
    two `oldItin` consumers cannot crash.
  - Harness: new `harness/test_generation_read_unknown.js` (C1 corrupt manifest ->
    no publish; C2 committed manifest with missing itinerary -> no publish; C3
    first-publish control still publishes; F1 Finaliser; S1 Sandbox envelope) —
    `PASS`.

- **P1-3 DONE.** `Dispatcher.js`: added `tripStateReadable` (true only after a
  successful `TDS_Trip_State.json` parse; absent / empty / `%`-prefixed / corrupt
  stay false). `bestOverdue` is only promoted to `targetDrive` when readable;
  otherwise the overdue class is withheld and `OVERDUE_SUPPRESSED_STATE_UNKNOWN`
  (severity `warn`, tripId/leg detail) is flashed. Future/PLANNED selection and
  the readable-state completion exclusion are unchanged. Trade-off recorded:
  re-navigating a completed stop is worse than skipping an overdue one, so an
  UNKNOWN state now yields no navigation target from the overdue class.
  Harness: new `harness/test_dispatcher_state_unknown.js` D1 (suppressed) / D2
  (readable-state control still selects) — `PASS`.
  `harness/test_dispatcher_overdue_wins.js` now seeds a readable `{}` trip state so
  it continues to assert the readable-state overdue path.

- **P1-4 DONE.** `API_Parser.js`: both rejection paths now also
  `setLocal('api_duration_secs', '')`, `setLocal('api_distance_miles', '')`,
  `setLocal('api_transit_steps', '')` (API_METRICS_INVALID and API_PARSER_FAULT).
  The existing `api_return_json = '{}'`, par1/par2 clearing and cache-command
  suppression are untouched. Harness: new `harness/test_api_parser.js` proves the
  cleared locals for every rejection case and that the valid control still stages
  `SESSION_CACHE_UPSERT` — `PASS`.

- **P1-5 DONE.** `Dispatcher.js`: the `targetDrive === undefined` branch now
  splits on `masterReadable`. When false it selects the existing short
  `SOON_SYNC_MINS` (10) and flashes `GENERATION_READ_UNKNOWN_SYNC`
  (severity `warn`); otherwise the unchanged `IDLE_SYNC_MINS` (60) /
  `IDLE_SYNC_ENGAGED` path runs. No magic numbers (reused existing constant).
  Harness D3/D4 in `test_dispatcher_state_unknown.js` — `PASS`.
  `harness/test_atomic_publication.js` was updated where it asserted the old
  idle-on-unreadable-master contract (building/unreadable master now short-retries).

- **P1-6 DONE.** `Cluster_Builder.js`: added the inlined DST-safe
  `localPlanningDay` helper (same form as Sandbox_Engine/Dispatcher). The grouping
  loop now terminates the current group when a dropin's local day differs from the
  group's, and when the next non-dropin destination anchor falls on a different
  local day (the group closes as a BASE tail rather than combining a prior-day
  dropin with a next-day anchor). Flashes `CLUSTER_SPLIT_DAY_BOUNDARY` with the
  group index and both days. The cluster JSON shape is unchanged. Harness SCN-13
  (cross-midnight -> 2 clusters) and SCN-14 (same-day control -> 1 cluster) in
  `harness/test_cluster_builder.js` — `PASS`.

- **P1-7 DONE.** New `harness/test_api_parser.js`. Nine rejection cases, each
  with a VALID correlation in `TDS_Route_Request_State.json` + temp_payload:
  duration zero / negative / missing / nonnumeric and distance zero / negative /
  missing / nonnumeric / oversized; each asserts `API_METRICS_INVALID`, empty
  `api_return_json` (`'{}'`), no cache command (`par1`/`par2` empty) and all three
  derived metric locals cleared. Plus an API_PARSER_FAULT (second path) case and a
  valid positive-metric control asserting `SESSION_CACHE_UPSERT` is staged.
  Finding note: the real API_Parser has no upper bound on duration (only
  `MAX_DISTANCE_METERS` on distance), so "oversized duration" is not a rejection
  case in the code; oversized distance is covered instead.

- **Full harness (bun): all 38 `harness/test_*.js` PASS** (test_ac3_sandbox,
  test_ac5, test_api_parser, test_atomic_publication, test_cache_readers,
  test_cluster_builder, test_compiler_ac1, test_compiler_ac8, test_departure_day,
  test_dispatcher_ac9, test_dispatcher_ac10, test_dispatcher_multi_stop,
  test_dispatcher_overdue_wins, test_dispatcher_relevance,
  test_dispatcher_state_unknown, test_dst_utc, test_fu2_departure_edge,
  test_geocode_updater, test_generation_read_unknown, test_id_parsing,
  test_manual_session, test_planning_day_simulation, test_reader_convergence,
  test_reconcile, test_reducer_commands, test_release_commands,
  test_reorder_queue, test_request_correlation, test_route_cache_manager,
  test_sandbox_ac6, test_sandbox_ovr10, test_serial_batch,
  test_serial_finaliser_batch, test_single_writer, test_state_command,
  test_stop_lifecycle, test_trip_lifecycle, test_typed_queue).

- **Check — resolvers:** no resolver returns `[]` on a total-failure path. The
  remaining `return []` is the explicit "no manifest at all / first publish" case
  and is guarded by the `if (manifestRaw) return null;` line above it.
- **Check — logs:** every new flash uses lowercase severity
  (`info`/`warn`/`error`) and `Math.floor(Date.now()/1000)` epoch-seconds
  timestamps with the required field set.
- **Check — single writer:** no new writer was introduced; the touched scripts
  keep their existing ownership (Geocode_Updater remains the sole writer of
  Geocode_Cache.json; no new direct writes to the published master/itinerary).

- **R1/R2 DONE (2026-09-23).** Added a tri-state `readJsonState(path)` next to
  the existing `readJson` in `Compiler.js`, `Finaliser.js`, `Sandbox_Engine.js`
  and `Dispatcher.js` (each keeps its component name and flash idiom).
  Returns `{state:"ok",value}` / `{state:"missing"}` / `{state:"unreadable"}`:
  `readFile` throws -> `unreadable` + `FILE_READ_FAILED` (severity `error`);
  falsy/empty -> `missing`; `%`-prefixed -> `unreadable`; `JSON.parse` throws ->
  `unreadable` + `FILE_PARSE_FAILED`. `readJson` is unchanged. Before: the
  resolver tail read bare `readFile` (Compiler.js:204/206) and returned `[]`
  whenever the raw was falsy; after: every source is read through
  `readJsonState` and the resolver returns `null` (UNKNOWN) when the manifest
  state is `ok`/`unreadable` or the legacy state is `unreadable`, and `[]` only
  when BOTH are `missing` (genuine first publish). No `readFile` remains
  outside a try/catch in the resolvers; `Finaliser.js` keeps
  `ACTIVE_GENERATION_READ_FAILED` observability.
  - **R2 caller audit (call site -> null handling):** Compiler master ->
    `return` after `ITINERARY_READ_UNKNOWN{source:master}`; Compiler itinerary ->
    `return` after `ITINERARY_READ_UNKNOWN{source:itinerary}`; Finaliser
    itinerary -> `if (null) flash ITINERARY_READ_UNKNOWN else publishCandidate`;
    Sandbox master -> `masterReadable` guard sets `master = []` and
    `stepConflict`; Sandbox itinerary -> `readActiveItinerarySafe` degrades to
    `[]`. No `null` reaches `.length`, `.push`, `for..in` or iteration.
  - Harness: `harness/test_generation_read_unknown.js` gained C4 (manifest read
    throws -> null, no publish, `FILE_READ_FAILED`), C5 (`%`-unexpanded -> null,
    no publish), C6 (first-publish control -> `[]`, publishes), C7 (manifest
    missing + legacy corrupt -> null, no publish), C8 (Finaliser null caller
    does not throw, does not publish). Result: `PASS:
    generation-read-unknown — Compiler/Finaliser withhold publish on UNKNOWN;
    first publish survives; Sandbox flags the degraded envelope`.

- **R3 DONE (2026-09-23).** `Dispatcher.js` reads `TDS_Trip_State.json` through
  `readJsonState`. `"ok"` -> completion maps built as before; `"unreadable"` ->
  `tripStateReadable = false` (overdue withheld,
  `OVERDUE_SUPPRESSED_STATE_UNKNOWN` warn; `TRIP_STATE_READ_FAILED` retained);
  `"missing"` -> known-empty, overdue proceeds, `TRIP_STATE_ABSENT` (severity
  `warn`, details incl. path) flashed. Rationale recorded in the follow-up
  section. Harness: D1 re-pointed at an UNREADABLE (corrupt) state; D5 (absent
  state -> overdue selected + `TRIP_STATE_ABSENT`); D6 (`%`-unexpanded -> still
  suppressed, not reported absent). Result: `PASS: dispatcher-state-unknown —
  overdue suppressed on UNKNOWN state; failed master read retries short`.

- **R4 DONE (2026-09-23).** `Dispatcher.js` `readActiveGeneration` now records
  `lastGenerationReadFailed` (true only when a manifest/active/previous/legacy
  read was `unreadable`). Before: `!masterReadable` selected `SOON_SYNC_MINS`
  (10) for an absent master too; after: the `targetDrive === undefined` branch
  splits on `masterReadFailed` — absent/building -> `IDLE_SYNC_MINS` (60) +
  `IDLE_SYNC_ENGAGED`, read/parse failure -> `SOON_SYNC_MINS` (10) +
  `GENERATION_READ_UNKNOWN_SYNC`. `masterReadable` (schedule-cancel guard) is
  unchanged. Harness `harness/test_atomic_publication.js`: restored the idle
  contract for the building-manifest and absent-master cases (3 assertions) and
  added `testUnreadableMasterShortRetry` (failure -> short retry + generation
  propagated); `harness/test_dispatcher_state_unknown.js` D3 re-pointed at an
  unreadable master. Result: both suites `PASS`.

- **Full harness (bun): all 38 `harness/test_*.js` PASS** after the follow-up
  (the 35 unchanged suites plus the three extended ones).

## Code-style follow-up — GGA pre-commit violations (2026-09-23)

Cause: the repo pre-commit hook (`.gga`, RULES_FILE=AGENTS.md) blocked the
commit on four "Code style — No magic numbers" violations; each unnamed literal
was replaced by a same-file named constant (values, types and comparisons
unchanged).

| ID | Task | Files | Route / specialist | Status |
|---|---|---|---|---|
| S1 | Name the getBase() shortest-duration sentinel | Sandbox_Engine.js | route: delegated / general | done |
| S2 | Name the always-active base-geocode string sentinels | Sandbox_Engine.js | route: delegated / general | done |
| S3 | Name the Arrival/Departure buffer default (5 min) | Compiler.js | route: delegated / general | done |
| S4 | Name the block-loop buffer default and live-traffic threshold | Sandbox_Engine.js | route: delegated / general | done |

- **S1 DONE.** Sandbox_Engine.js getBase(): before `let shortestDuration = 99999999999;`; after `let shortestDuration = DURATION_MAX_SENTINEL;` (added `const DURATION_MAX_SENTINEL = 99999999999;`; exact value kept, not Infinity).
- **S2 DONE.** Sandbox_Engine.js latched-base loop: before `if (parts[0] === "0" && parts[1] === "5000000000") continue;`; after `if (parts[0] === ALWAYS_ACTIVE_BASE_START && parts[1] === ALWAYS_ACTIVE_BASE_END) continue;` (both constants are STRINGS; a numeric constant would break the === comparison; comment names the TDS_Base_Geocodes.txt start/end field convention).
- **S3 DONE.** Compiler.js compileTypedRow(): before `parseInt(global('Departure_Buffer_Mins'), 10) || 5` and `parseInt(global('Arrival_Buffer_Mins'), 10) || 5`; after both use `DEFAULT_BUFFER_MINS` (added `const DEFAULT_BUFFER_MINS = 5;`).
- **S4 DONE.** Sandbox_Engine.js block loop: before `parseInt(global('Live_Traffic_Threshold'), 10) || 7200` and the two `|| 5` buffer defaults; after `DEFAULT_LIVE_TRAFFIC_THRESHOLD_SECS` (its own distinct constant, not LOCK_FRESH_SECS, which only collides in value) and `DEFAULT_BUFFER_MINS`.
- **Verification:** full harness under bun (node unavailable) — all 38 harness/test_*.js PASS; behaviour byte-for-byte identical.

## Code-style follow-up 2 — GGA treadmill paydown (2026-09-23)

Cause: the repo pre-commit hook (`.gga`, RULES_FILE=AGENTS.md) reviews whole
files, so a clean pass requires naming every justifiable domain literal, not
only the four the previous pass cited. This pass names the remaining domain
constants in `Compiler.js` and `Sandbox_Engine.js`; values, types and
comparisons are byte-for-byte unchanged.

| ID | Task | Files | Route / specialist | Status |
|---|---|---|---|---|
| S5 | Name the typed-queue envelope schema version on the producer side | Sandbox_Engine.js | route: delegated / general | done |
| S6 | Name the sandbox raw-data guards and ad-hoc field floor | Sandbox_Engine.js | route: delegated / general | done |
| S7 | Name the TDS_Base_Geocodes.txt field indices | Sandbox_Engine.js | route: delegated / general | done |
| S8 | Name the millisecond factor, weekday horizon, zero-pad width and block-index default | Sandbox_Engine.js | route: delegated / general | done |
| S9 | Name the generation-id, daily-walk and Hold_Until fallbacks | Sandbox_Engine.js | route: delegated / general | done |
| S10 | Name the route-cache tod sentinel and the bare 86400 seconds-per-day | Sandbox_Engine.js | route: delegated / general | done |
| S11 | Name the minutes-to-seconds unit factor | Sandbox_Engine.js | route: delegated / general | done |
| S12 | Name the miles precision and minutes-to-seconds unit factor | Compiler.js | route: delegated / general | done |
| S13 | Name the dropin-duration and Hold_Until unset defaults | Compiler.js | route: delegated / general | done |

- **S5 DONE.** `Sandbox_Engine.js`: added `const TYPED_QUEUE_SCHEMA_VERSION = 1;` and used it at both envelope-build sites — the EOF empty-row envelope (before `schemaVersion: 1`) and the normal queue envelope (before `schemaVersion: 1`); the value stays `1` and Compiler.js's consumer constant is untouched, so the wire contract is now named on both sides. The unrelated route-cache read (`obj.schemaVersion !== 1`) is a different contract and is left literal (see below).
- **S6 DONE.** `Sandbox_Engine.js`: `MIN_RAW_DATA_LEN = 3` for the raw-string floor shared by the base file and AdHoc_Base (`baseData.length > 3`, `adHocRaw.length > 3`); `MIN_ADHOC_FIELDS = 3` for the distinct AdHoc_Base field-count guard (`aParts.length >= 3`).
- **S7 DONE.** `Sandbox_Engine.js`: `BASE_FIELD_COORDS = 2`, `BASE_FIELD_NAME = 4`, `BASE_FIELD_ID = 6` for the `~`-separated TDS_Base_Geocodes.txt fields (ranks confirmed against Finaliser.js, the sole writer). `parts[2]`/`parts[4]`/`parts[6]` now named; indices 0/1 (start/end) left bare as idiomatic base indices.
- **S8 DONE.** `Sandbox_Engine.js`: `MS_PER_SEC = 1000` (`SECONDS_PER_DAY * 1000`), `WEEKDAY_NAME_HORIZON_DAYS = 6` (`diffDays > 6`), `TWO_DIGIT_PAD_WIDTH = 2` (all four `.slice(-2)` sites), `DEFAULT_BLOCK_INDEX = 1` (`parseInt(local('idx'), 10) || 1`), `MINUTES_PER_HOUR = 60` (`d.getHours() * 60`).
- **S9 DONE.** `Sandbox_Engine.js`: `DEFAULT_GENERATION_ID = "gen:0:0000"` (a STRING constant — a numeric constant would break the `||`), `DEFAULT_DAILY_WALK_METERS = 0`, `HOLD_UNTIL_UNSET_SECS = 0`.
- **S10 DONE.** `Sandbox_Engine.js`: `TOD_UNSET_SENTINEL = -999` (three sites) and the existing `SECONDS_PER_DAY` reused for the bare `86400` cache recency bound; exact sentinel values kept, never `Infinity`/`MAX_SAFE_INTEGER`.
- **S11 DONE.** `Sandbox_Engine.js`: `SECONDS_PER_MIN = 60` applied to every minutes<->seconds conversion in `getRemainingStops` and the block loop (buffers/durations `* 60`, lateness deltas `/ 60`).
- **S12 DONE.** `Compiler.js`: `MILES_DECIMAL_PLACES = 3` (`.toFixed(3)`) and `SECONDS_PER_MIN = 60` (four `* 60`, three `/ 60`).
- **S13 DONE.** `Compiler.js`: `DEFAULT_DROPIN_DURATION_SECS = 0` (both dropin-duration defaults) and `HOLD_UNTIL_UNSET_SECS = 0`. Each script declares its own constants; none shared across files.
- **Verification:** full harness under bun (node unavailable) — all 38 `harness/test_*.js` PASS; the diff is a pure identifier substitution (constants blocks + literal swaps only).

- **Left unnamed deliberately:**
  - `Sandbox_Engine.js` `obj.schemaVersion !== 1` — the route-cache JSON schema version, a different wire contract from the typed-queue envelope; naming it `TYPED_QUEUE_SCHEMA_VERSION` would be semantically wrong.
  - `Sandbox_Engine.js` `sEnd - 60` — a 1-minute minimum kept when trimming an event end; a trim floor, not the minutes->seconds factor, so it was left rather than misnamed.
  - Bare `"0,0"` coordinate sentinels and the `"DEFAULT"` id fallback — already-named concepts (`UNUSABLE_COORDS`) or generic markers; mass literal normalisation was outside the cited scope.
  - `new Date(x * 1000)` / `getTime() / 1000` / `Math.floor(Date.now() / 1000)` — the repo's inline epoch-conversion idiom.
  - `0`, `1`, `-1`, `10` (parseInt radix), `NaN`, `null`, `""`, `true`/`false` — idiomatic, not magic numbers, per AGENTS.md.

## P2 work package A — correctness, part 1 (2026-09-24)

Cause: an invalid Dispatcher departure can poison dwell comparisons with `NaN`, while fixed-second EOD horizon math drifts from local midnight across DST.

| ID | Task | Files | Route / specialist | Status |
|---|---|---|---|---|
| A1 | Break the nav chain and warn when a stop departure or prior arrival is non-finite | Dispatcher.js, harness/test_p2_chain_horizon.js | route: delegated / general | done |
| A2 | Calculate the EOD horizon by local calendar-day addition | Sandbox_Engine.js, harness/test_p2_chain_horizon.js | route: delegated / general | done |

- **A1 evidence.** Before: `let nextDep = parseInt(nextT.departUnix || nextT.time || 0);`. After: `let nextDep = parseInt(nextT.departUnix || nextT.time || 0, 10);`, followed by a finite-value chain break that flashes `CHAIN_BREAK_INVALID_DEPART` with `warn`, trip/leg identity and departure/arrival details. The existing negative-gap and dwell-length checks are unchanged. The `nextT.time` fallback is explicitly preserved; trailing `|| 0` is also kept, so an absent value retains the old zero/negative-gap break behavior.
- **A1 red/green.** The malformed-departure test failed before the guard because the payload included both later stops; after the guard it passes with only the head coordinate and the warning present. The time-only control passes and proves a leg without `departUnix` still sequences via `time`.
- **A2 evidence.** Before: `localDayBoundaryUnix(nowSec) + EOD_HORIZON_DAYS * SECONDS_PER_DAY - 1`. After: normalize with `localDayBoundaryUnix`, add `EOD_HORIZON_DAYS` to local date components, then subtract the named `EOD_HORIZON_INCLUSIVE_OFFSET_SECS` (1).
- **A2 red/green.** With a non-empty TDS master row, instrumented assertions reached the production horizon assignment. Before the fix, spring-forward was 3,599 seconds later than expected and fall-back 3,601 seconds earlier; after, both equal the inclusive second before local midnight eight calendar days ahead.

## P2 work package A — correctness, part 2 (2026-09-24)

Cause: transient request-state read failures and malformed cache roots were mistaken for valid stale/empty state, while rejected or empty optimization results polluted cached ordering or the published timeline.

| ID | Task | Files | Route / specialist | Status |
|---|---|---|---|---|
| A3 | Preserve valid API callbacks when request state is unreadable; retain stale cleanup only for missing state | API_Parser.js, harness/test_api_parser.js | route: delegated / general | done |
| A4 | Treat an empty optimized waypoint index as no optimization | API_Parser.js, harness/test_api_parser.js | route: delegated / general | done |
| A5 | Abort geocode cache updates when parsed cache root is not an object | Geocode_Updater.js, harness/test_geocode_updater.js | route: delegated / general | done |
| A6 | Keep rejected zero-duration legs out of published timeline advancement | Compiler.js, harness/test_p2_compiler_timeline.js | route: delegated / general | done |

- **A3 evidence.** Before: `readLatestByCluster()` returned `null` for both missing and unreadable request state, so `correlationOk()` rejected both as stale and overwrote the callback payload with `{}`. After: the parser distinguishes `{state:"ok",value}`, `{state:"missing"}` and `{state:"unreadable"}`; unreadable returns before cache staging, payload overwrite or request consumption and logs `REQUEST_STATE_UNREADABLE` (`warn`). Genuine absence follows the existing `STALE_API_RESPONSE_DISCARDED` cleanup. **Red/green:** before the fix the read-throw test observed `temp_payload.json` changed from its full callback envelope to `{}`; after it passes with payload and request entry retained. The absent-file control proves the stale cleanup remains. Both cases are in the reachable test flow before `process.exit`.
- **A4 evidence.** Before: the CLUSTER branch tested `optimizedIntermediateWaypointIndex` only for truthiness, so `[]` produced `ORDER_CACHE_UPSERT` with `orderedEventIds: []`. After: that branch requires an array with `length > 0`; the existing preserve-original-order branch handles empty arrays. The non-empty reorder loop is unchanged. **Red/green:** before the fix the reachable test expected `['wp1','wp2']` but got `[]`; after it passes and stages the original waypoint order.
- **A5 evidence.** Before: after `cache = JSON.parse(raw)`, all parsed JSON values were accepted; an array property write was omitted by `JSON.stringify`. After: `null`, primitives and arrays throw into the existing `GEOCODE_CACHE_CORRUPT_ABORT` path; the cache is not written and `return_value` is `abort:corrupt_cache`. **Red/green:** before the fix the array fixture returned `ok:updated` instead of `abort:corrupt_cache`; after it passes. Existing corrupt-JSON control still asserts byte-identical input and no write.
- **A6 evidence.** Before: `currentUnix = leg.actualArrival + (leg.dropinDur || 0) + leg.stopPadSecs` ran before `ZERO_DURATION_LEG_REJECTED`, making the following published leg inherit a rejected stop's padding. After: only non-rejected legs advance `currentUnix`; rejection details include `withheldSeconds` (dwell plus padding). **Deliberate rule:** the published timeline is a function of PUBLISHED legs only. Rejection criteria are unchanged. **Red/green:** before the fix the reachable three-invocation attached-chain fixture published C at `1700000720`, 120 seconds late; after it publishes at the concrete expected `1700000600`, and the B rejection log reports `withheldSeconds: 120`.
- **Verification:** added cases execute before any process exit. API parser, geocode updater and compiler timeline tests pass after their respective fixes; the pre-fix red evidence above was observed for each changed behavior.

## P2 work package B — ordering, precision, event IDs (2026-09-24)

Cause: unusable cluster responses were cached as optimizations, one-decimal miles rounded short routes to zero, and Compiler arrival recognition accepted any ID containing the marker _IN.

| ID | Task | Files | Status |
|---|---|---|---|
| B1 | Cache cluster order only when the response supplies a usable optimization; otherwise warn and leave cache command unstaged | API_Parser.js, harness/test_p2_ordering_precision_ids.js, harness/test_api_parser.js | done |
| B2 | Serialize API and Gatekeeper-cache distances to three decimals | API_Parser.js, Gatekeeper.js, harness/test_p2_ordering_precision_ids.js, harness/test_cache_readers.js | done |
| B3 | Match the exact synthetic-arrival _IN suffix, not substring occurrence | Compiler.js, harness/test_p2_ordering_precision_ids.js | done |

- **B1 evidence.** Before: the CLUSTER parser used original waypoint order when no usable optimization existed and unconditionally staged ORDER_CACHE_UPSERT (API_Parser.js, formerly lines 146–158). After: the same usable-optimization condition gates the cache staging; absent optimization now flashes structured CLUSTER_ORDER_UNOPTIMIZED (warn, epoch-seconds timestamp, clusterId), clears par1/par2, consumes the payload and returns without cache command. **Red/green:** the reachable no-routes regression failed before the fix because par1 was ORDER_CACHE_UPSERT; after it asserts no command/payload and the warning. The optimized [1,0] control still stages [wp2,wp1]; empty-index legacy coverage was updated to expect no cache command.
- **B2 evidence.** Before: API_Parser .toFixed(1) and Gatekeeper cache-hit .toFixed(1) serialized a 50 m route as 0.0. After: each file defines DISTANCE_MILES_DECIMAL_PLACES = 3 and uses it at serialization; Compiler.js already uses named MILES_DECIMAL_PLACES = 3 for its local estimate. The direct API response and Gatekeeper cache-hit now preserve positive sub-80 m miles; a 2 km route remains 1.243. The legacy cache-reader assertion now expects 3dp. **Red/green:** the regression test failed before the fix because API_Parser returned a nonpositive rounded metric; after, the API and Gatekeeper cache-hit assertions pass with positive distance and the multi-km controls remain unchanged.
- **B3 evidence.** Before: if (pId.indexOf("_IN") !== -1 && pEv.deadline) treated dinner_IN_city_kx8f00 as arrival. After: named ARRIVAL_EVENT_ID_SUFFIX = "_IN" and suffix-only comparison. The convention is established in source: Alpha.js constructs synthetic arrival IDs as occurrence ID plus exactly "_IN" (id + "_IN" at lines 192 and 196); harness/test_id_parsing.js documents occurrence IDs as <coreId>_<base36StartUnix>. **Red/green:** before the fix the decoy's departure was 1700002300 (deadline-based) instead of 1700000400 (event end + 5-minute buffer); after the decoy is 1700000400, while the exact abc123_kx8f00_IN arrival remains deadline-based at 1700002300.
- **Verification:** all 41 harness/test_*.js suites PASS under bun, one command per test; git diff --check is clean. No commits were created.

## P2 work package B, part 2 — coverage and drift guards (2026-09-27)

Cause: several regression claims were not discriminating, fault branches lacked direct coverage, and standalone day/cache-validation copies could silently diverge.

| ID | Task | Files | Route / specialist | Status |
|---|---|---|---|---|
| B4 | Make the DST Dispatcher chain test accurately assert the dwell-only rule | harness/test_dst_utc.js | route: delegated / general | done |
| B5 | Cover negative-gap termination in the Dispatcher sequential-stop payload | harness/test_dispatcher_multi_stop.js | route: delegated / general | done |
| B6 | Cover Cluster_Builder invalid destination/origin and non-array input faults | harness/test_cluster_builder.js | route: delegated / general | done |
| D1 | Behaviorally compare standalone local-day helper copies and detect drift | harness/test_day_helper_drift.js | route: delegated / general | done |
| D2 | Compare all three route-cache validators against one shared acceptance table | harness/test_cache_validation_drift.js | route: delegated / general | done |

- **B4 evidence / before-after.** Before, the test described a local-day chain break with a 90-minute dwell, which already breaks the Dispatcher dwell-only gate, and expected one waypoint. After, the fixture uses 23:55 BST arrival and 00:05 BST departure (10-minute dwell); the comment/name and reachable payload assertion now verify that a dwell within `SHORT_STAY_MINS` chains across midnight, expecting both coordinates. `bun harness/test_dst_utc.js`: PASS. An initial run of the corrected assertion returned 1 waypoint because the fixture still had a 60-minute dwell; after correcting the second departure to the intended 10-minute instant, it returned 2. No production gate/local-day comparison was added.
- **B5 evidence / before-after.** Before, no negative-gap scenario asserted payload contents. After, SCN-13 gives the successor a departure earlier than the preceding arrival and checks that `tds_next_coords` contains only the first stop. `bun harness/test_dispatcher_multi_stop.js`: PASS. The assertion is in the normal reachable scenario flow before the final `process.exit`; no Dispatcher edit was made.
- **B6 evidence / before-after.** Before, the builder suite lacked direct checks for unusable destination/origin and a parsed non-array root. After, SCN-15 asserts non-array input returns fault, flashes `CLUSTER_BUILDER_FAULT` with its “not an array” reason, and stages no cluster; SCN-16 and SCN-17 assert empty destination and `0,0` origin are skipped with `CLUSTER_SKIPPED` reasons `no_destination_coords` and `no_origin_coords`. All assert empty staging/zero clusters. `bun harness/test_cluster_builder.js`: PASS. `Cluster_Builder.js` was not changed.
- **D1 evidence / drift-detected and restored.** New `harness/test_day_helper_drift.js` extracts each present helper copy from Alpha.js, Sandbox_Engine.js, Finaliser.js, Compiler.js, Dispatcher.js, Cluster_Builder.js, and harness/day_utils.js, then compares behavioral results under Europe/London for spring-forward, fall-back, midnight, 23:59:59, year-end, and leap-day instants. The drift probe replaces `getDate()` with `getDate() + 1` only in an in-memory extracted source string; the probe diverged as asserted, then the original unmodified extracted-source comparison passed. Production bytes were never probed or changed. `bun harness/test_day_helper_drift.js`: PASS.
- **D2 evidence / drift-detected and restored.** New `harness/test_cache_validation_drift.js` passes one shared route-entry table through extracted Route_Cache_Manager, Gatekeeper and Sandbox_Engine validators, comparing accept/reject and accepted entry values for valid, expired, nonpositive-duration, missing-field, wrong-typed, malformed JSON, empty and absent cases. The drift probe disables the positive-duration rejection only in an in-memory extracted copy; the shared nonpositive entry is then accepted by that copy and differs from the intact readers. Original sources were never mutated; intact comparison passes. `bun harness/test_cache_validation_drift.js`: PASS.
- **Touched files:** harness/test_dst_utc.js, harness/test_dispatcher_multi_stop.js, harness/test_cluster_builder.js, harness/test_day_helper_drift.js, harness/test_cache_validation_drift.js, and this tracker only. No production files changed and no production probe/temporary edit remains.
- **Verification:** full harness, one `bun harness/<test>.js` invocation per test file: all 43 `harness/test_*.js` PASS. Runtime was Bun; no dependencies added. No commit was created.

## Next step

User reviews the B→C diff and approves the sandbox apply; the user commits
manually (no broker commit; the repo pre-commit hook blocks broker commits).
- **Native RDD review (2026-09-27).** Lineage review-829c9e7179f91cc0, tier medium, one lens (review-reliability), 0 findings, approved then acknowledged; authority burned. Reviewed candidate: the B4-B6 commit only (6 files, 285 lines). Coverage defect: a base-ref yields base..HEAD, so the P1, R, S, P2 A and P2 B1-B3 commits cannot be isolated; their accumulated candidate totalled 30 files and 2438 lines and was refused at preflight with lens_context_budget_exceeded. Cause: the review boundary was never advanced per work unit, so the slice passed the reviewer budget before it was ever assessed as sliceable.
