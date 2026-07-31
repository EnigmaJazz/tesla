# Design: Phase 3 — Trip-State Migration

## 1. Goal

Persist progress/origin through `Trip_State_Reducer.js`; cut readers/writers to `TDS_Trip_State.json`. Publication stays manifest-owned; reconciliation is post-commit/self-healing.

## 2. Architecture

| Decision | Choice / rationale | Trade-off |
|---|---|---|
| Boundary | Tasker action: `%par1` name, `%par2` payload, `%par3` context. | Direct calls race. |
| Reader | `TDS_Helper`: `readActiveGeneration(kind)`, `readTripState()`; Tasker passes `return_value`. | Pre-reader action. |
| Reconcile | Publisher sends internal `RECONCILE_GENERATION {generationId,at}` after manifest read-back; reducer also repairs drift. One revision imports/supersedes. | Post-commit lag. |
| DST | Finaliser supplies `planningDay`; reducer preserves labels and computes ordinals with `Date.UTC(y,m-1,d)/86400000`. | Reject missing labels; never local `86400` math. |

```mermaid
sequenceDiagram
 Producer->>Trip State Task: par1/par2/par3
 Trip State Task->>Reducer: serialized invocation
 Reducer->>Manifest: reconcile if generation differs
 Reducer->>TDS_Trip_State.json: write; exact read-back
 Reducer-->>Tasker globals: project committed state
```

```text
Trip_State_Reducer.js→create:sole-writer/endpoint
Generation_Publisher.js→modify:post-commit-reconcile
TDS_Helper.js→modify:central-manifest/state-reads
Alpha.js→modify:remove-migrated-OVR-pruning
Compiler.js→modify:state-read/departure-command/central-resolver
Finaliser.js→modify:arrival-commands/remove-OVR-writes
Stop_Logger.js→modify:COMPLETE_STOP-adapter
Sandbox_Engine.js→modify:explicit-origin/base/stops
Dispatcher.js→modify:central-itinerary/state-selection
Dashboard.js→modify:state-backed-status
Depart_Now.js→modify:command/no-global-write
Return_to_Base.js→modify:policy-command/no-global-writes
```

Nine-file estimate omitted mandatory reconciliation/adapters. Remove inline resolvers/support and OVR accesses.

## 3. Trip State Reducer design

Functions: `parseCommand(name,json,contextJson)`, `loadState()`, `reconcileGeneration(state,id,at)`, pure `reduce(state,command,context)`, `prune(state,day)`, `commit(oldRaw,newState)`, `project(sideEffects)`; Tasker adapter.

```json
{"schemaVersion":1,"revision":0,"generationId":"gen:1700000000:abcd","currentOrigin":"ACTIVE_MANUAL_TRIP|ACTIVE_PLANNED_TRIP|LIVE_BASE|LIVE_LOCATION|CONFIRMED_LAST_DESTINATION|OVERNIGHT_BASE_RESET|LEGACY_ITINERARY_FALLBACK","currentPlanningDay":"YYYY-MM-DD","userAtBase":false,"baseArrivalUnix":null,"latenessHalt":false,"currentStatus":"","manualReturnCompleted":false,"trips":{"<tripId>":{"state":"PLANNED|DUE|IN_PROGRESS|ARRIVED|COMPLETED|MISSED|SUPERSEDED|CANCELLED","tripId":"...","generationId":"...","legType":"...","mode":"...","originSource":"...","departurePolicy":"JIT|ASAP","planningDay":"YYYY-MM-DD","relevanceDeadlineUnix":0,"completionPolicy":"...","lastDepartureUnix":null,"arrivalUnix":null}},"stops":{"<stopId>":{"tripId":"...","state":"ACTIVE|COMPLETED","ordinal":0,"durationSecs":0,"startedUnix":null,"completedUnix":null}},"manualSessions":{"<actionId>":{"tripId":"...","state":"ACTIVE|COMPLETED|CANCELLED","policy":"MANUAL|RECOVERY|EOD|SAFETY|VEHICLE","startedUnix":0,"completedUnix":null}}}
```

Payloads include `generationId`; `at` is Unix seconds. Result: `{newState,sideEffects,result}`.

| Command / payload beyond common fields | Transition; output/code |
|---|---|
| `SET_OVERRIDE {key,value}` / `REMOVE_OVERRIDE {key}` | Delegate to Override Handler; no mutation. |
| `DEPART_NOW {tripId,at}` | `PLANNED|DUE→IN_PROGRESS`; active origin. |
| `RETURN_TO_BASE {actionId,tripId,policy,at}` | Activate session/trip; missing policy `SYNTHETIC_RETURN_SUPPRESSED`; duplicate EOD `REDUNDANT_EOD_RETURN_REJECTED`. |
| `COMPLETE_STOP {stopId,tripId,at}` | Idempotent stop completion. |
| `START_UNPLANNED_STOP {stopId,tripId,at}` / `END_UNPLANNED_STOP {stopId,at}` | Stop `ACTIVE→COMPLETED`. |
| `CANCEL_ACTION {actionId,at}` | Session/linked trip `CANCELLED`. |
| `RESET_ACTIONS {actionId?,at}` | Remove terminal sessions; clear halt. |
| `OBSERVE_DEPARTURE {tripId,at}` | `%par3.evidence=DUE_WINDOW`: `PLANNED→DUE`; `MOVEMENT`: `PLANNED|DUE→IN_PROGRESS`; record departure. |
| `OBSERVE_ARRIVAL {tripId,at,accuracyM}` | Qualified sample(s): `IN_PROGRESS→ARRIVED`; record evidence. |
| `COMPLETE_TRIP {tripId,at}` | `ARRIVED→COMPLETED`; later trips unchanged; early access: `FUTURE_TRIP_NOT_DUE`. |
| `EXPIRE_TRIP {tripId,at}` | Eligible nonterminal `→MISSED` only after deadline. |

Logs are `{timestamp,generationId,component,severity,code,tripId,details}`. Rejections: `INVALID_STATE_COMMAND`, `STALE_TRIP_REJECTED`, `CROSS_DAY_CHAIN_REJECTED`, `ZERO_DURATION_LEG_REJECTED`, `DEPARTURE_POLICY_FALLBACK_USED`. Mutations: `LIVE_BASE_OVERRIDES_LEGACY_ORIGIN`, `OVERNIGHT_BOUNDARY_CREATED`, `GENERATION_RECONCILED`; failures: `GENERATION_VALIDATION_FAILED`/`TRIP_STATE_PROJECTION_FAILED`. `EVT-*` aliases map to AGENTS codes.

Mutation increments `revision` once. Schema changes require migrators; future versions reject. `commit` read-backs, restores `oldRaw` on mismatch, skips projection. Projection retries. Prune day 31 except active/session/current records.

## 4. Migration plan

| Source | Target | PR / compatibility |
|---|---|---|
| OVR `Arrival_Memory`, `Completed_Dropins` | trip `arrivalUnix`/`ARRIVED` | B; hard; Alpha drops keys. |
| OVR `Completed_Stops` | `stops[stopId]` | C; hard cutover. |
| OVR `Depart_Memory` | trip `lastDepartureUnix` | D; hard cutover. |
| `User_At_Base`, `Base_Arrival_Unix` | base/origin fields | B; reducer projects through F. |
| `TDS_Lateness_Halt`, `Current_Status` | `latenessHalt`, `currentStatus` | F; state-first, projected globals. |
| `TDS_Manual_Return_Completed` | flag/session | F; import legacy `true` once, clear, project. |

PR-E cuts four consumers together; no legacy resolver remains.

## 5. Chain plan

| PR | Goal; files; estimate | Dependency; acceptance/tests; risk |
|---|---|---|
| A | Reducer, mock, command test; ~370 | None; 13 commands/read-back; torn writes. |
| B | Reducer, Finaliser, Alpha, Sandbox, lifecycle test; ~390 | A; arrival/base hard-cut; samples. |
| C | Stop Logger, Sandbox, command test; ~300 | B; stable stop/once-only duration; duplicates. |
| D | Compiler, Alpha, Reducer, boundary test; ~330 | A,C; no depart memory/cross-day; stale generation. |
| E | Helper, four readers, origin test; ~380 | A–D; one authority; Tasker handoff. |
| F | Publisher, adapters, Reducer, return tests; ~390 | A–E; same-revision supersession/projections; lag. |

Each follows main, is reversible, below 400 lines.

## 6. Test architecture

| New harness | Coverage |
|---|---|
| `test_reducer_commands.js` | writer/reconcile/concurrency; commands; migrations/retention/version/atomicity |
| `test_trip_lifecycle.js` | progression and three terminal outcomes |
| `test_origin_precedence.js` | adjacent precedence; no inference |
| `test_day_boundary.js` | cross-day, DST labels, UTC/local disagreement |
| `test_post_return_isolation.js` | tomorrow remains `PLANNED`/JIT |
| `test_synthetic_return_rejection.js` | missing/five allowed policies |

Mock serialization/projection failures. Update compiler AC1/AC8, sandbox AC6, five atomic-publication scenarios; retain projections. Use `node:assert/strict`, shared fixtures, pinned `Date`; run `for t in harness/test_*.js; do node "$t" || break; done`.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Same-tick RMW | Serialize; reload committed bytes. |
| File/global tear | Exact read-back; audit/retry projection. |
| Growth | Exempting pruner. |
| Origin inference | Explicit evidence/precedence tests. |
| Empty-day movement | Policy allow-list. |
| Harness parity | State fixtures/projections. |
| DST | Finaliser converts; reducer preserves labels/calendar ordinals. |
| Reconciliation | Post-commit internal command plus cycle drift repair. |

Threat matrix: documentation paths, Git selection, commit, push, PR commands are **N/A**—no shell/VCS/PR boundary. Tasker handoff has command/failure RED tests.

## 8. Out of scope

Three existing AGENTS violations; `TDS_Previous_Loc`; schema-v2 `eventOverrides`; routine preferences; manual-trip/action-session files; `var` cleanup; Publisher-adapter deduplication.
