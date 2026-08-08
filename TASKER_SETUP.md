# Tasker Framework Setup — Tesla Scheduler

How to build the Tasker task loop around the Tesla scheduler scripts so the
serial handoff chain works on-device. This is the deployment companion to the
scripts in this repo. It does NOT change any script; it wires the framework.

> Environment: Tasker on Android, JavaScriptlet (JSlet) actions. No Node, no
> npm, no require/module.exports — scripts are standalone and communicate
> ONLY through Tasker locals/globals and the JSON data files.

---

## 1. File layout on the device

Copy the repo's production scripts to the device. Two trees:

| Path (device) | Content |
|---|---|
| `Tasker/Tesla/*.js` | All production scripts (Alpha, Compiler, Sandbox_Engine, Finaliser, Generation_Publisher, TDS_State_Command, Trip_State_Reducer, Override_Handler, Route_Cache_Manager, Gatekeeper, API_JSON_Build, API_Parser, Dispatcher, Dashboard, Appender, Override_Injector, Return_to_Base, Depart_Now, Unlock, Stop_Logger, TDS_Helper) |
| `Tasker/Tesla/Data/` | JSON data files (see §5 bootstrap) |

Every script is registered as a Tasker **JavaScriptlet** action whose *File*
points to the matching `Tasker/Tesla/<script>.js`. Do NOT paste code into the
action — always reference the file so the checked-in code is what runs.

Recommended JSlet action options: *Continue Task After Error* ON, *Local*
scope for `local()`, *Global* for `global()` (defaults). The scripts use
`flash()` for structured JSON logs — keep notifications enabled for
diagnostics.

---

## 2. The core concept: staged serial commands

Cross-script communication is entirely variable staging. Two locals carry the
"current command envelope":

| Local | Meaning |
|---|---|
| `%par1` | Command name (e.g. `REDUCER_BATCH`) or JSON payload (publish candidate) |
| `%par2` | JSON payload of the command |

The universal rule: **each task action consumes what the previous action
staged, and stages what the next action consumes.** Nothing else shares state
except the globals table (§3) and the JSON data files (§5, one writer each).

The router: **TDS_State_Command.js** reads `%par1`/`%par2` at entry, validates
against its exact command table, sets `%tds_state_owner`, and re-stages
`%par1`/`%par2` (with any re-minted ids) so the **next** task action runs the
owner script (Trip_State_Reducer / Override_Handler / Manual_Action_Handler /
Generation_Publisher). That is why every routed command needs exactly two
actions in the task: the router, then the owner.

---

## 3. Task action chain (the serial loop)

One task (or a chain of tasks) running these JSlet actions **in this order**
reproduces the harness `serialMode` behavior exactly. Each line lists the
action, what it consumes, and what it stages.

### 3.1 Planning pass (Compiler / Sandbox)

```
1. Alpha.js
   consumes: calendar/event inputs, %User_Loc, %User_At_Base, %TDS_Previous_Loc
   stages:   %tds_temp_json (event candidates), %raw_base_data
2. Compiler.js
   consumes: %tds_temp_json, committed master/itinerary (via TDS_Helper)
   stages:   %par1 = publish candidate JSON (its own publishCandidate),
             %block_queue = typed queue envelope {schemaVersion,rows,eof,...}
3. Sandbox_Engine.js
   consumes: %par1 candidate, %TDS_Active_Generation, reducer observations
   stages:   %par1 = REDUCER_BATCH / %par2 = {generationId, commands:[...]}
             (flush BEFORE %block_queue emit — never at a halt site),
             %block_queue = typed queue envelope for Tasker to act on
4. TDS_State_Command.js
   consumes: %par1/%par2 (the batch envelope)
   stages:   %tds_state_owner = Trip_State_Reducer, re-staged %par1/%par2
5. Trip_State_Reducer.js
   consumes: %par1/%par2; applies the batch (single commit + project)
   writes:   Tasker/Tesla/Data/TDS_Trip_State.json (sole writer)
   stages:   %TDS_Manual_Return_Completed projection (Phase 6)
```

Tasker may read `%block_queue` after action 3 to flash notifications or
enable/disable blocking actions (it is a local, never processed by Tasker's
Variable Split).

### 3.2 Publication pass (Finaliser)

```
1. Finaliser.js
   consumes: %tds_temp_json, %raw_base_data, %User_Loc, %User_At_Base,
             %TDS_Previous_Loc, %TDS_Active_Generation, %AdHoc_Base
   stages:   %par1 = publish candidate JSON            (primary-last, mid-chain rule)
             %tds_obs_batch_par1 = OBSERVATION_BATCH   (only when valid observations)
             %tds_obs_batch_par2 = JSON [{command,payload}, ...] (COMPLETE_DROPIN/OBSERVE_ARRIVAL)
             %tds_release_par1/%tds_release_par2 = RELEASE or SESSION_CLOSE (only when an ACTIVE session exists)
             %next_geo_coords, %next_geo_title, %active_geofences
   writes:   Tasker/Tesla/Data/TDS_Base_Geocodes.txt (when changed)
2. Generation_Publisher.js
   consumes: %par1 (candidate), %tds_obs_batch_par2 (observations)
   writes:   TDS_Run_Manifest.json, TDS_Master.*, Itin_Master.* (sole publisher)
   stages:   %TDS_Active_Generation = new genId (global)
             %par1 = REDUCER_BATCH or RECONCILE_GENERATION
             %par2 = the merged envelope [RECONCILE_GENERATION, ...obs]
                     (observations re-stamped to the new genId; 31-obs cap)
             clears %tds_obs_batch_par1/%tds_obs_batch_par2 (consume)
3. TDS_State_Command.js
   consumes: %par1/%par2 (the post-publish envelope)
   stages:   %tds_state_owner, re-staged %par1/%par2
4. Trip_State_Reducer.js
   consumes: %par1/%par2; applies RECONCILE_GENERATION then every observation
             in order; logs REDUCER_BATCH_DELIVERED (count, applied, skipped)
5. Release consumption (ONLY if %tds_release_par1 is set):
   a. Variable Set: %par1 = %tds_release_par1
   b. Variable Set: %par2 = %tds_release_par2
   c. TDS_State_Command.js  → routes RELEASE/SESSION_CLOSE
   d. Manual_Action_Handler (via the router's owner staging in TDS_State_Command)
   e. Variable Set: %tds_release_par1 = (empty), %tds_release_par2 = (empty)
```

Do NOT reorder: `%par1` must stay the publish candidate through step 1–2
(SCN-6FU-9); observations ride the dedicated locals, never `%par1`.

### 3.3 Manual action adapters (each is a separate entry task)

| Adapter | Stages (%par1 / %par2) | Router owner |
|---|---|---|
| Depart_Now.js | `DEPART_NOW` (+ batch observations via REDUCER_BATCH) | Trip_State_Reducer |
| Return_to_Base.js | `RETURN_TO_BASE` (policy + metrics) | Trip_State_Reducer (+ SESSION_OPEN staged) |
| Unlock.js | `RELEASE` (only when TDS_Manual_Return_Completed) | Manual_Action_Handler |
| Stop_Logger.js | `COMPLETE_STOP` | Trip_State_Reducer |
| Appender.js / Override_Injector.js | typed command adapters | — |

Each manual task is: JSlet(adapter) → TDS_State_Command.js → owner script.
The adapters never write data files — they only stage commands.

### 3.4 API chain (route requests / responses)

```
Gatekeeper.js → API_JSON_Build.js (stamps correlation {generationId,clusterId,
requestId} via REQUEST_STATE_REGISTER, never leaks into the wire payload)
  → HTTP request action (Tasker) → response → API_Parser.js
API_Parser.js consumes the {correlation, response} callback envelope; stale or
raw responses are discarded (STALE_API_RESPONSE_DISCARDED); cache writes go
through Route_Cache_Manager only.
```

---

## 4. Variables

### 4.1 Globals

| Global | Set by | Read by | Notes |
|---|---|---|---|
| `%TDS_Active_Generation` | Generation_Publisher | Finaliser, Sandbox, Compiler, Gatekeeper, API builder, adapters | genId `gen:<unix10>:<hex4>`; must never be the fallback |
| `%User_At_Base` | Tasker (location profile) | Finaliser, Compiler, Sandbox, Dispatcher | `true`/`false` |
| `%User_Loc` | Tasker (location) | Finaliser, Sandbox, Dispatcher, Dashboard | `lat,lon` |
| `%TDS_Previous_Loc` | Tasker (previous location) | Finaliser (spatial departure/arrival) | `lat,lon` |
| `%AdHoc_Base` | Tasker/user | Finaliser | optional ad-hoc base, `lat,lon` |
| `%TDS_Manual_Return_Completed` | Trip_State_Reducer (projection) | Unlock, Finaliser (release decision) | set on successful COMPLETE_TRIP |

### 4.2 Handoff locals (per task scope — MUST survive action boundaries)

| Local | Written by | Consumed by |
|---|---|---|
| `%par1`, `%par2` | every stager | next action (router or owner) |
| `%tds_state_owner` | TDS_State_Command | task flow (which owner runs next) |
| `%tds_obs_batch_par1/par2` | Finaliser | Generation_Publisher (merge + clear) |
| `%tds_release_par1/par2` | Finaliser | release consumption (copy to %par1/%par2) |
| `%block_queue` | Compiler, Sandbox | Tasker (notifications/blocking) |
| `%tds_temp_json`, `%raw_base_data` | Alpha | Compiler/Finaliser |
| `%next_geo_coords`, `%next_geo_title`, `%active_geofences` | Finaliser | Tasker geofence/profile logic |
| `%return_value` | every script | diagnostics |
| `%tds_consume_par1/par2` | API_Parser mid-chain save/restore | staged cache commands |

Tasker limitation: locals set by one JSlet action are visible to the next
action of the same task (same task scope). Keep the whole chain in ONE task
(or chain tasks with the same scope) — this is exactly what the
`tds_release_par1/par2` and `tds_obs_batch_par1/par2` persistence check
verifies on-device (§8).

---

## 5. Data bootstrap (Tasker/Tesla/Data/)

Create before first run:

| File | Initial content | Sole writer |
|---|---|---|
| `TDS_Run_Manifest.json` | `{"schemaVersion":1,"activeGeneration":null,"manifestSchemaVersion":2}` | Generation_Publisher |
| `TDS_Master.json` | `[]` | Generation_Publisher |
| `Itin_Master.json` | `[]` | Generation_Publisher |
| `TDS_Trip_State.json` | `{"schemaVersion":1,"revision":0,"generationId":"","currentOrigin":"PLANNED","currentPlanningDay":"","userAtBase":false,"baseArrivalUnix":null,"latenessHalt":false,"currentStatus":"","manualReturnCompleted":false,"trips":{},"stops":{},"completedDropins":{},"manualSessions":{}}` | Trip_State_Reducer |
| `TDS_Overrides.json` | `{"schemaVersion":2,"eventOverrides":{},"seriesPreferences":{}}` | Override_Handler |
| `TDS_Routine_Preferences.json` | `{"schemaVersion":2,"seriesPreferences":{}}` | Override_Handler |
| `TDS_Action_Sessions.json` | `{"schemaVersion":1,"sessions":{}}` | Manual_Action_Handler (TDS_State_Command) |
| `TDS_Manual_Trips.json` | `{"schemaVersion":1,"trips":{}}` | Manual_Action_Handler |
| `TDS_Action_Lock.json` | `{}` | Manual_Action_Handler (legacy projection) |
| `TDS_Reorder_Commands.json` | `[]` | TDS_State_Command enqueues; Generation_Publisher drains/clears |
| `TDS_Route_Cache.json`, `TDS_Order_Cache.json` (+ `.txt` projections, `Temp_Route_Cache.txt`) | `{}` / `[]` | Route_Cache_Manager |
| `TDS_Request_State.json` | `{}` | Route_Cache_Manager (REQUEST_STATE_*) |
| `TDS_Base_Geocodes.txt` | empty | Finaliser |

Never hand-edit these after first run — the single-writer contract applies.
When in doubt, DELETE the file and let the owner recreate it.

---

## 6. Triggers / profiles (device-specific)

The scheduler has no built-in clock; Tasker profiles drive passes:

| Profile | Purpose |
|---|---|
| Time profile (e.g. 04:00 daily) | Planning pass: Alpha → Compiler → Sandbox chain (§3.1) |
| Location change / base enter-leave | Publication pass: Finaliser chain (§3.2); sets %User_At_Base/%User_Loc/%TDS_Previous_Loc BEFORE the chain |
| Manual task shortcuts (home screen / notification) | Depart_Now, Return_to_Base, Unlock, Stop_Logger (§3.3) |
| HTTP response received | API_Parser callback (§3.4) |

Set the location globals (and `%TDS_Previous_Loc` = the previous reading)
before invoking Finaliser — its spatial departure/arrival logic depends on
both current and previous coordinates.

---

## 7. Operational rules (from AGENTS.md, enforced by the loop)

1. **One writer per resource** — the tables in §5 are absolute. A script
   caught writing another owner's file is a bug.
2. **Mid-chain rule** — during publication, `%par1` stays the publish
   candidate until Generation_Publisher consumes it; the release chain and
   observation batch ride dedicated locals.
3. **No zero-duration legs, no unbounded conditions, no negative-gap loops** —
   the scripts enforce these; the framework must NOT add polling loops that
   re-run a pass on a past departure (idle sync is the fallback).
4. **Structured logs** — every rejection/significant transition flashes JSON
   with `timestamp, generationId, component, severity, code, tripId, details`.
   Required codes: `REDUCER_BATCH_DELIVERED`, `BATCH_ENVELOPE_REJECTED`,
   `BATCH_SUBCOMMAND_REJECTED`, `OBS_BATCH_FLUSH_SKIPPED`,
   `OBS_BATCH_TRUNCATED`, `OBS_BATCH_MERGED`, `STALE_API_RESPONSE_DISCARDED`,
   `GENERATION_VALIDATION_FAILED`, `FUTURE_TRIP_NOT_DUE`, and the rest of the
   AGENTS.md list.
5. **JSlet error containment** — with Continue Task After Error ON, a crash
   flashes `JS Crash: <message>`; the task continues to the next action.
   Check the flash log and `%return_value` when diagnosing.

---

## 8. First-run verification (on-device checklist)

Before trusting the loop in production, run the smoke sequence:

1. **Bootstrap** (§5) and copy scripts (§1); set the globals (§4.1).
2. **Planning pass smoke**: trigger the time profile. Verify `%par1` ends as
   `REDUCER_BATCH` (or `RECONCILE_GENERATION` with no observations), the
   reducer ran (TDS_Trip_State.json `revision` bumped), and
   `REDUCER_BATCH_DELIVERED` flashed with applied counts.
3. **Publication pass smoke** (the tds_obs_batch persistence check):
   a. After the Finaliser action (before Publisher): `%tds_obs_batch_par1`
      must read `OBSERVATION_BATCH` and `%tds_obs_batch_par2` the JSON array
      — the locals MUST survive the action boundary.
   b. After Generation_Publisher: both locals cleared, `%par1` =
      `REDUCER_BATCH`, `%TDS_Active_Generation` updated.
   c. After the router+reducer: `completedDropins.<id>` /
      `trips.<id>.observedArrivalUnix` in TDS_Trip_State.json,
      `REDUCER_BATCH_DELIVERED` count=3 applied=3 skipped=0.
   d. Negative: with `%TDS_Active_Generation` empty, an observation pass
      flashes `OBS_BATCH_FLUSH_SKIPPED` (with tripId) and stages no envelope.
4. **Release smoke**: with an ACTIVE session, after the Finaliser pass
   `%tds_release_par1` = `RELEASE` (or `SESSION_CLOSE`); after the release
   consumption actions the session/lock state clears and `%tds_release_*`
   are empty.
5. **Manual action smoke**: Depart_Now/Return_to_Base/Unlock/Stop_Logger each
   route through TDS_State_Command to the right owner (watch
   `STATE_COMMAND_ROUTED` + `%tds_state_owner`).

If step 3a fails (locals empty between actions), the staged-locals mechanism
is broken on-device: report back — the migration's whole premise is that
`tds_release_*`-style locals persist across actions in one task scope.

---

## 9. What this plan deliberately does NOT do

- No third handoff slot / no task-loop rewiring for the observation batch
  (D5 decision: the Publisher merge rides the existing action order).
- No new triggers, no alarm/notification UI — device-specific concerns are
  left to the Tasker setup; the scripts only stage `%block_queue` and flash
  structured logs.
- No polling: passes fire on profiles, never on tight loops.
