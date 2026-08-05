# Exploration: tasker-tesla-phase0-followups

## Status: PASS

**Branch note:** This change was re-created from merged master after the follow-up port (PRs #19–#24) landed. `Override_Handler.js` and `ID_Parser.js` are on master; the exact-key reader is available for Slice D. The spec status line already names AC-3/AC-5/AC-7 as retained exclusions.

## Per-candidate feasibility map

| # | Item | Current behavior | Exact change needed | Risk | Harness-testable today |
|---|------|------------------|---------------------|------|------------------------|
| 1 | AC-3 same-location overnight → EOD today, base/JIT tomorrow | EOD_RETURN created (Sandbox L1358 `distToEndBase > 200`; early-EOD L787-818); day handoff via forbidden `_IN` suffix inference (`evId.indexOf("_IN")` L1334, `targetEventId.indexOf("_IN")` L548); `OVERNIGHT_BOUNDARY_CREATED` emitted nowhere; no `planningDay` field | Explicit leg `planningDay`/`originSource` handoff; emit `EVT-OVERNIGHT_BOUNDARY_CREATED`; guarantee tomorrow head leg JIT/base | Med | New `test_ac3_sandbox.js` (pattern: test_sandbox_ac6.js) |
| 2 | AC-5 return home → tomorrow future PLANNED | Genuinely missing: Dispatcher L132-167 picks `bestFuture` by `depUnix >= nowSec`, no future-day exclusion; `FUTURE_TRIP_NOT_DUE` emitted nowhere; reducer `COMPLETE_TRIP` is `stubApply` (Trip_State_Reducer.js L208); Return_to_Base sets status only | Reducer `COMPLETE_TRIP`; future-`planningDay` exclusion in Dispatcher; emit `FUTURE_TRIP_NOT_DUE` | Med | New `test_ac5.js` |
| 3 | AC-7 queue flush never bypasses day boundary | Flush: `block_queue="EOF"` + `skip_idx_until = master.length + 99` (L316-320); early-EOD `skipIdx = master.length + 99` (L817) — swallows next-day events; `CROSS_DAY_CHAIN_REJECTED` emitted nowhere | Day-boundary-aware flush per local planning day; emit `CROSS_DAY_CHAIN_REJECTED` | Med | Extend `test_departure_day.js` |
| 4 | 0B overnight boundary + DST | DST largely done (isSameUTCDay/utcDayBoundaryUnix/SECONDS_PER_DAY + test_dst_utc.js); early-EOD keyed off 8-day horizon not planning day; no `planningDay` computed | Timezone-derived `planningDay`; key EOD/boundary off it; emit `OVERNIGHT_BOUNDARY_CREATED` | Low-Med | Extend `test_dst_utc.js` + test_ac3_sandbox.js |
| 5 | 0E post-return future-trip | Same surface as AC-5; tomorrow head trip inherits `activeInProgress → ASAP` (legPolicy L1322) while `Current_Status="Driving (Heading Home)"` | Roll into AC-5 slice: head leg JIT/PLANNED after return completion | Med | Same `test_ac5.js` |
| 6 | INV-0.4 synthetic/manual return acceptance | Manual return explicit (Return_to_Base emits MANUAL_RETURN/end_of_day, ASAP); EOD/RECOVERY explicit; `SYNTHETIC_RETURN_SUPPRESSED` emitted nowhere | Suppression guard + log where return would be synthesized from unplanned movement | Low | Extend AC-4-style empty-day test |
| 7 | INV-0.7 zero-duration fallback order | Reject/log exists (ZERO_DURATION_LEG_REJECTED); local active-travel estimate exists (Compiler L116-133); Sandbox-metrics tier MISSING (`block_step17`/`block_step18` emitted nowhere; only `block_step19` at Sandbox L505); CACHE-11 unenforced | Sandbox exports block_step17/18 (ramTier/ssdTier caches L518-537); Compiler inserts tier between validated API and local estimate | Med | Extend `test_compiler_ac1.js` |
| 8 | Sandbox OVR-10 cleanup | ~17 membership sites (not 10): trimRaw L131, Forced_* L302-305, Ignored_Lateness L318-320/879/1000/1024, csArr L341, skippedEvents L744/957, Ignored_Walks L1093/1105/1131, routeDefaults L1086-1093; also `coreId = evId.split("_")[0]` L1026 (AGENTS.md violation) | Exact-key maps (eventOverrides/seriesPreferences); fix coreId to lastIndexOf("_"); reuse handler hasExactKey pattern | Med-High | New `test_sandbox_ovr10.js` |

## AC-3/AC-5/AC-7 state in code
- **AC-3: partially implemented** — EOD_RETURN exists; day handoff relies on forbidden `_IN` suffix; `OVERNIGHT_BOUNDARY_CREATED` never emitted; not test-covered.
- **AC-5: genuinely missing** — no FUTURE_TRIP_NOT_DUE, no future-day exclusion, COMPLETE_TRIP is a stub, no completion signal.
- **AC-7: partially implemented** — day boundary in Dispatcher/Generation_Publisher; Sandbox flush bypasses per-day boundaries; CROSS_DAY_CHAIN_REJECTED never emitted.

## Manual-return completion-signal gap
Missing emission is a completion into Trip_State_Reducer: implement declared `COMPLETE_TRIP` (L208 stub); observer (Stop_Logger or arrival watcher when User_At_Base + Base_Arrival_Unix) submits `COMPLETE_TRIP {tripId: <MANUAL_RETURN leg>, at: now}`. Reducer sets leg COMPLETED, closes action session, refuses to mutate later-day policy (TRIP-4). Sandbox/Dispatcher read that state to emit FUTURE_TRIP_NOT_DUE and keep tomorrow JIT/PLANNED. (Lighter alternative: TDS_Manual_Return_Completed global one-shot — routes through a global instead of TDS_Trip_State.json; reducer command is spec-canonical CMD-9/TRIP-4/OWN-8B.)

## Change-structure proposal
**ONE change, 4 slices across 3 PRs** (8 items cannot fit one 400-line PR):
- **Slice A — Day-boundary completion (items 1, 4, 3):** Sandbox planningDay + boundary-aware EOD/flush + OVERNIGHT_BOUNDARY_CREATED/CROSS_DAY_CHAIN_REJECTED logs; DST verify. ~120-180 prod + ~120 test. PR-1.
- **Slice B — Post-return isolation (items 2, 5, 6):** reducer COMPLETE_TRIP, completion observer, Dispatcher future-day exclusion, FUTURE_TRIP_NOT_DUE, SYNTHETIC_RETURN_SUPPRESSED. ~100-160 prod + ~120 test. PR-2.
- **Slice C — INV-0.7 fallback (item 7):** Sandbox block_step17/18 export + Compiler tier insertion. ~80-120 prod + ~80 test. PR-3.
- **Slice D — OVR-10 exact-key cleanup (item 8):** ~17 site replacements + coreId fix + exact-key reader reuse. ~150-250 prod + ~100 test. PR-3 or PR-4 (own PR if PR-3 would exceed ~400).

## Dependencies
- Item 8 depends on exact-key reader — now ON master (Override_Handler.js hasExactKey).
- Items 1/3/4 share Sandbox EOD/flush region (L787-818, L1338-1361) — one slice.
- Items 2/5/6 share return-lifecycle surface — one slice.
- Item 7 touches Compiler + Sandbox enqueuePlannedRow (L488-506) — overlaps Slice A's file but not its code region; safe after A.
- Item 8 coreId fix (L1026) interacts with Route_Defaults reads only.
- No slice touches Finaliser DST helpers or Gatekeeper cache decisions.

## Risks
- Count mismatch: scope says "ten indexOf"; live file has ~17 membership sites — proposal must not promise "ten".
- AC-3 vs AC-6 tension: replacing `_IN` inference must not break live-base override (needs regression test in same slice).
- AC-7 flush change alters `skip_idx_until` semantics; test_departure_day.js assertions must be re-verified.
- `planningDay` is new Sandbox state — must not collide with Finaliser day validation or DST helpers.
