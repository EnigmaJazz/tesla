# Design: Phase 4 — Central State Commands

## Technical Approach

Add `TDS_State_Command.js` as serial router plus Manual Action Handler. Adapters submit envelopes; owners retain persistence. Ship three revertible stacked-to-main slices.

## Architecture Decisions

| Decision | Alternative | Rationale |
|---|---|---|
| Validate an exact command table before routing. | Dynamic fallback. | Bad input cannot mutate state. |
| Keep Manual Action Handler in the router. | Another JSlet. | One serialized deployment unit. |
| `RETURN_TO_BASE` stages `SESSION_OPEN`. | Prepend a candidate. | RULE-8D owns manual records; publication stays immutable. |
| Sessions authoritative; lock fallback-only. | Dual authority. | Avoids state disagreement. |
| Match reorder commands to the committed pre-build ID. | Match the newly minted ID. | Producers can only know the generation active when they emit. |

## Command Envelope and Routing

Input is `%par1` exact name plus `%par2` JSON object. `parseEnvelope` rejects malformed JSON, unknown commands, fields/types, or IDs before invocation. `routeCommand` preserves `par1`/`par2`, sets `tds_state_owner`, and passes the owner result through `return_value` (`OK...`/`ERROR: ...`). Harness shims invoke `reducer()`/`handler()`/`publish()`; the serial Tasker task executes the staged owner next. Manual commands call in-file `manualAction`. Routes, mutations, and rejections emit every LOG-17 field.

Stable codes include `STATE_COMMAND_ROUTED`, `STATE_COMMAND_REJECTED`, `SESSION_OPENED`, `SESSION_CLOSED`, `LOCK_COMPATIBILITY_CLEARED`, `REORDER_COMMAND_ENQUEUED`, `REORDER_QUEUE_DRAINED`, `REORDER_COMMAND_REJECTED`, `STALE_REORDER_COMMAND_REJECTED`, and `HELPER_REQUEST_REJECTED`.

| Owner | Exact commands |
|---|---|
| Trip State Reducer (16) | `SET_OVERRIDE`, `REMOVE_OVERRIDE`, `DEPART_NOW`, `RETURN_TO_BASE`, `COMPLETE_STOP`, `START_UNPLANNED_STOP`, `END_UNPLANNED_STOP`, `COMPLETE_DROPIN`, `CANCEL_ACTION`, `RESET_ACTIONS`, `OBSERVE_DEPARTURE`, `OBSERVE_ARRIVAL`, `RECONCILE_GENERATION`, `COMPLETE_TRIP`, `EXPIRE_TRIP`, `OBSERVE_LIVE_BASE` |
| Override Handler (4) | `APPLY_OVERRIDE`, `APPEND_OVERRIDE`, `SET_DEFAULT`, `PRUNE` |
| Manual Action Handler (4) | `SESSION_OPEN`, `SESSION_CLOSE`, `RELEASE`, `ENQUEUE_REORDER` |
| Generation Publisher (1) | `PUBLISH_GENERATION` |

`applyDepartNow` changes only the selected trip to `IN_PROGRESS`, sets `manualDeparture`, `actualDepartUnix`, and separate `estimatedArrivalUnix`, preserving planned values. `applyReturnToBase` validates explicit policy/positive metrics and stages `SESSION_OPEN`; `openSession` mints collision-checked `action:<unix>:<4hex>`/`manual:return:<unix>:<4hex>` IDs and commits both files with snapshots, read-back, and rollback.

## Data Contracts and Flow

```json
{"schemaVersion":1,"sessions":{"<actionId>":{"actionId":"...","type":"MANUAL_RETURN","tripId":"...","createdAt":0,"expiresAt":0,"status":"ACTIVE|CLOSED|CANCELLED|EXPIRED","scopes":["PRESERVE_ACTIVE_TRIP","SUPPRESS_REPLAN_REPLACEMENT"],"closedAt":null,"closeReason":null}}}
{"schemaVersion":1,"trips":{"<tripId>":{"tripId":"...","actionId":"...","legType":"MANUAL_RETURN","lifecycleState":"IN_PROGRESS|COMPLETED|CANCELLED|EXPIRED","departurePolicy":"ASAP","originSource":"ACTIVE_MANUAL_TRIP","planningDay":"...","originCoords":"...","targetCoords":"...","targetTitle":"...","mode":"...","actualDepartUnix":0,"estimatedArrivalUnix":0,"relevanceDeadlineUnix":0,"durationSecs":1,"distanceMiles":0}}}
```

```text
adapter → State Command → Reducer/Override/Publisher
RETURN_TO_BASE → Reducer → SESSION_OPEN → Manual Handler → session + manual trip
COMPLETE_TRIP → RELEASE → Manual Handler → close exact records → clear legacy lock
```

## Slice/File Design and Rollback

| Slice | Files and exact change | Revert boundary |
|---|---|---|
| A | Create `TDS_State_Command.js` (`parseEnvelope`, `routeCommand`, `enqueueReorder`); formalize exact-ID staging in `Appender.js`/`Override_Injector.js`; stage `ENQUEUE_REORDER` in `Gatekeeper.js`/`API_Parser.js`; fix Publisher `validateReorderCommand`/`drainReorderQueue`; extend `harness/mock_tasker.js`; add `test_state_command.js`, `test_reorder_queue.js`. | Revert A; restore producer writes and Publisher logic. |
| B | Add Reducer `applyDepartNow`/`applyReturnToBase`; convert `Depart_Now.js`/`Return_to_Base.js`; add `openSession`/`closeSession`/`releaseSession`; make `Compiler.js`/`Dispatcher.js` session-primary with lock fallback; add `test_manual_session.js`. | Restore data snapshots, revert B; lock stays readable. |
| C | Stage `COMPLETE_STOP` in `Stop_Logger.js`, exact `RELEASE` in `Unlock.js`, and `COMPLETE_TRIP` then `RELEASE` in `Finaliser.js`; make `TDS_Helper.js` accept only `readOrigin`/`readActiveGeneration`, rejecting generic/unknown requests without writes; revise `test_ac5.js`; add `test_release_commands.js`. | Revert C adapters/helper/tests; retain B records. |

## Ownership and Migration Contracts

| Resource | Authorized mutation |
|---|---|
| `TDS_Action_Sessions.json`, `TDS_Manual_Trips.json` | Manual Action Handler only. |
| `TDS_Reorder_Commands.json` | State Command appends; Publisher drains and clears. |
| `TDS_Action_Lock.json` | Manual Action Handler may only clear; never authoritative or created. |

Readers use active sessions/manual trips first. Only absent/unreadable sessions permit Compiler/Dispatcher `isActionLocked` to honor an unexpired lock; an empty session map means unlocked. `RELEASE` exactly matches `actionId`/`tripId`, closes that lifecycle, and may clear its matching lock.

Producers stamp `TDS_Active_Generation || null` at emission. Publisher captures committed `previousId` before build; `APPLY_CLUSTER_REORDER` accepts only it, plus migration-null commands from known sources whose exact IDs exist in one candidate planning day. Reject stale/malformed commands; every publish drains and read-back-clears the queue. Remove `remaining.push(cmd)` and minted-ID matching.

## Testing, Threat Matrix, and Risks

Each slice runs focused RED/GREEN tests, failure injection, `node --check`, then `for t in harness/test_*.js; do node "$t" || break; done`; baseline 20/20 stays green. `mock_tasker.js` adds `stateCommand()` and owner guards for sessions, manual trips, lock, and queue.

| Threat boundary | Applicability / response | RED tests |
|---|---|---|
| Documentation-like paths | N/A — no executable classification. | None |
| Git repository selection | N/A — no Git invocation. | None |
| Commit state | N/A — no commit automation. | None |
| Push state | N/A — no push automation. | None |
| PR commands | N/A — no PR composition. | None |

| Risk | Level | Mitigation |
|---|---|---|
| Wrong reorder generation applies stale order. | CRITICAL | Pre-build/current/stale/null harness matrix; drain proof. |
| Torn two-file session commit. | CRITICAL | Snapshot, read-back, exact rollback, failure injection. |
| Legacy lock outlives session authority. | WARNING | Fallback only when session storage is unavailable; Handler-only clear. |
| Slice exceeds 400 changed lines. | WARNING | Stop and ask under `ask-on-risk`; retain stacked-to-main boundaries. |

## Open Questions

None.
