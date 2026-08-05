# Exploration Record: Phase 4 — Central State Commands

## Scope Source

Canonical `_spec_source.md` Phase 4 requires a serialised command handler; migration of Appender, Override Injector, Depart Now, Return to Base, Stop Logger, and Unlock; and a read-only `TDS_Helper`. Memory #137 additionally requires `TDS_Action_Lock.json` consolidation and `APPLY_CLUSTER_REORDER` remediation.

## Verified Baseline

- `Trip_State_Reducer.js` already follows a `%par1`/`%par2` validate → reduce → read-back commit pattern. It declares 16 commands; 7 work and 9 are `stubApply`, including `DEPART_NOW` and `RETURN_TO_BASE`.
- `Override_Handler.js` serially handles `APPLY_OVERRIDE`, `APPEND_OVERRIDE`, `SET_DEFAULT`, and `PRUNE`. Appender stages `APPEND_OVERRIDE`; Override Injector stages `APPLY_OVERRIDE`; Stop Logger stages `COMPLETE_STOP`. None directly write their protected resources.
- Depart Now and Return to Base currently reread the manifest plus three committed files, construct a full candidate, and stage it to Generation Publisher. This is read-modify-write behavior outside the intended manual command lifecycle.
- Unlock is the remaining direct writer of `TDS_Action_Lock.json`, clearing it after `manualReturnCompleted`. Finaliser has the same gated clear. No live script writes `TDS_Manual_Trips.json` or `TDS_Action_Sessions.json`; RULE-8D is therefore not implemented.
- `TDS_Helper.js` resolves manifest-backed reads and contains an untested legacy `Filename:Index:Key` generic getter. `readActive` and `readActiveGeneration` have a deduplication opportunity.

## Publisher/Reorder Finding — Critical

`Generation_Publisher.js` drains `TDS_Reorder_Commands.json` during publish. Gatekeeper and API Parser stamp commands with `TDS_Active_Generation || null`, but `validateReorderCommand` compares non-null command IDs to the freshly minted publish ID. Consequently every real-stamped command is rejected as stale; only null-ID commands can apply. `drainReorderQueue` also pushes rejected commands into `remaining` and then unconditionally clears the queue, making that array dead.

The selected correction is to compare the command ID with the pre-build committed generation, permit only the explicitly defined legacy-null path, and drain-and-clear the ephemeral queue. Producers will stage `ENQUEUE_REORDER`; `TDS_State_Command` becomes the sole queue writer while Generation Publisher remains sole drainer.

## Architectural Decisions

1. Add `TDS_State_Command.js` as the serial Tasker router. It validates payloads, routes only to named owners, and emits structured JSON evidence.
2. Use typed manual commands rather than prebuilt full-generation candidates. `DEPART_NOW` changes only the selected lifecycle state; `RETURN_TO_BASE` creates a unique manual-trip request for Dispatcher priority and never prepends a committed itinerary.
3. Implement RULE-8D: Manual Action Handler owns `TDS_Manual_Trips.json` and new `TDS_Action_Sessions.json`. Sessions replace the lock. The old lock is compatibility-only, may be cleared only by that handler during migration, and is not authoritative.
4. Add ownership coverage in `harness/mock_tasker.js` for action sessions, manual trips, lock compatibility, and reorder queue. Revise `test_ac5.js` assertions that currently prohibit session writes.
5. Restrict TDS Helper to explicit read-only manifest helpers; remove or isolate the generic getter rather than expanding it.

## Delivery Forecast

| Stacked PR | Work unit | Estimate |
|---|---|---:|
| 1 → main | Router, Appender/Injector, enqueue reorder, Publisher repair, tests | 330–390 |
| 2 → main | Depart/Return, Manual Action Handler sessions/lock migration, tests | 360–400 |
| 3 → main | Stop/Unlock/Finaliser release adapters, Helper restriction, tests | 250–320 |

Each slice must keep its tests and any affected ownership documentation in the same review unit. The full harness baseline is 20/20 green at `75eb5f2`.
