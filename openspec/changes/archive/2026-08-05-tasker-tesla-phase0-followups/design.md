# Design: Tasker Tesla Phase 0 Follow-ups

## Technical Approach

Deliver four slices in three PRs: A adds DST-safe days; B completes the observed manual return and suppresses unplanned returns; C enforces route fallback; D adds exact-key reads. No new runtime script or dependency.

## Architecture Decisions

| Decision | Alternatives | Rationale |
|---|---|---|
| Derive `localPlanningDay(unix)` from the configured timezone; use existing `utcDayBoundaryUnix`, `isSameUTCDay`, and `SECONDS_PER_DAY` for UTC ordinals. | Add/subtract 86,400 seconds. | Labels remain DST-correct. |
| Preserve columns 17–19; append 20 `planningDay` and 21 `originSource`. | Reorder or infer. | Preserves Compiler’s protocol and explicit state. |
| Use `COMPLETE_TRIP`, then close existing `TDS_Action_Lock.json` through its unlock/cleanup path. | Add a handler or session file. | Reducer completion is authorized; RULE-8D history is Phase 4. |
| Resolve metrics as validated API → positive Sandbox metrics → local haversine for `ACTIVE_TRAVEL` only → reject. | Publish zero or estimate every mode. | Preserves source quality and forbids zero-duration travel legs. |
| Add read-only exact-key helpers over schema-v2 maps. | Rewrite UI checks. | Limits OVR-10 to identity membership. |

## Data Flow

```text
Sandbox local-day planner ──columns 17..21──> Compiler ──validated legs──> publisher
       │                                           │
       └─base transition─> COMPLETE_TRIP ─> Trip State Reducer
                                └─success─> existing Action Lock clear path
Dispatcher ──planningDay <= today──> actionable vehicle command
```

## Ownership Impact

| Resource | Owner / impact |
|---|---|
| `TDS_Trip_State.json` | Trip State Reducer remains sole writer; Sandbox only submits `COMPLETE_TRIP`. |
| `TDS_Action_Lock.json` | `Return_to_Base.js`, `Depart_Now.js`, and `Unlock.js` retain writes; Compiler/Dispatcher retain reads; Finaliser clears. Add no writer or session file. |
| Published itinerary | Compiler accumulates; Generation Publisher remains sole publisher. |

## File Changes

| File | Action | Description |
|---|---|---|
| `Sandbox_Engine.js` | Modify | Boundaries, columns, logs, AC-6 precedence, completion observer, suppression, metrics, and exact reads. Remove EOD `_IN` inference; `skipIdx` is the first next-day index. |
| `Trip_State_Reducer.js` | Modify | Implement idempotent `COMPLETE_TRIP`. |
| `Dispatcher.js` | Modify | Reject future `planningDay` candidates with `EVT-FUTURE_TRIP_NOT_DUE`. |
| `Compiler.js` | Modify | Apply fallback tiers and reject zero-duration travel. |
| `Finaliser.js`, `Unlock.js` | Modify | Reuse lock close after successful completion; add no RULE-8D storage. |
| `harness/test_ac3_sandbox.js`, `harness/test_ac5.js`, `harness/test_sandbox_ovr10.js` | Create | Focused RED regressions for slices A, B, and D. |
| `harness/test_sandbox_ac6.js`, `harness/test_dst_utc.js`, `harness/test_departure_day.js`, `harness/test_compiler_ac1.js` | Modify | Extend precedence, DST/boundary, flush, and metric fallback coverage. |

## Interfaces / Data Contracts

| Contract | Shape / rule |
|---|---|
| Queue row | Columns 17 `durationSecs`, 18 `distanceMiles`, 19 `departurePolicy`, 20 `planningDay`, 21 `originSource`; metrics positive. |
| `COMPLETE_TRIP` | `{generationId, tripId, at, planningDay}`; only matched `IN_PROGRESS`/`ARRIVED` becomes `COMPLETED`; set `completedUnix` and `lastActivityUnix`; repeated completion is a no-op; later trips remain unchanged. |
| Exact readers | `getOvrEntry`, `hasExactOverride`, `getLatenessMode`, `hasExactPref` use own-properties of `eventOverrides`/`seriesPreferences`; retain `eventId~fixed`/`~shifted`. `parseOccurrenceId` already uses `lastIndexOf("_")` at Sandbox lines 44/1079: test only. |
| Logs | Emit `EVT-OVERNIGHT_BOUNDARY_CREATED`, `EVT-CROSS_DAY_CHAIN_REJECTED`, and `EVT-SYNTHETIC_RETURN_SUPPRESSED`; fallback uses `EVT-DEPARTURE_POLICY_FALLBACK_USED` with `{from,to,durationSecs,distanceMiles}`. |

## Testing Strategy

| PR | Harness proof |
|---|---|
| 1 / A | New AC-3 test; extend AC-6, DST, and departure-day tests for overnight handoff, `skipIdx`, columns, and boundary events. |
| 2 / B | New AC-5 test: transitions, idempotence, exact-trip mutation, tomorrow unchanged, future rejection, suppression, and lock close without session writes. |
| 3 / C+D | Extend compiler AC-1 for all tiers; add OVR-10 decoys and underscore-core regression. |

Full harness grows from 17 to 20 scripts and must remain green.

## Threat Matrix

This change plans travel routes but adds no shell, subprocess, executable classification, VCS/PR automation, or external process-integration boundary.

| Boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no executable classification. |
| Git repository selection | N/A — no Git invocation. |
| Commit state | N/A — no commit automation. |
| Push state | N/A — no push automation. |
| PR commands | N/A — no PR command composition. |

## Migration / Rollout

No persistent migration. Ship A, B, then C+D; each PR reverts with its harness changes. RULE-8D `TDS_Action_Sessions.json` migration/history remains Phase 4 out of scope.

## Risks

| Risk | Mitigation |
|---|---|
| Single-bit action lock has no history. | Clear only after reducer success; rely on idempotent completion. Do not emulate Phase 4 sessions. |
| Column drift breaks Compiler. | Preserve 17–19 and assert all five columns. |
| AC-3 regresses live-base precedence or consumes tomorrow. | Keep AC-6 precedence and boundary-survival tests. |
| Local estimate masks missing route data. | Restrict haversine to `ACTIVE_TRAVEL`; otherwise reject/log. |
| Exact-key cleanup alters delimiter/UI parsing. | Change identity reads only; leave UI `indexOf` checks untouched. |

## Open Questions

None.
