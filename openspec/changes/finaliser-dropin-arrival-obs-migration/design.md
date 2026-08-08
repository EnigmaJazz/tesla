# Design: Finaliser Dropin/Arrival Observation Migration

Satisfies REQ-6F2-1 (dual-path accumulation, par1 primary-last), REQ-6F2-2 (flush-skip on invalid genId), REQ-6F2-3 (publisher merge `[RECONCILE_GENERATION, ...obs]` with genId re-stamp; 31-obs cap, drop excess with structured log, never all-or-nothing), REQ-6F2-4 (serial-mode harness proof), REQ-6FU-4 MODIFIED (D5 annotation removed, SCN-6FU-12 added). No TDS_State_Command / Trip_State_Reducer / Sandbox_Engine / Tasker-task-loop changes.

## Technical Approach

In one Finaliser pass the serial Tasker model delivers only the LAST staged `par1`/`par2`. Today `COMPLETE_DROPIN` (Finaliser.js:143-149) then `OBSERVE_ARRIVAL` (:167-172) stage raw `setLocal("par1",...)`; the first observation is clobbered before the reducer sees it, and `publishCandidate` (:224) re-stages `par1` as the candidate. The ～8K-line V18 engine therefore loses one dropin/arrival observation per qualifying pass on device; the synchronous reducer shim masks the loss.

We relocate both observations into a **dedicated local** (mirrors the existing `tds_release_par1/par2` release-staging precedent and the FU1 Sandbox pattern `stageReducerCommand` / end-of-pass `REDUCER_BATCH` flush at Sandbox_Engine.js:1827-1833). The Finaliser accumulates an ordered list for the pass; the Generation_Publisher serial branch (:219-223) merges the list into the existing post-publish reconcile, re-stamping each observation's `generationId` to the freshly minted `genId`. The envelope then reaches `TDS_State_Command` → `Trip_State_Reducer.applyBatch` (REDUCER_BATCH_DELIVERED, :680-683) — the FU1 machinery already landed. Net: one serial `REDUCER_BATCH` delivers `[RECONCILE_GENERATION, COMPLETE_DROPIN, OBSERVE_ARRIVAL]` in order, candidate primary-last, no observation sacrificed.

## Architecture Decisions

| Decision | Options (tradeoff) | Choice |
|---|---|---|
| Dedicated local name | `tds_obs_batch_par1`+`tds_obs_batch_par2` (follow release precedent, zero collision) vs single `tds_obs_batch` string (avoids sentinel) vs a Finaliser-written staging file (cross-owner IO) | `tds_obs_batch_par1` = `"OBSERVATION_BATCH"` sentinel; `tds_obs_batch_par2` = JSON array of `{command, payload}`. Verified non-colliding against existing Finaliser locals (`par1/par2`, `tds_temp_json`, `raw_base_data`, `next_geo_*`, `tds_release_par1/par2`, `active_geofences`) and Publisher locals (`par1/par2`, `return_value`, `tds_state_owner`). |
| Envelope handoff | **A**: Finaliser-staged local read by Publisher (no file) vs **B**: Finaliser-owned staging file read by Publisher (one-file `Itin-style`) | **A**: Finaliser-stage. Direct precedent: `tds_release_par1/par2` already survives across Tasker actions. No file ownership / single-writer risk (AGENTS.md); zero data migration. |
| Flush timing | (a) push+gen-check at each obs site, stage-to local after the event loop (before `publishCandidate`) vs (b) stage only at pass end | (a): accumulate inline (`observedReducerCommands` array), stage `tds_obs_batch_par1/par2` immediately after the loop (Finaliser.js:180). Obs complete by then; `publishCandidate` (:224) leaves `tds_obs_batch_*` untouched (different locals). |
| Merge point | Publisher serial branch (`:219-223`) vs a new Publisher entry / Finaliser-built envelope | Serial branch only: replaces the plain `RECONCILE_GENERATION` staging with a merged `REDUCER_BATCH`. Keeps the shim branch (`:212-218`) byte-identical (it already calls `reducer("RECONCILE_GENERATION")` synchronously); merge in shim mode would double-apply the shim-delivered observations. Shim branch adds only a `tds_obs_batch_par2` clear to consume stale staged obs. |
| **ADR: publisher-merge over third handoff slot** | Third Tasker handoff slot (D5 deferred option) vs publisher serial-branch merge (chosen) | **Publisher merge.** User decision 2026-08-08: a third Tasker task-loop slot doubles fleet wiring surface and violates the in-scope exclusion ("NO Tasker task-loop wiring"); the publisher already owns the post-publish reconcile as the natural merge seam. Byte-localized, two-file, zero data migration, reversible per proposal rollback. |
| Cap policy | All-or-nothing reject on > `MAX_REDUCER_BATCH_SIZE=32` vs keep-first-31 + structured drop | Keep-first-31 (one slot reserved for `RECONCILE_GENERATION`), drop excess with `OBS_BATCH_TRUNCATED`. FU1 reducer validate rejects > 32 wholesale (`commands exceeds MAX_REDUCER_BATCH_SIZE`) — publisher-side pre-cap prevents `BATCH_ENVELOPE_REJECTED` and protects reconcile. Order preserved (staging order = drop order). |

## Data Flow

```
Finaliser pass (one pass, serial model, reducer absent)
  COMPLETE_DROPIN site :143 ─┐  gen-check  ─► observedReducerCommands.push
  OBSERVE_ARRIVAL site :167 ─┤  (STATE_CMD_GEN_REGEX)
                              └─ after loop :180  setLocal tds_obs_batch_par1="OBSERVATION_BATCH"
                                                 setLocal tds_obs_batch_par2=JSON(only valid obs)
  publishCandidate :224 ─► par1 = candidate JSON   (primary-last; obs never touch par1)

Next Tasker action ─► Generation_Publisher.publish(candidate)
  genId = mintId() · publish master/itinerary/manifest · setGlobal TDS_Active_Generation
  serial branch (reducer absent) :
    obsList = JSON.parse(local('tds_obs_batch_par2')) || []
    obsList = obsList.map(o => { payload.generationId = genId; return o })   // re-stamp
    keep first 31 (drop excess → logEvent OBS_BATCH_TRUNCATED)
    commands = [ {command:"RECONCILE_GENERATION", payload:{generationId:genId, activeGeneration:genId, manifestSchemaVersion:2}}, ...obsList ]
    setLocal par1="REDUCER_BATCH"; setLocal par2=JSON({generationId:genId, commands})
    logEvent OBS_BATCH_MERGED (count) ; setLocal tds_obs_batch_par1="", tds_obs_batch_par2=""

Next Tasker action ─► TDS_State_Command.routeCommand("REDUCER_BATCH", envelope)
  validateCommand (envelope pre-check, size-guarded) ─► owner = Trip_State_Reducer
  serialMode staged-owner run ─► Trip_State_Reducer.applyBatch
    RECONCILE_GENERATION (align state to genId) THEN COMPLETE_DROPIN THEN OBSERVE_ARRIVAL
    logEvent REDUCER_BATCH_DELIVERED (count, applied, skipped:0)
```

No-observation parity (SCN-6F2-5): `tds_obs_batch_par2` empty → publisher stages plain `RECONCILE_GENERATION` byte-identical to current `:221-222`; clears the empty local. Shim-mode parity (E2-2, AC-5, testFinaliserCutover): reducer present → Finaliser shim-delivers each obs synchronously (existing path preserved); publisher shim branch unchanged apart from clearing the obs local; `par1` stays the candidate (primary-last — SCN-6FU-9). Release chain (:261-309) untouched.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `Finaliser.js` | Modify | Add `let observedReducerCommands = [];` (module scope near :44) + byte-copied `STATE_CMD_GEN_REGEX`. Replace `COMPLETE_DROPIN` raw staging (:143-156) and `observeArrival` (:51-58) with: gen-check → push `{command,payload}` to `observedReducerCommands` (invalid genId → `flash` `OBS_BATCH_FLUSH_SKIPPED`, not pushed) + shim-deliver (`reducer(cmd, payload)`) when reducer present. After the event loop (:180): if `observedReducerCommands.length > 0`, `setLocal('tds_obs_batch_par1','OBSERVATION_BATCH')` + `setLocal('tds_obs_batch_par2', JSON.stringify(observedReducerCommands))`. `publishCandidate` (:224) and release chain (:261-309) unchanged. |
| `Generation_Publisher.js` | Modify | Serial branch (:219-223): read `local('tds_obs_batch_par2')`; if present parse array, re-stamp each `payload.generationId = genId`, cap to first 31 (drop excess → `logEvent("warn","OBS_BATCH_TRUNCATED", genId, {dropped})`), build `commands = [RECONCILE_GENERATION entry, ...obs]`, `setLocal("par1","REDUCER_BATCH")`, `setLocal("par2", JSON.stringify({generationId:genId, commands}))`, `logEvent("info","OBS_BATCH_MERGED", genId, {count})`. Else plain `RECONCILE_GENERATION` byte-identical. Both branches clear `tds_obs_batch_par1/par2` (consume). |
| `harness/test_serial_finaliser_batch.js` | Create | Serial-mode proof mirroring `test_serial_batch.js`: serialMode-only (no shims), staged-owner routing after the router. See Testing Strategy. |
| `AGENTS.md` | Modify | Add `OBS_BATCH_FLUSH_SKIPPED`, `OBS_BATCH_TRUNCATED`, `OBS_BATCH_MERGED` to the required event codes list (Finaliser component code lives inline per existing log format: `timestamp/generationId/component/severity/code/tripId/details`). |

## Interfaces / Contracts

Dedicated local contract (Finaliser → Publisher):

```javascript
// Finaliser writes (after the event loop, only when ≥1 valid observation)
setLocal('tds_obs_batch_par1', 'OBSERVATION_BATCH');
setLocal('tds_obs_batch_par2', JSON.stringify([
  { command: "COMPLETE_DROPIN", payload: { generationId, dropinId, tripId, at } },
  { command: "OBSERVE_ARRIVAL", payload: { generationId, tripId, at, accuracyM } }
]));
// Generation_Publisher consumes; payload.generationId is re-stamped to the new genId.
// Entries conform to REDUCER_BATCH.commands[i] shape (TDS_State_Command validateCommand).
```

Constants copied byte-exact (Tasker scripts are standalone): `STATE_CMD_GEN_REGEX = /^gen:\d{10}:[0-9a-f]{4}$/` in Finaliser (mirrors TDS_State_Command.js:27 / Trip_State_Reducer.js:32 / Generation_Publisher.js:10 `GENERATION_ID_REGEX`); `MAX_REDUCER_BATCH_SIZE = 31` (effective obs cap, one of 32 reserved for reconcile) in Generation_Publisher.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Flush-skip on fallback genId; valid-obs accumulation; genId re-stamp; 31-obs cap drop; no-obs parity | Direct `runScript` of Finaliser + Generation_Publisher over fixture locals/globals/files. Assert `tds_obs_batch_par1/par2`, staged `par1`, flash codes (`OBS_BATCH_FLUSH_SKIPPED`, `OBS_BATCH_TRUNCATED`, `OBS_BATCH_MERGED`). |
| Integration | **SCN-6F2-7** serial-mode one-pass delivery proof | New `harness/test_serial_finaliser_batch.js`, mirrors `test_serial_batch.js`: `createSandbox({serialMode:true})`; route one Finaliser pass staging `COMPLETE_DROPIN` then `OBSERVE_ARRIVAL` then candidate; run `Generation_Publisher.js` (serial merge); `sandbox.stateCommand('REDUCER_BATCH', envelope)`. Assert: both observations applied to `TDS_Trip_State.json` in staging order, `par1` is the candidate JSON before the publisher run (primary-last), one `REDUCER_BATCH_DELIVERED` (count=3, skipped=0), no `BATCH_ENVELOPE_REJECTED`. Plus parity sections: no-obs pass stages plain `RECONCILE_GENERATION`; invalid-genId pass stages nothing (`OBS_BATCH_FLUSH_SKIPPED`), no envelope. |
| Regression | E2-2 (`test_single_writer.js:582` dropin), AC-5 (`test_ac5.js:415` release), `testFinaliserCutover` (`test_atomic_publication.js:321`) stay green | `node harness/test_*.js`. Shim-mode shim-delivery is preserved byte-identical; `par1` stays primary-last; `tds_obs_batch_*` does not collide with `tds_release_par1/par2`. |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The change reuses the existing TDS_State_Command router (already validated by FU1) and adds no new entry-point routing; the serial owner-staging contract (`tds_state_owner`) is produced by the existing router, not by this change.

## Migration / Rollout

No migration required. Two-file, byte-localized, zero data migration. Tasker task-loop wiring is unchanged (the next action already reads `par1` to run the publisher, which now stages `REDUCER_BATCH` instead of plain `RECONCILE_GENERATION`). Rollback per proposal: revert Finaliser staging to direct `setLocal`, Generation_Publisher to plain `RECONCILE_GENERATION`, delete the serial test, drop the three log codes from AGENTS.md.

## Open Questions

- [ ] Aggregator local persistence across Tasker task invocations on device (not just harness) — verified positive via the `tds_release_par1/par2` precedent running in production today, but a one-time manual device confirmation is recommended before archive.
- [ ] Whether `OBS_BATCH_FLUSH_SKIPPED` should list the `tripId` of each skipped observation (currently payload.generationId is the shared fallback; per-obs `tripId` is available in the payload and SHOULD be carried for diagnostics — tasks phase to confirm the `flash(...tripId...)` field is populated).