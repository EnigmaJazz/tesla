# Exploration: Port slice-3/4 ID-parsing + override single-writer onto current master

**Change:** `tasker-tesla-followup-id-override-port`
**Date:** 2026-08-02
**Status:** Complete — ready for proposal

---

## 1. Current master state

### 1.1 TDS_Overrides.json writers on master (7 production writers)

| # | Script | Read/Write sites (master line numbers) | What it writes |
|---|--------|----------------------------------------|----------------|
| 1 | `Alpha.js` | filePath `:65`, prune `:378-431`, `writeFile` `:430` | Trimmed_Events, Skipped_*, Forced_*, Ignored_*, Depart_Memory, Completed_Dropins, Arrival_Memory |
| 2 | `Appender.js` | filePath `:32`, `writeFile` `:133` | Forced_*/Skipped_*/Trimmed_Events, Route_Defaults/Route_History |
| 3 | `Compiler.js` | read `:311`, `OVR['Depart_Memory']` `:317`, write `:480`, `writeFile` `:483` | Depart_Memory |
| 4 | `Default.js` | filePath `:14`, `writeFile` `:96` | Route_Defaults/Route_History |
| 5 | `Finaliser.js` | read `:91`, `mem['Completed_Dropins']` `:93`, `mem['Arrival_Memory']` `:94`, write `:165-166`, `writeFile` `:167` | Completed_Dropins, Arrival_Memory |
| 6 | `Override_Injector.js` | read `:28`, `writeFile` `:142` | override arrays + Route_Defaults/Route_History |
| 7 | `Stop_Logger.js` | filePath `:25`, `OVR['Completed_Stops']` `:29`, write `:42`, `writeFile` `:43` | Completed_Stops |

**Confirmed:** all 7 writers match the change brief. `TDS_Routine_Preferences.json` does **not exist anywhere on master** — no file, no references (grep across `*.js` returned zero hits). The spec already mandates it (§8 RULE-8C), but no code implements it yet.

### 1.2 Forbidden ID-parsing / membership patterns on master

| Site | Pattern | Line |
|------|---------|------|
| `Appender.js` | `baseId.split("_")[0]` | `:90` |
| `Override_Injector.js` | `targetId.split("_")[0]` | `:100` |
| `Sandbox_Engine.js` | `evId.split("_")[0]` | `:1026` |
| `Sandbox_Engine.js` | 10× `indexOf(evId)` membership checks | `:1031-1050` (e.g. `:1031`, `:1034`, `:1038`, `:1050`) |
| `Override_Injector.js` | `valArr.indexOf(targetId)` membership | `:61`, `:65` |
| `Appender.js` | `storedKey.indexOf(routineKey) === 0` (key prefix, not event-ID substring — see note) | `:105` |

Note: `Route_Defaults`/`Route_History` entries use routine-key prefix matching (`coreId^origin^dest^MOD`) via `indexOf(prefix) === 0`. This is a **key-prefix** match, not the forbidden `indexOf(eventId)` membership the OVR-10 rule targets; the branch preserved the same prefix style in `applyCategorizedHistory`. Flag for design confirmation, do not treat as a hard-rule violation by default.

### 1.3 Master architecture the port must fit into

- **Phase 2 (merged):** `Generation_Publisher.js` reads `local("par1")` = candidate JSON (`CANDIDATE = local("par1")`), writes versioned `Itin_Master.<gen>.json` etc. + `TDS_Run_Manifest.json`. `TDS_Helper.js` is read-only with `readActiveGeneration(kind)` manifest resolver incl. legacy fallback. `Compiler.js` and `Finaliser.js` call `publishCandidate(...)` → `setLocal('par1', JSON.stringify(candidate))` then a Tasker action runs the publisher (mock: `publish(candidate)` helper).
- **Phase 3 (merged):** `Trip_State_Reducer.js` reads `local("par1")` = command, `local("par2")` = payload, `local("par3")` = context; writes `TDS_Trip_State.json` (RULE-8B). `Stop_Logger.js` **already stages `COMPLETE_STOP`** via `setLocal('par1', ...)` + `reducer(...)` helper — and *keeps* the legacy `Completed_Stops` OVR write at `:42-43` as a "read-side shim" (comment at `:45`: "remains as a read-side shim pending migration"). The reducer already has `SET_OVERRIDE`/`REMOVE_OVERRIDE` **stub commands** (`stubApply`, no-op) and a `state.overrides` map used by `test_reconcile.js:168` — these are reducer-state overrides, a *different* resource from `TDS_Overrides.json`. The port must not confuse them.
- **Cross-script comms:** `setLocal`/`setGlobal` staging + next Tasker action reads the staged value. **No `require`/`import`/`module.exports` in production scripts** (AGENTS.md). Helpers like `readActiveGeneration` and `readOrigin` are **inlined per-consumer** (Phase 3 PR-E pattern: Sandbox/Dispatcher/Dashboard each carry local copies). The branch's `ID_Parser.js` docstring says the same: "each consumer inlines a copy" — the canonical file exists for the harness/tests only.
- **Harness:** `harness/mock_tasker.js` has `writeFile` guard for `PHASE3_STATE_PATH` only (`:95-96`, `UNAUTHORIZED_WRITE_REJECTED`), `reducer()`/`publish()` helpers (`:57-69`) that stage `par1/par2/par3` and `runScript`, plus `writeThrows`/torn-writes injection and `writeLog`/`writeOrder` observability. `harness/runner.js` does `vm.createContext(sandbox)` per run — so a test that `loadHandler(sandbox)` first (vm.runInContext the handler into the same sandbox object) then `runScript(adapter, sandbox, ...)` makes `Override_Handler` visible to the adapter, exactly like the branch's `test_single_writer.js`/`test_id_parsing.js` do. Master has 15 tests; branch has 16 (adds `test_id_parsing.js`, `test_single_writer.js`, plus strand-specific ones).

### 1.4 Stranded slice-3/4 behavior vs master

Master spec header (§status) still says "Remaining Phase 0 (AC-5), sub-items 0B and 0E … open" and does **not** list 0G. Verified on master:
- **0G (zero-duration) is NOT stranded** — already merged: `Compiler.js:415-426` emits `ZERO_DURATION_LEG_REJECTED`; `Sandbox_Engine` exports `block_step17/18/19`; `test_atomic_publication.js:766` covers it.
- **AC-3/AC-5/AC-7 completion, synthetic-return suppression, manual-return gate** — the branch tests (`test_ac3_sandbox.js`, `test_ac5.js`, `test_synthetic_return.js`) are **not** on master. These are separate stranded slice-3/4 behaviors **outside this change's scope** (see §5).

---

## 2. Branch implementations — key semantics worth porting

### 2.1 `ID_Parser.js` (branch tip, canonical)

- `parseOccurrenceId(rawId)` with strict regex `^([0-9a-zA-Z_]+)_([0-9a-zA-Z]+)$` — **core may contain underscores** (Google Calendar IDs can), suffix must be pure base-36 chars. Splits at the **last** `_` implicitly (suffix charset excludes `_`), which is the `lastIndexOf("_")` rule.
- Suffix validation: `parseInt(suffix, 36)` must be **≥ 1e9 and < 2.5e9** (`ID_SUFFIX_MIN_UNIX`, `ID_SUFFIX_MAX_UNIX`). Fixture `abc123_kx8f00` → suffix `kx8f00` = 1265143536 ✓.
- Rejection reasons: `empty_id`, `malformed_format` (regex fail), `invalid_suffix` (parse fail or out of range).
- Logging: structured JSON flash with `timestamp`, `generationId: null`, `component`, `severity: "WARN"`, `code: "ID_PARSE_REJECTED"`, `tripId: null`, `details: { rawId, reason }` — matches AGENTS.md logging contract.
- Returns `{ ok: true, coreId, instanceStartUnix }` or `{ ok: false, reason }`. Consumers **inline a copy**; canonical file for harness reference only.
- Commit `3ed5c45` diff for `Sandbox_Engine.js:1004-1043` shows the inlined shape: constants + `lastIndexOf("_")` + suffix parse + `continue` on reject (flash then skip the event).

### 2.2 `Override_Handler.js` (branch tip, v2.0)

- **Sole writer** of `TDS_Overrides.json` (`OVR_FILE`) and `TDS_Routine_Preferences.json` (`PREFS_FILE`).
- **Serial `run(command)` API** (replaces the older direct-file adapters). Commands: `APPLY_OVERRIDE`, `APPEND_OVERRIDE`, `SET_DEFAULT`, `PRUNE`. Adapters build a typed command object and call `Override_Handler.run({...})`; branch adapters guard with `typeof Override_Handler === "undefined" || !Override_Handler.run` → throw "Override_Handler not available".
- `prune(nowSec, whitelistMap)` thin wrapper around the PRUNE command for `Alpha.js`.
- **Exact-key maps**: `exactKeyRemove(entries, key)` uses object-map membership (`hasOwnProperty`) for wipes, never substring `indexOf`. `categorizedWipe` handles category-aware history wipes.
- **`TDS_Routine_Preferences.json` migration**: `migrateLegacyPreferences()` copies `Route_Defaults`/`Route_History` from OVR → PREFS once; `writeOverrides()` **deletes** `Route_Defaults`/`Route_History` keys from OVR before writing; `writePrefs()` ensures both keys exist in PREFS. This is the RULE-8C split the master spec already mandates.
- `applyCategorizedHistory` (streak counting, `count === 3` → `setLocal('propose_default', histKey)`) — preserves Appender/Injector/Default semantics.
- `commandPrune`: prunes the 12 file arrays + **3 global arrays** — `Depart_Memory` → `TDS_Depart_Memory`, `Completed_Dropins` → `TDS_Completed_Dropins`, `Arrival_Memory` → `TDS_Arrival_Memory` (ephemeral globals, per spec §8 "remain ephemeral globals pending Phase 3 migration"). Note `Completed_Stops` is **not** pruned by the handler on the branch — it lives in `TDS_Completed_Stops` global, written by Stop_Logger.
- Logging: structured JSON with `timestamp`, `generationId`, `component`, `severity`, `code`, `tripId`, `details`; uses `DEPARTURE_POLICY_FALLBACK_USED` etc. where relevant.
- Commit `c2934eb` is the *earlier* incremental step (splits prefs + adds handler scaffolding, consumers still write directly). The **branch tip** is the full consolidation: consumers (Override_Injector, Appender, Default, Alpha, Stop_Logger) become **command adapters only**.

### 2.3 Branch adapter wiring

- `Override_Injector.js` (branch tip): reads `Itin_Master.json` (legacy) for `targetId` lookup, then `Override_Handler.run({ op: "APPLY_OVERRIDE" ... })`; sets `ui_return_msg`, `do_engine_rerun`. No direct `writeFile`.
- `Appender.js` (branch tip): builds `APPEND_OVERRIDE`/`SET_DEFAULT` commands with `parseOccurrenceId`-validated `coreId`; streak logic lives in the handler's `applyCategorizedHistory`.
- `Default.js` (branch tip): `SET_DEFAULT` command adapter.
- `Alpha.js` (branch tip): prune becomes `Override_Handler.prune(nowSec, whitelistMap)`; the 15-array inline prune loop moves into the handler.
- `Stop_Logger.js` (branch tip): writes `TDS_Completed_Stops` global instead of OVR (`setGlobal`), keeps `reducer(...)` staging. **On master, COMPLETE_STOP staging already exists** — the port only replaces the OVR shim write with the global write.

---

## 3. Adaptation plan outline (branch → master architecture)

### 3.1 ID parsing port

1. Add canonical `ID_Parser.js` (branch file as-is) for harness reference — mirrors how `TDS_Helper.js` is read-only/canonical.
2. **Inline** `parseOccurrenceId` copies (per the established inline-helper pattern) into:
   - `Sandbox_Engine.js:1026` — replace `evId.split("_")[0]`; reject → flash `ID_PARSE_REJECTED` + `continue`.
   - `Override_Injector.js:100` — replace `targetId.split("_")[0]`.
   - `Appender.js:90` — replace `baseId.split("_")[0]`.
   - `Override_Handler.js` (new) — for its own prune/wipe logic.
   - `Alpha.js` prune loop — replace the back-to-front `split("_")` scan (`:406-416`) with the strict parser (or move wholesale into the handler, see 3.2).
3. Fix the **exact-key membership** sites: `Override_Injector.js:61/65` (`indexOf(targetId)`) and `Appender.js` wipe logic → exact-key maps in the handler (`exactKeyRemove`/`categorizedWipe`). The 10 `indexOf(evId)` checks in `Sandbox_Engine.js` are **pre-existing OVR-10 violations** — flag; do not expand scope to rewrite the Sandbox membership model in this change (see §5).

### 3.2 Override single-writer port

1. Add `Override_Handler.js` (port of branch tip v2.0) as the **sole writer** of `TDS_Overrides.json` + `TDS_Routine_Preferences.json`.
2. **Entry-point shape must match master conventions**: like `Trip_State_Reducer`/`Generation_Publisher`, the handler script top-level reads staged locals (e.g. `local("par1")` = command JSON, or a dedicated local) and dispatches to the internal `run(command)`; adapters stage via `setLocal` and/or call an injected `handler()` helper in the harness (mirroring `reducer()`/`publish()` in `mock_tasker`). The branch's design.md already described `setLocal('tds_override_command', JSON.stringify(command))` staging — the port should implement that production wiring rather than rely on in-scope function calls that only work in the harness.
3. Convert the 7 writers to **command adapters** (no direct `writeFile`):
   - `Override_Injector.js` — `APPLY_OVERRIDE`/`APPEND_OVERRIDE` + `SET_DEFAULT`; drop `writeFile` `:142`.
   - `Appender.js` — `APPEND_OVERRIDE`/`SET_DEFAULT`; drop `writeFile` `:133`.
   - `Default.js` — `SET_DEFAULT`; drop `writeFile` `:96`.
   - `Alpha.js` — `Override_Handler.prune(nowSec, whitelistMap)`; drop the 15-array prune + `writeFile` `:430`; migrate `Depart_Memory`/`Completed_Dropins`/`Arrival_Memory` to globals (`TDS_Depart_Memory`, `TDS_Completed_Dropins`, `TDS_Arrival_Memory`).
   - `Stop_Logger.js` — replace OVR `Completed_Stops` write (`:42-43`) with `setGlobal('TDS_Completed_Stops', ...)`; **keep** the existing `COMPLETE_STOP` reducer staging (already on master).
   - `Compiler.js` — replace `OVR['Depart_Memory']` read `:317`/write `:480` with `global('TDS_Depart_Memory')`/`setGlobal`; keep `publishCandidate`.
   - `Finaliser.js` — replace `mem['Completed_Dropins']`/`mem['Arrival_Memory']` read `:93-94`/write `:165-166` with globals; keep reducer delegation for location-state transitions.
4. **Reader compatibility** (must stay working, all read-only):
   - `Sandbox_Engine.js:18` `getOvr('Completed_Stops')` → `global('TDS_Completed_Stops')`; `:1029` `getOvr('Route_Defaults')` → read PREFS (`Route_Defaults` now lives in `TDS_Routine_Preferences.json`). The branch added a `getRoutinePref()` read helper; port it inline.
   - `TDS_Helper.js` — remains read-only manifest resolver; **no** setter added (AGENTS.md).
5. **Single-writer enforcement in harness**: extend `mock_tasker.js` `writeFile` guard to reject non-handler writes to `TDS_Overrides.json` + `TDS_Routine_Preferences.json` (mirror the `PHASE3_STATE_PATH` guard at `:95-96`, keyed off `__currentScriptPath` = `OVERRIDE_HANDLER_PATH`). Add a `handler(command)` helper next to `reducer()`/`publish()`.
6. **Spec status line**: master spec §header still lists Phase 0 open items; update only the lines this change actually closes (ID-2 evidence, RULE-8C table already present — no schema changes needed; §8's "Depart_Memory… remain ephemeral globals pending Phase 3 migration" already matches the branch globals). The spec is *already* ahead of the code here; this port makes code match spec.

### 3.3 TDS_Routine_Preferences.json lifecycle

- New file, seed `{"Route_Defaults": "", "Route_History": ""}` (branch `writePrefs` shape).
- One-time migration: on first handler run, copy `Route_Defaults`/`Route_History` from `TDS_Overrides.json` into PREFS and delete from OVR (`migrateLegacyPreferences`), so Sandbox's `Route_Defaults` read continues to work through the new PREFS path.

---

## 4. Reuse assessment — branch harness tests

### 4.1 `harness/test_id_parsing.js` (branch) — HIGH reuse

- Fixtures `VALID_ID abc123_kx8f00`, `NO_UNDERSCORE abcdef`, `INVALID_SUFFIX abc_xyz`, `TRAILING_GARBAGE abc123_kx8f00!`, `EMPTY_CORE _kx8f00`, `SUBSTRING_DECOY xyzabc123_kx8f00` are architecture-independent — reuse verbatim. `kx8f00` base-36 = 1265143536 ∈ [1e9, 2.5e9) ✓.
- Loads `ID_Parser.js`/`Override_Handler.js` into the sandbox via `loadHandler(sandbox)` then runs consumers — works with master's `runner.js` unchanged (same `vm.createContext(sandbox)` pattern).
- **Rewrite needed:** branch-era fixtures seeded `Itin_Master.json`/`TDS_Master.json` directly. On master, `Override_Injector.js:16` still reads legacy `Itin_Master.json` — *keep that read* (it's the injector's current input) OR switch the injector to `readActiveGeneration('itinerary')` and seed the manifest. **Recommendation: switch injector to the manifest resolver** (Phase-2 consistency) and adapt the test to seed `TDS_Run_Manifest.json` + versioned files, matching `test_atomic_publication.js` fixture style.
- Assert rejection flash payload shape (`code: "ID_PARSE_REJECTED"`, `details.reason`) — keep; extend to assert `lastIndexOf` split on IDs with underscore in core (e.g. `google_abc123_kx8f00`).

### 4.2 `harness/test_single_writer.js` (branch) — MEDIUM reuse

- Core assertion (only the handler may mutate `TDS_Overrides.json` + `TDS_Routine_Preferences.json`; the 7 consumers never write) is exactly what the port needs.
- Branch version ran each adapter against seeded OVR/PREFS/ITIN/MASTER and compared bytes. **Rewrite needed for master:**
  - Master's mock already has `writeLog`/`writeOrder` and a `writeFile` guard — assert via `UNAUTHORIZED_WRITE_REJECTED` (guard) instead of byte-compare, plus `writeLog` that only `Override_Handler.js` wrote the two files.
  - Must include the reducer-staging interaction (`Stop_Logger` still stages `COMPLETE_STOP`; `test_reconcile.js` pattern shows `runCmd` helper).
  - Must cover the **global arrays** (`TDS_Depart_Memory`, `TDS_Completed_Stops`, `TDS_Completed_Dropins`, `TDS_Arrival_Memory`) and PREFS migration.
  - Master's mock has failure injection (`writeThrows`/torn writes) the branch-era mock lacked — reuse for a torn-write test on the handler.
- Keep the `loadHandler` + adapter-sweep structure; extend with the new guards.

---

## 5. Scope boundary and entanglement

**In scope (this change):**
- ID parsing remediation at the 3 split sites + exact-key wipes in Override_Injector/Appender; canonical `ID_Parser.js`.
- Override single-writer consolidation: new `Override_Handler.js`, 7→1 writers, `TDS_Routine_Preferences.json` + migration, ephemeral globals for the 4 arrays.
- Harness: `handler()` helper + OVR/PREFS write guard; port/rework the two branch tests.
- Spec status line only (no new requirements — master spec §2 ID-2, §8 RULE-8C, §10 OVR-10 already describe this).

**Out of scope — entangled on the same branches, do NOT port here:**
- **AC-3/AC-5/AC-7 completion, synthetic-return suppression, manual-return gate** (`test_ac3_sandbox.js`, `test_ac5.js`, `test_synthetic_return.js` on the branch). These touch `Sandbox_Engine.js` (return-to-base/manual-return regions) — *same file* as the ID-parse site `:1026`, so the apply will touch overlapping files, but the behaviors are **separable** (different code regions, different spec sections). Flag as a follow-up change; do not pull into this port.
- **0G zero-duration** — already on master (`ZERO_DURATION_LEG_REJECTED` in Compiler); branch's `test_api_zero_duration.js`/`test_compiler_block17_18.js`/`test_dispatcher_block18.js` are already covered by `test_atomic_publication.js`. Not stranded, not in scope.
- The 10 `indexOf(evId)` membership checks in `Sandbox_Engine.js` (`:1031-1050`): pre-existing OVR-10 violations, **pre-date** this change's target sites. Fixing them means reworking Sandbox's override-membership model (routine-default auto-apply) — larger blast radius. **Recommendation:** flag as a separate OVR-10 cleanup; keep this change focused on the 3 split sites + override-file writers. (The branch did the same — its Sandbox diff only replaced the split, not the membership checks.)
- `Override_Injector.js:16` legacy `Itin_Master.json` read: fixing to `readActiveGeneration('itinerary')` is **in scope** (the injector is being converted to an adapter anyway and Phase-2 consistency requires it) — but it is a behavior-adjacent change; call it out explicitly in the proposal.

---

## 6. Open questions / risks

1. **Injector input source:** switch `Override_Injector` to `readActiveGeneration('itinerary')` (manifest) or keep the legacy read? Recommendation: switch (Phase-2 consistency); flag in proposal since it changes the injector's data source.
2. **Handler entry protocol:** `local('par1')` JSON-command staging (reducer-style) vs. a dedicated `tds_override_command` local (branch design.md style). Reducer-style (`par1` + `handler()` helper) is most consistent with master; confirm in design.
3. **Sandbox Route_Defaults read:** moving `Route_Defaults` to PREFS requires Sandbox's read (`:1029`) and the `notifQueue` auto-apply flow (`TDS_CLEAR_DEFAULT`) to read PREFS — make sure the `TDS_CLEAR_DEFAULT`/manual-action adapters (`Return_to_Base.js` etc.) don't depend on OVR `Route_Defaults` lingering. (Checked: Return_to_Base/Depart_Now/Unlock are command adapters, no OVR writes.)
4. **Completed_Stops:** master's `Stop_Logger` writes OVR `Completed_Stops` as a shim *and* stages `COMPLETE_STOP` to the reducer. The port replaces the OVR write with `TDS_Completed_Stops` global — confirm `Sandbox_Engine:18` and `getRemainingStops` (`:1047`) read the global, and that nothing else reads OVR `Completed_Stops`.
5. **Reducer `SET_OVERRIDE` stubs** (no-op) and `state.overrides` (used by `test_reconcile`): these are reducer-state overrides, **separate** from `TDS_Overrides.json`. The Override Handler is the file owner; the reducer stubs are out of scope. Do not conflate in tests or design.
6. **Harness guard ordering:** adding the OVR/PREFS `writeFile` guard will break any existing master test that still writes those files through a consumer — run the full 15-test suite after the guard lands; expect only the two ported tests to exercise the guard.
7. **`indexOf` prefix vs substring:** confirm with the user/spec that routine-key prefix matching (`storedKey.indexOf(routineKey) === 0`) stays allowed (it is a key-prefix lookup, not an event-ID membership check).
8. **Alpha prune date logic:** branch `commandPrune` keeps the `nowSec - 86400` / `+43200` future-window semantics from Alpha's prune — port exactly, including the `Depart_Memory` 4h window special-case, to avoid behavior drift.

**Risks summary:**
- Scope creep into Sandbox membership model (mitigate: explicit exclusion, follow-up flag).
- Injector input-source change could alter live behavior (mitigate: call out in proposal, keep legacy fallback via `readActiveGeneration`'s built-in fallback).
- Overlapping-file edits with the (out-of-scope) synthetic-return/manual-return work — those stay on their own follow-up change; do not mix.
- Branch line numbers differ from master (branch-era `Sandbox_Engine.js:1014` vs master `:1026` etc.) — all porting must be re-anchored to current master line numbers (this exploration lists the master numbers).

## Ready for Proposal
**Yes.** Current state, branch semantics, adaptation plan, test-reuse assessment, and scope boundary are all mapped. Key decision for the proposal: injector input source (manifest vs legacy) and handler entry protocol (par1 vs dedicated local).
