# Proposal: Phase 4 — Central State Commands

## Intent

Route Phase 4 entry points through serial typed commands so persistent state has accountable writers and reorder commands can apply.

## Current-State Gap

Depart/Return rebuild candidates, Unlock clears a lock directly, and current-generation reorder commands fail against a minted ID. RULE-8D has no owner or sessions.

## Scope

### In Scope
- Add validated, structured-log `TDS_State_Command.js` routing `%par1`/`%par2` commands to explicit owners.
- Migrate the six adapters and Finaliser release path; make `TDS_Helper.js` named-read-only.
- Add sessions, typed manual/stop/release/reorder flows, and ownership/reorder harness coverage.

### Out of Scope
- Phase 5 typed route/cache protocols, planner redesign, or a generic Tasker setter.
- Any direct published-itinerary mutation by an entry script.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `itinerary`: CMD-9, OWN-8/RULE-8D, MANUAL-13, STOP-14, CLUSTER-12, and SCRIPT-15 command/ownership behavior.

## Approach

1. **Slices:** three stacked-to-main units: A—Appender/Injector + enqueue reorder (330–390 lines); B—Depart/Return + sessions (360–400); C—Stop/Unlock/Helper + release (250–320). Keep tests/docs with each unit.
2. **Manual actions:** typed commands, not candidate serialization. `DEPART_NOW` changes only its selected lifecycle; `RETURN_TO_BASE` creates a unique manual trip/session, never a committed-itinerary prepend.
3. **Sessions:** Manual Action Handler owns sessions/manual trips. Lock is migration-only, clearable only by that owner, never authoritative; revise the “never write sessions” test.
4. **Reorder:** compare `generationId` to the pre-build committed generation; drain-and-clear. Remove minted-ID matching and dead `remaining`.
5. **Ownership:** producers stage `ENQUEUE_REORDER`; State Command writes the queue; Publisher drains it. Add owner rows for queue and lock compatibility.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `TDS_State_Command.js` | New | Serial router/owners |
| `Depart_Now.js`, `Return_to_Base.js`, `Unlock.js` | Modified | Command adapters |
| `Generation_Publisher.js` | Modified | Pre-build reorder admission |
| `harness/` | Modified | Ownership and lifecycle proof |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bad reorder generation comparison | High | Prove current/stale/null cases |
| Session migration regresses manual return | Medium | Test completion and future JIT isolation |
| Slice exceeds budget | Medium | Split before apply; no exception assumed |

## Rollback Plan

Revert slices independently. Restore session/manual-trip bytes before lock fallback; Publisher rollback changes no committed generation.

## Dependencies

- Phase 2 Publisher and Phase 3 Reducer contracts; 20/20 harness baseline.

## Success Criteria

- [ ] The 20/20 baseline and new command, ownership, session, manual-return, stop, and reorder scenarios pass.
- [ ] Only declared owners write sessions/manual trips, lock compatibility, and reorder queue; entry points only stage commands.
- [ ] A current-generation reorder applies; stale and malformed commands log rejection and do not persist.
