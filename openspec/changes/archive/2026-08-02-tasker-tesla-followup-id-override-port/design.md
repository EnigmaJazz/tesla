# Design: Port ID Parsing and Override Ownership

## Technical Approach

Port branch behavior into Phase 2/3: Tasker scripts stage serial commands, `Override_Handler.js` alone commits overrides/preferences, and master reads use the manifest resolver. Schema-v2 maps replace substring membership while Handler-maintained projections preserve scoped readers until OVR-10 cleanup.

## Architecture Decisions

| Option | Tradeoff | Decision / rationale |
|---|---|---|
| Import shared helpers | Tasker has no module runtime | Keep canonical `ID_Parser.js`; inline identical semantics in consumers. |
| Call Handler in-process | Works only in harness | Mirror Reducer: `%par1` operation, `%par2` JSON; production runs the next Handler action, harness injects `handler(op,payload)`. |
| Remove legacy strings immediately | Breaks Sandbox/Compiler | Maps are authoritative; Handler emits compatibility projections, enabling a bounded later cleanup. |
| Best-effort migration | Risks learned-route loss | Snapshot original bytes, write/read-back preferences then overrides, and restore/delete both on failure. |

## Data Flow

```text
Adapter -> setLocal(par1,par2) -> Override Handler -> validate/map/mutate
                                               -> PREFS read-back -> OVR read-back -> return_value
Injector -> readActiveGeneration("itinerary") -> Adapter (legacy fallback is inside resolver)
```

## Interfaces and Storage

`parseOccurrenceId(rawId, component)` uses `lastIndexOf("_")` plus `^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$`; `parseInt(suffix,36)` is in `[1e9,2.5e9)`. Success is `{ok:true,coreId,instanceStartUnix,rawId}`; failure is `{ok:false,reason}` after a JSON flash containing `timestamp`, current/null `generationId`, `component`, `severity:"WARN"`, `code:"ID_PARSE_REJECTED"`, `tripId:null`, and `{rawId,reason}`. Reasons are `empty_id`, `malformed_format`, `invalid_suffix`. `Appender.js`, `Override_Injector.js`, and `Sandbox_Engine.js` receive exact copies of constants, regex, parser, and logger (only component differs), replacing lines 90/100/1026; rejected work is skipped.

Commands and payloads are `APPLY_OVERRIDE {targetId,overrideKey,origCoords,destCoords,baseCmd}`, `APPEND_OVERRIDE {baseId,targetArray,routeSig,modeForHistory,targetCategory,alsoAppendLate}`, `SET_DEFAULT {targetKey,isSet,clearAll}`, and `PRUNE {nowSec,whitelistMap}`. Handler validates IDs, uses `hasOwnProperty`/exact map keys, preserves Alpha's whitelist, four-hour Depart window, 24-hour retention, and 12-hour future exclusion, then serially returns JSON through `return_value`.

```json
{"schemaVersion":2,"eventOverrides":{"<occurrenceId>":{"mode":null,"skip":false,"trimmedEndUnix":null,"pitstop":null,"ignoreLateness":null,"ignoreWalk":false}}}
{"schemaVersion":2,"seriesPreferences":{"<seriesId>":{"<routeSig>":{"defaults":{},"history":{}}}}}
```

Handler also projects existing top-level override arrays and `Route_Defaults`/`Route_History`; projections are never membership authorities. First use migrates legacy preference strings once, removes them from overrides, and retains exact original bytes/absence for rollback.

## Adapter and Reader Conversion

| Script | Staging / behavior |
|---|---|
| `Alpha.js` | Stage `PRUNE` after ingestion; no file write; migrate memories below. |
| `Appender.js` | Stage `APPEND_OVERRIDE`; invalid IDs do nothing. |
| `Override_Injector.js` | Resolve committed itinerary with the inlined canonical `readActiveGeneration` algorithm, then stage `APPLY_OVERRIDE`; preserve legacy fallback/UI rerun result. |
| `Default.js` | Stage `SET_DEFAULT` for set, category clear, or clear-all. |
| `Compiler.js` | No Handler command: read/write `TDS_Depart_Memory`; retain read-only OVR access for lateness. |
| `Finaliser.js` | Use `TDS_Completed_Dropins`/`TDS_Arrival_Memory`; retain reducer completion/arrival commands. |
| `Stop_Logger.js` | Use `TDS_Completed_Stops`; retain `COMPLETE_STOP` reducer command. |

The four globals are documented ephemeral CSV compatibility state. Mutators read protected files only inside Handler. `Sandbox_Engine.js` remains a read-only OVR consumer, reads preferences directly, and uses exact series/route lookup at the changed default site; its other ten legacy membership checks remain excluded. `TDS_Helper.js` stays read-only and unchanged.

## File Changes

| Action | Files |
|---|---|
| Create | `ID_Parser.js`, `Override_Handler.js`, `harness/test_id_parsing.js`, `harness/test_single_writer.js` |
| Modify | `Alpha.js`, `Appender.js`, `Compiler.js`, `Default.js`, `Finaliser.js`, `Override_Injector.js`, `Stop_Logger.js`, `Sandbox_Engine.js`, `harness/mock_tasker.js`, `openspec/specs/itinerary/spec.md` (scoped evidence only) |

## Testing Strategy

Extend `mock_tasker.js` with `OVERRIDE_HANDLER_PATH`, OVR/PREFS guards, and `handler()` staging plus `__currentScriptPath`. Reuse branch ID tests (HIGH) and adapter sweep (MEDIUM), adding underscore-core/bounds/logging, four operations, substring decoy, map/projection consistency, migration, write/torn-write rollback, manifest/previous/legacy fixtures, globals, and unauthorized writes. These cover all 13 scenarios. Run: `for f in harness/test_*.js; do node "$f"; done`.

## Threat Matrix

The Tasker process boundary is covered by command-contract RED tests above.

| Boundary | Applicability | Design response / RED |
|---|---|---|
| Documentation-like paths | N/A — no executable classification | None |
| Git repository selection | N/A — no Git invocation | None |
| Commit state | N/A — no commit operation | None |
| Push state | N/A — no push operation | None |
| PR commands | N/A — no PR automation | None |

## Migration, Rollback, and Risks

Deployment snapshots both resources. Migration commits PREFS first and OVR second with read-back; any failure restores exact snapshots or absence and returns `ERROR`. Rollback restores both deployment snapshots and reverts adapters. Risks: preference loss, manifest-backed injector behavior, guard regressions, projection drift, and accidental pickup of stranded AC-3/5/7/synthetic/manual-return work; fixtures, full regression, and minimal hunks mitigate them.

## Chained PR Plan

| Slice | Scope | Estimate |
|---|---|---:|
| A | Parser, three inline remediations, ID tests | 300-360 |
| B | Handler shell, schemas, migration/rollback | 340-390 |
| C | Four operations, projections, operation tests | 340-390 |
| D | Alpha/Appender/Default/Injector adapters + manifest read | 330-390 |
| E | Compiler/Finaliser/Stop/Sandbox globals/readers | 310-370 |
| F | Ownership guard, sweep, evidence, regression fixes | 280-360 |

Total: 1,900-2,260 changed lines. Each sequential PR targets the preceding slice and is independently testable/revertible.

## Open Questions

None.
