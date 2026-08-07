## §25 Phase 6 — State Decomposition (transient globals → trip/reducer state)

Requirements introduced by Phase 6 (tasker-tesla-upgrade-phase-6-state-decomposition) supplementing §0 INV-0.2/INV-0.3, §1, §3 SCH-3, §8 OWN-8/RULE-8, §9 CMD-9, §13 MANUAL-13, §15 SCRIPT-15, §17 LOG-17, and §18 VAL-18. Completes the Phase 3 migration contract archived in `2026-07-31-tasker-tesla-upgrade-phase-3-trip-state-migration` ("Four override-state keys migrate to trip state" and "Five globals migrate to reducer-managed state"), which never reached this canonical spec: §8 (line ~98) still describes `Depart_Memory`, `Completed_Stops`, `Completed_Dropins`, and `Arrival_Memory` as "ephemeral globals pending Phase 3 migration". This section supersedes that sentence: the four memories become trip-state-only, the five status globals become state-backed read-only projections written by the reducer after each committed state change, and every reader consumes state rather than globals.

### Requirement: REQ-6STATE-1

The four memory keys `Depart_Memory`, `Completed_Stops`, `Completed_Dropins`, and `Arrival_Memory` SHALL be trip-state-only. Trip state is the sole source of truth for departure-change history, stop completions, dropin purge, and arrival latch. The legacy globals MUST NOT be read or written as authoritative state by any component; no live `setGlobal`/`getGlobal` of the four memory globals SHALL remain. The unbounded-growth gap for `TDS_Completed_Stops` (absent from `Override_Handler.js` `GLOBAL_MEMORIES` prune list, line 74) MUST be closed: retention/prune responsibility SHALL move to the reducer/state retention, and the Override Handler `GLOBAL_MEMORIES` list SHALL no longer own these four keys.

#### Scenario: SCN-6STATE-1 [EVT: `LEGACY_GLOBAL_READ_REJECTED`]
- GIVEN a component would read a four-memory global for planning, purge, or latch purposes
- WHEN the migration removes that read path
- THEN the component MUST consume trip state instead and the read path SHALL be structurally eliminated: no component attempts the read, and no live `getGlobal` of the four memory globals SHALL remain. Any reintroduced read is a regression blocked by review (the defensive `LEGACY_GLOBAL_READ_REJECTED` log applies to a future reintroduction, not a live path in this migration).

#### Scenario: SCN-6STATE-2 [EVT: `STATE_STOP_RETENTION_APPLIED`]
- GIVEN completed stops recorded in trip state
- WHEN retention/prune runs
- THEN completed stops MUST be pruned by state retention policy with no unbounded growth and without touching `TDS_Completed_Stops`

### Requirement: REQ-6STATE-2

The five globals `User_At_Base`, `Base_Arrival_Unix`, `TDS_Lateness_Halt`, `Current_Status`, and `TDS_Manual_Return_Completed` SHALL be state-backed. They MAY exist only as read-only projections written by the reducer's `project()` after each successful commit; globals MAY project committed state but MUST NOT be authoritative. Projection SHALL be gated: the reducer SHALL write state and perform exact read-back BEFORE projecting; on commit or read-back failure the projection MUST be skipped and the previously projected bytes MUST be preserved.

#### Scenario: SCN-6STATE-3 [EVT: `STATE_PROJECTION_SKIPPED`]
- GIVEN a reducer commit fails or its read-back does not match
- WHEN `project()` would run
- THEN projection MUST be skipped, prior global bytes MUST remain, and `STATE_PROJECTION_SKIPPED` MUST be logged

#### Scenario: SCN-6STATE-4
- GIVEN a successful reducer commit
- WHEN `project()` runs
- THEN the five globals MUST reflect exactly the committed state fields and no other source

### Requirement: REQ-6STATE-3

The reducer SHALL support the missing state transitions that activate the already-present v1 schema fields: base-leave clear (`userAtBase=false`, `baseArrivalUnix=null`), lateness halt set and clear (`latenessHalt`), and status set (`currentStatus`). `schemaVersion` SHALL remain 1 for this change — no fields are added, only commands activate dead fields. Any future schema version bump SHALL ship an explicit migrator; the current unknown-version reset (`loadState` returning `initialState()`) is data loss for in-flight trips and SHALL NOT be triggered by this change.

#### Scenario: SCN-6STATE-5
- GIVEN the vehicle leaves base or a manual action clears base state
- WHEN the typed command resolves
- THEN `userAtBase` MUST become false and `baseArrivalUnix` MUST become null, projected to `User_At_Base`

#### Scenario: SCN-6STATE-6
- GIVEN lateness halts planning or a halt is cleared
- WHEN the typed command resolves
- THEN `latenessHalt` MUST reflect the authoritative value, projected to `TDS_Lateness_Halt`

### Requirement: REQ-6STATE-4

A production component SHALL stage `OBSERVE_DEPARTURE` with the event identity, preserving cross-day departure-diff semantics: `departChanged`/`departDiffMins` SHALL compare against the previous day's actual departure for the same event, not a same-day reconstruction. The departures recorded in trip state SHALL be the sole authority for this comparison.

#### Scenario: SCN-6STATE-7 [EVT: `OBSERVE_DEPARTURE_ACCEPTED`]
- GIVEN a production departure observation for a planned event
- WHEN `OBSERVE_DEPARTURE` is staged and committed
- THEN the departure record MUST be stored and cross-day diff MUST be computed against the prior day's actual departure

### Requirement: REQ-6STATE-5

Vestigial paths from pre-Phase-2/3 architecture SHALL be removed without behavioral regression: the Finaliser override-protection merge and its `Engine_Output_Itinerary` write, `TDS_Optimize_Queue.json` (written by Finaliser, cleared by Alpha, never read), `TDS_Count`, and the dead Sandbox `readOrigin()`. Removal SHALL not change observable planning output.

#### Scenario: SCN-6STATE-8
- GIVEN a finalisation cycle
- WHEN vestigial paths are removed
- THEN no `Engine_Output_Itinerary` or `TDS_Optimize_Queue.json` write SHALL occur and the published itinerary SHALL be unchanged

### Requirement: REQ-6STATE-6

The five byte-identical local `readActiveGeneration` copies (Compiler, Dashboard, Dispatcher, Sandbox) SHALL remain as documented Tasker-isolation copies; the canonical requirement SHALL reflect this decision rather than demanding removal. `TDS_Helper.readActiveGeneration` SHALL remain the canonical implementation every consumer resolves against.

#### Scenario: SCN-6STATE-9
- GIVEN a component resolves the active generation
- WHEN the resolver requirement is applied
- THEN the local copies MUST stay byte-identical to `TDS_Helper` and the canonical spec MUST document their retention

### Requirement: REQ-6STATE-7

`openspec/config.yaml` and `openspec/testing-capabilities.md` SHALL reflect the actual testing reality: deterministic harness at `harness/` (`mock_tasker.js` vm sandbox mocking Tasker primitives with pinned `Date.now`), run with `node harness/test_*.js` (28 scripts), replacing the stale "manual execution only" claims dated 2026-07-19.

#### Scenario: SCN-6STATE-10
- GIVEN the repository documentation
- WHEN config and testing-capabilities are read
- THEN they MUST describe the harness runner and 28-script suite, not manual-only testing

### Requirement: REQ-6STATE-8

The full harness SHALL remain green (28/28) after every slice. Harness assertions that invert with the migration (single-writer E2-1..E2-4 asserting global writes become state reads) SHALL be updated in the same slice as the code they cover. Success criteria: no live get/set of the four memory globals; `project()` writes the five globals post-commit with read-back verified; canonical spec carries the migration contract; E2-1..E2-4 assert state reads.

#### Scenario: SCN-6STATE-11
- GIVEN the migration slices land
- WHEN the full suite runs
- THEN 28/28 MUST pass and the inverted E2-1..E2-4 assertions MUST assert state reads

**Evidence:** Phase 6 delta spec. **Exception:** none.
