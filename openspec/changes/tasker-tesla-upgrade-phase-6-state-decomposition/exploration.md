## Exploration: Phase 6 — State Decomposition (transient globals → reducer/trip state)

### Current State

Phase 6 is the deferred "decomposition/cleanup" roadmap item. Phase 5 explicitly deferred the four
transient memory globals here (`proposal.md`: "Reducer migration of four transient memory globals
(Phase 6)"), and the Phase 5 archive-report carries the same forward note. The Phase 3 delta spec
already defines the migration contract:

- **R-TRIP-7** — `Depart_Memory | Completed_Stops | Completed_Dropins | Arrival_Memory` SHALL be
  trip-state-only ("state wins; reject legacy").
- **R-TRIP-8** — `User_At_Base | Base_Arrival_Unix | TDS_Lateness_Halt | Current_Status |
  TDS_Manual_Return_Completed` SHALL be state-backed; "globals MAY project committed state".

Reality on master (verified by reading live code, not archives):

1. **The write-side migration is ~80% done.** Finaliser already stages `COMPLETE_DROPIN`
   (Finaliser.js:126–139) and `OBSERVE_ARRIVAL` (Finaliser.js:151–156); Stop_Logger already stages
   `COMPLETE_STOP` (Stop_Logger.js:51–64); Sandbox already stages `OBSERVE_LIVE_BASE`
   (Sandbox_Engine.js:527–534). The reducer records all of it: `state.completedDropins`,
   `state.trips[].completedDropins`, `state.trips[].observedArrivalUnix`,
   `state.completedStops`, `state.trips[].completedStops`, `state.userAtBase`,
   `state.baseArrivalUnix`, `state.manualReturnCompleted`. `project()` (Trip_State_Reducer.js:342)
   is a documented no-op awaiting PR-D, which was never implemented.

2. **The read side still consumes the globals.** The globals remain the *de facto* read source:

   | Global | Writer (live) | Reader (live) | Lifecycle | Status |
   |---|---|---|---|---|
   | `TDS_Depart_Memory` | Compiler.js:700 | Compiler.js:527 (prune + depart-change); Override_Handler PRUNE:642 | cross-day departure-change detection for API-conflict signal | **live, un-migrated** — reducer `trips[].departures[]` exists but `OBSERVE_DEPARTURE` has NO production caller (only tests) |
   | `TDS_Completed_Dropins` | Finaliser.js:167 | Finaliser.js:93 (purge completed from candidates) | same-run dropin completion purge | **read-side shim** — state written via COMPLETE_DROPIN |
   | `TDS_Arrival_Memory` | Finaliser.js:168 | Finaliser.js:95 (first-seen arrival latch) | arrival latch | **read-side shim** — state written via OBSERVE_ARRIVAL |
   | `TDS_Completed_Stops` | Stop_Logger.js:43 | Sandbox_Engine.js:18 (getRemainingStops) | ad-hoc stop accounting | **read-side shim** — state written via COMPLETE_STOP; **NOT in Override_Handler GLOBAL_MEMORIES prune list** (only 3 of 4 memories pruned — unbounded-growth gap) |
   | `User_At_Base` | Sandbox_Engine.js:521 (true), 572 (false) | Sandbox_Engine.js:519, 619, 824 | live-origin precedence | **dual-write gap** — reducer has `userAtBase` + OBSERVE_LIVE_BASE (sets true only); NO command clears it; `project()` never implemented |
   | `Base_Arrival_Unix` | Sandbox_Engine.js:521 | Sandbox_Engine.js:623 | base-arrival timestamp | state side exists (OBSERVE_LIVE_BASE:433); projection missing |
   | `TDS_Lateness_Halt` | Sandbox_Engine.js:427,1249,1343,1419,1640; Depart_Now.js:35; Return_to_Base.js:101 | Dashboard.js:244 (halt banner) | simulation-halt banner | **schema field `latenessHalt` is dead** — no reducer command mutates it |
   | `Current_Status` | Sandbox_Engine.js:616; Return_to_Base.js:100 | Dashboard.js:76; Dispatcher.js:339; Sandbox_Engine.js:439,825 | live status / IN_PROGRESS approximation (INV-0.3) | **schema field `currentStatus` is dead** — no reducer command mutates it |
   | `TDS_Manual_Return_Completed` | — (zero live references) | — | — | **already fully retired** — replaced by `state.manualReturnCompleted` (read by Unlock.js:29, Finaliser.js:282) |

3. **Vestigial pre-Phase-2/3 paths still on master:**
   - Finaliser.js:224–250 override-protection merge — reads the migration-only
     `TDS_Action_Lock.json` and writes `Engine_Output_Itinerary` (Finaliser.js:244), a global no
     other live component reads. Dead in the Generation-Publisher/manual-session architecture.
   - `TDS_Optimize_Queue.json` — written by Finaliser.js:387, cleared by Alpha.js:45, read by no
     live script. Vestigial cluster-optimization handoff.
   - `TDS_Count` — written by Alpha.js:259, read by nothing live.
   - Sandbox_Engine.js:159 `readOrigin()` — dead local copy, never called (TDS_Helper.js:51 is
     canonical; Sandbox reads `User_At_Base` global instead).
   - Byte-identical local `readActiveGeneration` copies in Compiler.js:167, Dashboard.js:30,
     Dispatcher.js:67, Sandbox_Engine.js:173, Override_Injector.js:70 vs canonical TDS_Helper.js:25.
     The Phase 3 spec ("Five resolution paths SHALL share one read-only resolver; copies MUST be
     removed") is **not satisfied**; the code comments justify the copies as required by Tasker
     standalone-script isolation. Decision needed: amend the spec or implement the par1→cached
     global indirection the TDS_Helper comment (TDS_Helper.js:20–24) proposes.
   - OVR top-level memory arrays are **already gone** (E1 moved them off `TDS_Overrides.json`);
     remaining OVR top-level arrays are legitimate category projections (`Trimmed_Events`,
     `Ignored_Lateness`, …) maintained by `syncProjections`. Not vestigial.

4. **Config staleness (verified):** `openspec/config.yaml` and `openspec/testing-capabilities.md`
   (both 2026-07-19) claim "no test framework / manual execution only", but `harness/` is the real
   deterministic runner: `mock_tasker.js` (vm sandbox mocking local/global/readFile/writeFile/flash
   + pinned Date), `runner.js`, `day_utils.js`, and **28 test scripts — all green on master
   (verified: PASS=28/28)**. Exact update scope below.

### Affected Areas

- `Trip_State_Reducer.js` — implement `project()` (state→global projection for the R-TRIP-8
  globals); add missing commands: leave-base clear (extend `OBSERVE_LIVE_BASE` with `atBase:false`
  or new `OBSERVE_BASE_LEAVE`), `OBSERVE_LATENESS_HALT`, `OBSERVE_STATUS`; decide schemaVersion
  bump (v1→v2 with migrator) if fields change; wire `OBSERVE_DEPARTURE` production caller.
- `Compiler.js` — replace `TDS_Depart_Memory` read/write with reducer `trips[].departures[]`
  history; keep `departChanged`/`departDiffMins` semantics; drop `setGlobal('TDS_Depart_Memory',…)`.
- `Finaliser.js` — read `state.completedDropins` / `state.trips[].observedArrivalUnix` for the
  purge + arrival-latch logic; drop `TDS_Completed_Dropins`/`TDS_Arrival_Memory` writes and reads;
  delete the vestigial override-protection merge (Finaliser.js:224–250) and `TDS_Optimize_Queue`
  write (Finaliser.js:387).
- `Sandbox_Engine.js` — read `state.completedStops` for `getRemainingStops`; replace
  `User_At_Base`/`Base_Arrival_Unix` reads with state (or state projection); remove dead local
  `readOrigin()`; keep `OBSERVE_LIVE_BASE` staging but complete the state round-trip.
- `Stop_Logger.js` — drop the `TDS_Completed_Stops` global write; keep `COMPLETE_STOP` staging.
- `Override_Handler.js` — remove the `GLOBAL_MEMORIES` prune loop (commandPrune:640–646) once
  memories live in reducer state (reducer already has 30-day retention); fix the missing
  `TDS_Completed_Stops` prune entry if memories stay.
- `Dashboard.js` / `Dispatcher.js` — read `TDS_Lateness_Halt`/`Current_Status` from state
  projection instead of raw globals (or keep globals as state-projected caches per R-TRIP-8).
- `Depart_Now.js`, `Return_to_Base.js` — `TDS_Lateness_Halt`/`Current_Status` clears become typed
  state commands.
- `Alpha.js` — drop `TDS_Count` write and `TDS_Optimize_Queue` clear; keep `Tesla_Last_Sync`/
  `Daily_Walk_Meters` (live day-tracking, not trip state).
- `TDS_State_Command.js` — add new reducer commands to `REDUCER_COMMANDS` +
  `REDUCER_REQUIRED_FIELDS` (owner table).
- `openspec/config.yaml` + `openspec/testing-capabilities.md` — stale testing claims (below).
- `harness/` — update `test_single_writer.js` (E2-1..E2-4 assert global writes; must assert state
  reads), `test_ac5.js`, `test_departure_day.js`, `test_trip_lifecycle.js`; add coverage for the
  new commands and projection; keep 28-suite green baseline as the regression gate.

### Approaches

1. **Read-side cutover + projection completion (full Phase 6)** — migrate all four memory-global
   reads to reducer state, implement `project()`, add the missing reducer commands, remove shim
   writes and `GLOBAL_MEMORIES` pruning, delete vestigial paths, update config/testing docs.
   - Pros: satisfies R-TRIP-7 and R-TRIP-8 completely; single source of truth; kills the
     unbounded-growth hole in `TDS_Completed_Stops`; removes dead code.
   - Cons: largest diff (Compiler, Finaliser, Sandbox, Stop_Logger, Override_Handler, Dispatcher,
     Dashboard, reducers, adapters, harness); needs a schemaVersion migration decision; multiple
     review slices required.
   - Effort: High (3–4 chained PR slices).

2. **State-authoritative reads + globals-as-projected caches** — same read-side migration, but the
   R-TRIP-8 globals (`User_At_Base`, `Current_Status`, `TDS_Lateness_Halt`, …) remain as caches
   written by `project()` after each reducer commit. Matches the spec's "globals MAY project
   committed state" and preserves Dashboard/Dispatcher/Alpha consumers unchanged.
   - Pros: spec-conformant; lowest blast radius on display consumers; keeps Tasker serial task
     reads cheap; the four memory globals are fully retired (only the five status globals project).
   - Cons: still touches most satellites for the memory-global cutover; projection adds a
     write-path to the reducer (with read-back, mirroring existing commit discipline).
   - Effort: Medium-High (3 slices).

3. **Minimal cleanup** — delete vestigial paths only (override-protection merge,
   `TDS_Optimize_Queue`, `TDS_Count`, dead `readOrigin`), fix the `TDS_Completed_Stops` prune gap,
   update config/testing docs. Leave memory-global migration to a later phase.
   - Pros: small, low-risk diff.
   - Cons: R-TRIP-7/R-TRIP-8 stay unsatisfied; dual-write hazard (`User_At_Base` true-vs-false
     divergence) persists; dead `latenessHalt`/`currentStatus` schema fields stay dead.
   - Effort: Low.

### Recommendation

**Approach 2** (state-authoritative reads, globals as projections) as the core, with the vestigial
cleanup and config/testing-doc update folded in as the final low-risk slice. Rationale:

- The write side is already mostly migrated; the remaining work is read-side cutover plus closing
  the command gaps (base-leave clear, lateness halt, status, and a production caller for
  `OBSERVE_DEPARTURE`). That is a bounded, testable migration, not an architectural change.
- The spec's R-TRIP-8 explicitly permits globals as projections, so keeping `User_At_Base` /
  `Current_Status` / `TDS_Lateness_Halt` / `Base_Arrival_Unix` as state-projected caches is the
  architecturally consistent end-state for a Tasker environment where scripts cannot import.
- The four memory globals (`TDS_Depart_Memory`, `TDS_Completed_Dropins`, `TDS_Arrival_Memory`,
  `TDS_Completed_Stops`) MUST be fully retired — the reducer already owns their state; keeping
  them invites the dual-write drift that AGENTS.md hard rules forbid.
- The `TDS_Manual_Return_Completed` hypothesis is confirmed retired — nothing to do there.
- Deliver as chained slices: (1) reducer command gaps + projection, (2) read-side cutover of the
  four memories + harness migration, (3) vestigial cleanup + config/testing-capabilities update.

### Risks

- **Departure-memory semantics**: Compiler's `departChanged`/`departDiffMins` depends on a
  *previous day's* actual departure per eventId. The reducer's `departures[]` history models this,
  but `OBSERVE_DEPARTURE` has no production caller — the cutover must decide who stages it
  (Dispatcher on vehicle action, or a planner-side observation) without losing the cross-day
  comparison or the API-conflict signal.
- **Sandbox mid-pass reads**: `TDS_Completed_Stops` is read once at module top
  (Sandbox_Engine.js:18); moving to state reads must preserve that single-snapshot behavior so the
  simulation pass is internally consistent.
- **Harness churn**: `test_single_writer.js` E2-1..E2-4 assert the globals are written
  (test_single_writer.js:523–588). The migration inverts those assertions (state reads, no global
  writes); the 28/28 green baseline is the regression gate but the suite itself changes.
- **Schema version**: adding commands/fields to `TDS_Trip_State.json` may require schemaVersion 1→2
  with an explicit migrator; `loadState` currently rejects unknown versions by resetting to
  `initialState()` (Trip_State_Reducer.js:94–97) — a reset is data loss for in-flight trips.
- **Projection write discipline**: `project()` writes globals; it must follow the reducer's
  read-back discipline and stay side-effect-safe on commit failure (projection is already gated
  behind successful commit per the reducer's atomicity order).
- **`readActiveGeneration` duplication**: the Phase 3 spec requirement ("copies MUST be removed")
  conflicts with the code's documented Tasker isolation rationale. The change must either amend the
  spec requirement or implement the par1→cached-global indirection; leaving it silent keeps a
  spec-vs-code divergence.
- **Device-only validation**: Tasker Variable Split, %-expansion, serial task handoff, GPS feeds,
  calendar auth, real Tesla API commands, and the manual-action UI flows remain manual-only — the
  harness cannot cover them (see below).

### Config/testing-doc update scope (verified against live harness)

- `openspec/config.yaml`:
  - `apply.test_command` and `verify.test_command` → `node harness/test_*.js`
    (or `for t in harness/test_*.js; do node "$t" || break; done`).
  - `testing.runner.command` → the same loop; `framework` → "none (plain Node + vm sandbox)".
  - `testing.layers.unit.available` → true, tool `node + harness/mock_tasker.js`; 
    `integration.available` → true (28 cross-component tests); `e2e.available` stays false
    (Tasker manual — device-only); `coverage.available` stays false (no coverage tool);
    linter/type_checker/formatter stay false.
  - `context` — replace "No CI, no test framework … manual execution" with the harness reality
    (keep "No CI" and "no linter/type checker/formatter"; they remain true).
- `openspec/testing-capabilities.md` — mirror the same fields; update `Detected` date to
  2026-08-07; replace the "could be created as a standalone JS file" note with the actual
  `harness/` layout (mock_tasker.js, runner.js, day_utils.js, 28 tests).

### Device-validation gate (remains manual-only)

Real Tasker runtime behaviours the harness cannot cover: `%`-prefixed variable expansion and
Variable Split semantics; serial par1/par2 command handoff between real actions (harness shims run
synchronously); `setGlobal` persistence across Tasker tasks/device restarts; GPS/geofence entry
feeds (`User_Loc`, `Car_Loc`, latches); Google Calendar auth and `ce_*` local population; real
Tesla vehicle commands (precondition/HVAC/nav/lock-unlock) and `Car_Connected`; the manual-action
scene/UI flows (Dashboard buttons, Depart_Now, Return_to_Base); external route-consumer callback
wiring retaining request correlation (Phase 5 dependency). These stay the deployment gate, as the
Phase 5 archive-report already records.

### Ready for Proposal

Yes. The orchestrator should tell the user: Phase 6 is well-scoped by the R-TRIP-7/R-TRIP-8
contract already in the archived Phase 3 delta; the write side is mostly migrated, the read side
is the remaining work, plus three small command gaps and a confirmed set of vestigial paths.
Proposal should select Approach 2 (state-authoritative reads + globals-as-projections) and plan
three chained PR slices with the harness 28/28 suite as the regression gate.
