# Tasks: Phase 4 — Central State Commands

## Slice Mapping

| Slice | Scope | PR |
|---|---|---|
| A | Router, exact-ID adapters, reorder enqueue/drain and generation admission | PR-A → main |
| B | Manual Action Handler, sessions/manual trips, Depart Now and Return to Base | PR-B → main |
| C | Stop/release adapters, Finaliser release, Helper restriction, ownership guards | PR-C → main |

## Review Workload Forecast

| Slice | Estimate (tests + doc ledgers included) | Risk |
|---|---:|---|
| A | ~350–390 lines | Medium |
| B | ~380–420 lines | **High; possible >400** |
| C | ~270–330 lines | Low–Medium |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Under `ask-on-risk`, stop before applying Slice B if its measured diff exceeds 400 lines; ask whether to split or obtain a `size:exception`. Slice A must land before B, and B before C.

## Slice A — PR-A

- [x] **A1 RED — Router/reorder regressions.** Create `harness/test_state_command.js` and `harness/test_reorder_queue.js`; assert malformed/unknown envelopes do not mutate, exactly one owner routes, exact IDs stage, current/pre-build vs stale/null reorder behavior, drain-clear, and no `remaining`. Covers REQ-4CMD-1/SCN-4CMD-1..2, REQ-4ADAPTER-1..2/SCN-4ADAPTER-1..2, REQ-4REORDER-1..2/SCN-4REORDER-1..3; must fail on master.
- [x] **A2 GREEN — Central routing and reorder ownership.** Create `TDS_State_Command.js`; modify `Appender.js`, `Override_Injector.js`, `Gatekeeper.js`, `API_Parser.js`, `Generation_Publisher.js`, and `harness/mock_tasker.js` for exact-ID staging, `ENQUEUE_REORDER`, pre-build generation matching, drain/clear, structured LOG-17 fields, and owner rows. Done when A1 passes without published writes.
- [x] **A3 VERIFY —** Run `node harness/test_state_command.js`, `node harness/test_reorder_queue.js`, then `for t in harness/test_*.js; do node "$t" || break; done`; focused and full suites pass (baseline 20/20), queue is empty after publish, and `node --check` passes.

## Slice B — PR-B

- [x] **B1 RED — Manual-session regressions.** Create `harness/test_manual_session.js`; revise `harness/test_ac5.js` to assert typed Depart/Return, exact session/trip ownership, two-file rollback, lock compatibility, completion, and tomorrow PLANNED/JIT isolation. Covers REQ-4ADAPTER-3..4, REQ-4SESSION-1..2, SCN-4ADAPTER-3..4, SCN-4SESSION-1..2; must fail on A.
- [x] **B2 GREEN — Manual Action Handler.** Modify `Trip_State_Reducer.js`, `Depart_Now.js`, `Return_to_Base.js`, `TDS_State_Command.js`, `Compiler.js`, `Dispatcher.js`, and schemas `TDS_Action_Sessions.json`/`TDS_Manual_Trips.json`; implement typed lifecycle changes, collision-safe IDs, snapshots/read-back/rollback, session-primary reads, and handler-only lock clearing. Done when B1 passes.
- [x] **B3 VERIFY —** Run `node harness/test_manual_session.js`, `node harness/test_ac5.js`, then the full harness and `node --check`; require 20/20 plus new assertions, no candidate prepend, and future JIT unchanged.

## Slice C — PR-C

- [x] **C1 RED — Release/helper/ownership regressions.** Create `harness/test_release_commands.js`; extend `harness/mock_tasker.js` guards and `test_ac5.js` for COMPLETE_STOP, exact RELEASE, Finaliser completion, helper rejection, and unauthorized session/manual-trip/lock/queue writes. Covers REQ-4ADAPTER-5..7, REQ-4HELPER-1, REQ-4LOG-1 and SCN-4ADAPTER-5..7, SCN-4HELPER-1, SCN-4LOG-1; must fail on B.
- [x] **C2 GREEN — Complete release path.** Modify `Stop_Logger.js`, `Unlock.js`, `Finaliser.js`, `TDS_Helper.js`, and `harness/mock_tasker.js` to stage typed commands, restrict named reads, and enforce owner rows/LOG-17. Done when C1 passes with no direct clears/writes.
- [x] **C3 VERIFY —** Run focused release/AC-5 harnesses, then full suite and `node --check`; require 20/20, exact-session closure, helper no-write rejection, and clean ownership audit.

## Test Plan

New: `harness/test_state_command.js`, `harness/test_reorder_queue.js`, `harness/test_manual_session.js`, `harness/test_release_commands.js`. Extended: `harness/test_ac5.js`, `harness/mock_tasker.js`. Threat-matrix rows are all N/A; no additional threat RED tests apply.
