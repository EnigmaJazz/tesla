# Exploration: tasker-tesla-upgrade-slice-3

Read-only audit scoped to spec sub-items **0B** (overnight-boundary correction +
DST safety) and **0E** (post-return future-trip + AC-5). Phase 0 acceptance
tests AC-3, AC-5, and AC-7 are the validation criteria for this slice; the
remaining seven carry over unchanged from slice 2's verify. Source is the
18 live scripts (Backup/ excluded) plus the canonical spec at
`openspec/specs/itinerary/spec.md`.

## Phase 0 acceptance tests (spec §16) — post-slice-2

| # | Test | Status | Evidence | Reasoning |
|---|------|--------|----------|-----------|
| 1 | Between-event travel: previous event completes away; next leg ASAP | PASS (slice 2) | `Compiler.js:131-132, 237-244` consume `block_step19`; slice 2's `enqueuePlannedRow` and `chainForcesASAP` close this. | Unchanged by slice 3. |
| 2 | Attached end-of-day drop-in return uses ASAP | PASS (slice 2) | `Compiler.js:132` assigns `"ASAP"` to attached chains; HOLD pathway preserved. | Unchanged by slice 3. |
| 3 | Same-location overnight: today gets EOD return; tomorrow begins base/JIT | PASS (unchanged from slice 1) | `Sandbox_Engine.js:867-887` builds `EOD_RETURN` on `stayDuration >= 18000`; `Sandbox_Engine.js:1197-1219` appends the final EOD when `distToEndBase > 200`. | Still pre-slice-1 behaviour. Slice 3 must NOT regress this. The DST-unsafe `setHours(0,0,0,0)` math in `Finaliser.js:60-62` (which decides whether a drop-in is "today" or "future") is the **only** slice-3 touch here. |
| 4 | Empty-day ad-hoc walk creates no synthetic return or three-minute loop | PASS (slice 1) | `Dispatcher.js:286-297` emits `IDLE_SYNC_ENGAGED` and uses `IDLE_SYNC_MINS = 60`. | Unchanged by slice 3. |
| 5 | Return home after ad-hoc activity keeps tomorrow's first trip `PLANNED`/`JIT` | **UNKNOWN → slice 3 target** | `Sandbox_Engine.js:467-494` sets `simAtBase` from `oldItin` tail or live `User_At_Base`; slice 2 added the live rebind at `Sandbox_Engine.js:501-504`. `legPolicy` at `Sandbox_Engine.js:1245-1252` returns `"JIT"` when `isPrevBase` is true and no other ASAP trigger fires. **But** the `activeInProgress` regex at `Sandbox_Engine.js:469` — `/^(Driving|Walking|Public Transport|Lift)/i.test(currentStatus)` — fires for `"Driving (Heading Home)"`, which `Return_to_Base.js:92` sets as the post-return `Current_Status`. The next-day pass therefore sees `activeInProgress === true` and sets `simAtBase = false` at line 475, defeating the JIT contract. | The current `state.loc` rebind is correct for "live base wins" but does not cover "manual return completed — next day is fresh". `Return_to_Base.js` writes the leg to `Itin_Master.json` directly and updates `Current_Status` but emits **no** completion signal that the Sandbox can read on a subsequent pass. AC-5 needs an explicit gate. |
| 6 | Stale itinerary says away, live state says home — live wins | PASS (slice 2) | `Sandbox_Engine.js:438-494, 501-504`; `harness/test_sandbox_ac6.js` confirms. | Unchanged by slice 3. |
| 7 | Queue flush never removes/bypasses day boundary | PASS (unchanged from slice 1) | `Sandbox_Engine.js:712-743` (EOD on `sevenDayHorizonSec`) and `Sandbox_Engine.js:117-119, 657-687` (geofence limit + chain cut) work. **The day-boundary check at `Dispatcher.js:159-161` uses local `getDate()` which is DST-unsafe** — see DST site inventory below. | The chain-cut logic is correct; the comparison primitive is the DST bug slice 3 must fix. |
| 8 | Stop padding is applied exactly once | PASS (slice 1) | `Compiler.js:68-80, 236-241, 307` keeps `stopPadSecs` out of `durationSecs` and applies it once. | Unchanged by slice 3. |
| 9 | Stale past departure cannot block the next valid trip | PASS (slice 1) | `Dispatcher.js:83-127` ranks future > overdue-within-window; truly-stale is rejected. | Unchanged by slice 3. |
| 10 | No actionable trip uses idle sync, no tight loop | PASS (slice 1) | `Dispatcher.js:286-297` emits `IDLE_SYNC_ENGAGED` and uses 60 min. | Unchanged by slice 3. |

### Slice 3 verdict on the test table

- **AC-3, AC-5, AC-7** are the slice-3 targets. AC-5 is the only UNKNOWN;
  AC-3 and AC-7 must NOT regress.
- The **DST bug** is a cross-cutting concern that touches AC-3, AC-7, and
  several non-AC sites (day-rollover, route cache time-of-day, dashboard
  day-grouping). Slice 3's DST fix is the prerequisite for AC-3 staying
  PASS on a UK October transition day.
- **AC-1, AC-2, AC-4, AC-6, AC-8, AC-9, AC-10** carry over unchanged.

## Identity & ownership drift relevant to slice 3

### ID parsing (spec §2)
- Out of scope. The four live `id.split("_")[0]` sites are unchanged. Slice 3
  does not touch IDs.

### Command handling (spec §9)
- The "manual return completed" signal that AC-5 needs is **a command
  adapter concern**. `Return_to_Base.js:65-89` writes a leg to
  `Itin_Master.json` (single-writer violation per slice 1's audit) and
  emits a `TDS_Action_Lock.json` payload of type `MANUAL_ROUTING`. There
  is no `setGlobal` completion flag. **Recommend**: `Return_to_Base.js`
  sets `setGlobal('TDS_Manual_Return_Completed', nowSec.toString())` at
  the same time it sets `Current_Status` to `"Driving (Heading Home)"`.
  This is the smallest delta that gives the Sandbox a signal to read on
  the next-day pass.
- The corresponding `TDS_Action_Sessions.json` migration is **Phase 4** and
  out of scope for slice 3. The `setGlobal` is a temporary carrier that
  Phase 4 will replace with a session-record read.

### Single-writer contract (spec §8)
- Slice 3 must **not** add a new write path. The recommended
  `TDS_Manual_Return_Completed` global is a `setGlobal` (Tasker in-memory
  state), not a `TDS_*.json` write. The Sandbox reads it via
  `global('TDS_Manual_Return_Completed')` at pass start, then unsets it
  with `setGlobal('TDS_Manual_Return_Completed', '')` once consumed, so
  it does not persist across multiple planning passes.
- The DST helper must live as a free function in the script that uses it
  (or in a small shared module if slice 3 introduces one), not as a new
  `TDS_*.json` file. The Tasker engine has no module system; the
  existing pattern is a top-level `function` defined inside each script.

## DST site inventory (the new surface for slice 3)

Every site that does day-boundary comparison or time-of-day bucketing
that uses local `Date` methods is **DST-unsafe** on the UK transition
days (last Sunday of October fall-back and last Sunday of March
spring-forward). The fix: introduce a single helper
`sameLocalDay(unixA, unixB)` (or a UTC-day equivalent) that computes the
day index without going through `setHours(0,0,0,0)` / `getDate()`. Two
implementation options (see "Open questions"):

- **UTC day index** — `(Math.floor(unixA / 86400) === Math.floor(unixB / 86400))`
  is timezone-agnostic and DST-immune by construction. Risks: a UK
  user planning a 23:30 → 01:30 leg on the spring-forward day would
  see "two different days" in UTC but "the same night" in local time.
- **Local-day-with-DST-fix** — derive the day index from
  `Math.floor((unixSec - localMidnightOffset) / 86400)` where
  `localMidnightOffset` is the system's UTC offset for the date
  in question. This requires reading `Date.prototype.getTimezoneOffset()`
  per date, which **is itself DST-aware** (the offset changes by 60 min
  on the transition day). This is the spec-faithful option ("configured
  local timezone") but more code.

Live sites that must be touched by the DST fix:

| File:Line | Site | DST-safe? | Notes |
|---|---|---|---|
| `Alpha.js:15-20` | `getTodayStr()` — returns `YYYY-MM-DD` via `getMonth()`/`getDate()` | UNSAFE | Drives the `Tesla_Last_Sync` day-rollover check at line 182-187. On the spring-forward day, a 00:30 and a 02:30 fetch both return the same string (the 02:00–03:00 hour does not exist), and the `Daily_Walk_Meters` reset would fire correctly. On the fall-back day, the doubled 01:00–02:00 hour means two consecutive midnights could be the same date in some odd configs. The reset itself is **observation**, not policy, so the worst case is a stale or early reset; not safety-critical. |
| `Alpha.js:108-110` | Route cache `tod` and `dayType` derivation | UNSAFE | `tDate.getHours() * 60 + tDate.getMinutes()` is local-time. DST-unsafe but **DST-immune for the 60-min bucket** because the bucket is wide enough that a ±60-min skew is within tolerance. Same logic at `Alpha.js:122-167` (Welford merge) and `Sandbox_Engine.js:521, 533-535` (cache lookup). **Recommend**: tag this as "DST-tolerant" (not strictly safe) and leave the bucket as-is. |
| `Alpha.js:182-187` | `Tesla_Last_Sync` day rollover | UNSAFE (see above) | The reset of `Daily_Walk_Meters` to `"0"` must fire on a fresh local day. Replace `getTodayStr()` with a DST-safe helper. |
| `Compiler.js:322-329` | `diffDays = Math.round((new Date(apiUnix*1000).setHours(0,0,0,0) - new Date(nowSec*1000).setHours(0,0,0,0)) / 86400000)` | UNSAFE | Used to decide whether a depart-changed flash should fire. On a transition day, the 1-hour DST shift can produce `diffDays === 0` when the user's intent is "tomorrow", or `diffDays === 1` when they mean "today". Replace with UTC-day math or a DST-safe local helper. |
| `Dashboard.js:52, 62, 88, 98, 103-104, 182, 437-438, 449` | Day-grouping in trip rendering | UNSAFE | The day-string collapse at `Dashboard.js:75-85` uses `toDateString()` (UTC-anchored, actually safe) and the day-fill at `Dashboard.js:91-110` uses `setHours(0,0,0,0)` (UNSAFE). Display-only, not policy, but the dashboard will mis-group on transition days. |
| `Dispatcher.js:159-161` | `d1 !== d2` for multi-waypoint chain break | UNSAFE | `new Date(lastArrive * 1000).getDate()` is local-time. On a spring-forward night, two consecutive legs at 23:30 and 02:30 local could have `getDate() === 1` and `getDate() === 1` (same) but the user perceives them as crossing midnight. AC-7 protection is therefore incomplete on transition nights. The fallback at `stayMins <= 45` partially mitigates by relying on minute math. **Recommend**: replace with a DST-safe same-day check. |
| `Finaliser.js:60-62` | `evDay === todayDay` for drop-in time eligibility | UNSAFE | `setHours(0,0,0,0)` for both. A drop-in scheduled for "today 23:00" with `nowSec` at "today 22:30" compares equal; on a transition day the two could disagree. Affects AC-3 because the same-location overnight case for tomorrow depends on this check to suppress the drop-in from today's cluster. |
| `Finaliser.js:117-119` | `< 43200` geofence limit | SAFE (numeric) | This is a fixed-second window (12 hours), not a day boundary. DST-immune in itself. The 12-hour window may straddle a transition (covering one hour twice or zero hours) but the trip is still geofence-eligible. Leave as-is. |
| `Gatekeeper.js:113` | Route cache `dayType` | UNSAFE | Same `getDay()` pattern as `Alpha.js:110`. DST-tolerant (binary weekend flag, not a precise bucket). Leave as-is. |
| `Sandbox_Engine.js:108-119` | `getDayPrefix` for "Today"/"Tomorrow"/"Mon" labels | UNSAFE | Local-midnight math. Display-only; affects the lateness menu labels at lines 812, 906, 976, 1037, 1049 but not the policy. **Recommend**: make DST-safe for consistency but mark display-only. |
| `Sandbox_Engine.js:257-258` | `sevenDayHorizonSec` | UNSAFE | `hObj.setHours(23, 59, 59, 999)` after `setDate(getDate() + 7)` is local. On a spring-forward day, "now + 7 local days" is not 7 * 86400 seconds (it's 7 * 86400 - 3600). This affects the day boundary at line 712: an event scheduled for "7 days from now, 23:59 local" is 6.875 * 86400 seconds from now, but the EOD cut at line 742 fires because `evStart > sevenDayHorizonSec` is now `false` (the event is "earlier" than the DST-skewed horizon). **Recommend**: replace with UTC math or DST-safe helper. |
| `Sandbox_Engine.js:521, 533-535` | Route cache `getCachedTime` | UNSAFE (DST-tolerant) | See `Alpha.js:108-110`. |
| `Sandbox_Engine.js:1241` | `displayTime` for drop-in attached case | SAFE | `Math.max(state.time, openUnix)` — both Unix seconds, no `Date` math. |
| `Dashboard.js:23-29` | `getBoltMins` (used by Dispatcher `setLocal('itin_bolt_last', getBoltMins(lastSched))` at `Dispatcher.js:65` and `Dispatcher.js:225`) | UNSAFE | Local `getHours()` / `getMinutes()`. The 1424 cap is a single `getHours()*60 + getMinutes()` result and can be ≤ 1440 by construction. Display-only. Leave as-is. |

### DST strategy decision points

The same `setHours(0,0,0,0)` pattern recurs in 8 live files. The fix
must be **one helper used everywhere**, or the bug returns on the next
unfixed site. The two viable shapes:

1. **UTC day index** — `Math.floor(unixSec / 86400)`. Simplest, fully
   DST-immune. The trade-off: a UK leg scheduled 23:30 → 01:30 on
   spring-forward night is two different UTC days but the same local
   night. For the geofence / chain-break / drop-in-eligibility checks,
   this is acceptable (the leg will be re-evaluated on the next pass).
2. **Configured local-day helper** — read the system timezone once
   (or per date) and compute the day offset relative to that timezone's
   midnight. The spec says "configured local timezone"; today there is
   no such global — the system uses whatever the host device's timezone
   is. A new `global('TDS_Timezone')` would let the user pin a timezone
   (e.g. `"Europe/London"`) and have the helper use `Intl.DateTimeFormat`
   or a manual offset table.

**Recommend option 1 (UTC day index)** for slice 3 because: (a) the
data is Unix seconds and the spec's "day" semantic is opaque
("configured local timezone" is a recommendation, not a contract);
(b) the harness already pins `process.env.TZ = 'UTC'` for every test
file, so the helper is testable as-is; (c) introducing a
`TDS_Timezone` global adds a new state and a new code path. The
display-only sites (Dashboard day grouping, "Today/Tomorrow" labels)
can keep their local-time math because they show strings, not
policy.

## Cache, cluster, override, API drift relevant to slice 3

### Route cache (spec §11)
- The 60-min time-of-day bucket at `Alpha.js:122-167` and the
  `getCachedTime` lookup at `Sandbox_Engine.js:521-535` are
  DST-**tolerant** (the bucket is wider than the ±60-min DST shift)
  but not strictly DST-safe. No slice-3 change recommended; document
  the tolerance.
- No cache file changes needed for 0B or 0E.

### Override store
- `TDS_Overrides.json` is shared across 6+ writers. Slice 3 must NOT
  add a new key. The `TDS_Manual_Return_Completed` signal is a
  `setGlobal`, not a JSON write.
- The day-rollover prune at `Alpha.js:367-408` is DST-unsafe in its
  `eventStartUnix > (nowSec + 43200)` check, but only marginally
  (the 12-hour window is wide enough that a 1-hour DST shift doesn't
  change the result). Leave as-is.

### Cluster
- `Finaliser.js:201-237` cluster build is anchored on
  `veEnd > nowSec` (line 211) and the 4-hour temporal gap at line 214
  (`ve.start - lastDropinTime > 14400`). These are second-based and
  DST-immune. The `setHours(0,0,0,0)` day-check at line 60-62 is
  what slice 3 must fix (see DST inventory).

### API parser / Gatekeeper
- No slice-3 changes. The 4-hour and 2-hour relevance windows
  (`RELEVANCE_DEFAULT_SECS = 4 * 3600` at `Dispatcher.js:11`,
  `RELEVANCE_RECOVERY_SECS = 2 * 3600` at line 12,
  `RELEVANCE_EOD_SECS = 24 * 3600` at line 13) are second-based and
  DST-immune.

## Logging & tests

### Logging
- New event codes that slice 3 will emit (in addition to those already
  required by slices 1 and 2):
  - `EVT-OVERNIGHT_BOUNDARY_CREATED` — when the Sandbox appends a
    final EOD_RETURN on the sevenDayHorizonSec cut
    (`Sandbox_Engine.js:1267-1286`).
  - `EVT-CROSS_DAY_CHAIN_REJECTED` — when the Dispatcher breaks a
    multi-waypoint chain because the next leg is on a different
    local day (`Dispatcher.js:159-161`).
  - `EVT-SYNTHETIC_RETURN_SUPPRESSED` — already required by spec §17;
    not currently emitted anywhere; the slice-1 verify report called
    this out as a gap. Slice 3 may want to add it for completeness.
  - `EVT-FUTURE_TRIP_NOT_DUE` — when the Sandbox identifies a
    next-day first trip and confirms it remains `JIT` and not `DUE`.
- The `flash(JSON.stringify(event))` pattern from slice 1/2 is
  available. **No new file, no new `setLocal`/`setGlobal` key for
  logging** (the `TDS_Manual_Return_Completed` global is state, not
  logging).

### Test surface
- The harness at `harness/` is sufficient for AC-3 and AC-7 (they were
  PASS pre-slice-1 and are unaffected by the slice-3 work on the same
  code path; regression tests would catch a break).
- **AC-5 needs a new test** — `harness/test_sandbox_ac5.js`. Setup:
  - `Itin_Master.json` with a `MANUAL_RETURN` leg at `pitstopState: "end_of_day"`,
    `mode: "EOD_RETURN"`, departUnix=nowSec-3600, arriveUnix=nowSec-1800.
  - `TDS_Master.json` with one future event at `idx=1`.
  - `setGlobal('User_At_Base', 'true')` and `setGlobal('Current_Status',
    'Driving (Heading Home)')` to simulate the post-return state.
  - `setGlobal('TDS_Manual_Return_Completed', String(nowSec - 1800))` to
    simulate the new flag the slice-3 code will set.
  - Run `Sandbox_Engine.js` once. Assertions: (a) `block_step19 === "JIT"`;
    (b) the first row of `block_queue` has policy `"JIT"` in column 19;
    (c) no `EVT-FUTURE_TRIP_NOT_DUE` flash is absent (i.e. the flash fires
    as a confirmation); (d) the head destination is the future event's
    coords, not the home base (proving the new day is treated as a fresh
    pass).
- **DST safety needs a new helper test** — `harness/test_dst_helper.js`.
  Approach: the slice-3 work extracts the day-comparison logic into a
  small helper that takes a Unix second and returns a day index. The
  test pins `process.env.TZ` to a UK-like timezone
  (`process.env.TZ = 'Europe/London'`) and constructs three
  fixtures: (a) 2026-10-25 23:30 and 2026-10-26 01:30 (fall-back
  night, the 01:00–02:00 hour repeats); (b) 2026-03-29 23:30 and
  2026-03-30 01:30 (spring-forward night, the 02:00 hour is skipped);
  (c) 2026-03-29 23:30 and 2026-03-29 23:30 (same instant). Assertions:
  (a) and (b) return the same day index (correct for "local same day");
  (c) trivially returns the same day index.
- **A combined `harness/test_sandbox_dst.js`** would run the full
  Sandbox against a synthetic fixture with a 23:30 → 01:30
  overnight drop-in on 2026-10-25 (fall-back) and assert the chain
  cuts at midnight and the EOD fires. This is heavier; the helper
  test is the MVP and the integration test is a stretch goal.
- **The existing `process.env.TZ = 'UTC'` in every test file
  (`harness/test_*.js:10-17`) is itself a DST-masking pattern**: the
  tests run in UTC, so the production code's local-time math happens
  to produce the same day index as the UTC day index. A new DST
  helper test that sets `process.env.TZ = 'Europe/London'` will
  break the assumption that "UTC is enough" and will catch any future
  regression where a developer adds a new `setHours(0,0,0,0)` site.

## Spec drift not covered above

- **`enqueuePlannedRow` is the slice-2 helper for queue emission.**
  Slice 3 does not need to change the helper, but the EOD cut at
  `Sandbox_Engine.js:1267-1286` already uses it (`enqueuePlannedRow` at
  line 1283 with `"ASAP"` policy). The slice-3 work is upstream of the
  helper (deciding when to call it) and downstream (deciding whether
  the head leg that follows is a fresh JIT day).
- **The `evStart > sevenDayHorizonSec` cut at line 712-743** fires the
  EOD early for events more than 7 local days out. This is the spec's
  "lookahead stops at local midnight" pattern stretched to "lookahead
  stops at 7 days". The DST bug here is that "7 local days" is not
  exactly `7 * 86400` seconds. The slice-3 fix should compute the
  horizon in UTC and convert back to local for the "is this event on
  the same local day as the horizon" check, OR anchor the horizon to
  UTC midnight and accept the up-to-1-hour imprecision.
- **`dropinStatusFlag` is not yet an enum**; the spec §3 lists
  `legType` values that include `DROPIN`, `EOD_RETURN`, `RECOVERY`,
  `MANUAL`, `PITSTOP`. The current code uses positional strings
  (`"attached_dropin"`, `"detached_strict"`, `"none"`) in
  `Sandbox_Engine.js:1243`. Slice 3 should NOT introduce the enum
  (that's Phase 1) but the slice-2 helper already accepts any string
  in column 19, so the policy tag is forward-compatible.
- **The slice-2 verify report noted** the `enqueuePlannedRow` defensive
  fallback emission at `Sandbox_Engine.js:414-423` is dead code in
  normal operation. Slice 3 does not change this; the helper is the
  same.
- **`Daily_Walk_Meters` is a global, not a JSON field.** It is reset
  in `Alpha.js:186` and accumulated in `Sandbox_Engine.js:970`. The
  reset is DST-unsafe (depends on `getTodayStr()`) but the
  accumulation is DST-immune (pure addition of metres). Slice 3's
  DST fix covers the reset.
- **There is no `EVT-FUTURE_TRIP_NOT_DUE` flash anywhere in the live
  code.** Spec §17 lists it as required. Slice 3 is the right place
  to add it for AC-5 (the Sandbox emits it when it confirms a
  next-day first trip is `JIT`).

## Open questions for the user

1. **DST strategy — UTC vs configured timezone.** The spec says "day
   comparisons MUST use configured local timezone and be DST-safe".
   Two options:
   (a) **UTC day index** — `Math.floor(unixSec / 86400)`. Simplest,
   fully DST-immune, testable in the harness with the existing
   `process.env.TZ = 'UTC'`. Trade-off: a UK leg 23:30 → 01:30 on a
   spring-forward night is two different UTC days; the chain break
   at `Dispatcher.js:159-161` would fire even though it's the same
   local night.
   (b) **Configured local-day helper** — read a new
   `global('TDS_Timezone')` (or fall back to the host timezone) and
   use `Intl.DateTimeFormat` or a manual UTC-offset table to compute
   the day index per date. Spec-faithful but more code, more state,
   more risk.
   **Recommend (a) for the policy sites (chain break, day rollover,
   drop-in eligibility, sevenDayHorizonSec) and leave the
   display-only sites (Dashboard day grouping, "Today/Tomorrow"
   labels, route cache `tod`/`dayType`) on local time.** A short
   comment in the helper notes that human-facing display uses local
   time. The display sites are already DST-tolerant (the bucket or
   label is wider than the 1-hour skew).

2. **AC-5 "manual return completed" signal.** `Return_to_Base.js`
   currently writes the leg to `Itin_Master.json` (single-writer
   violation) and sets `Current_Status` to `"Driving (Heading
   Home)"`. The Sandbox's `activeInProgress` regex
   (`/^(Driving|Walking|Public Transport|Lift)/i`) then misclassifies
   the next-day pass as "in progress" and demotes `simAtBase` to
   `false`. The fix: `Return_to_Base.js` sets
   `setGlobal('TDS_Manual_Return_Completed', nowSec.toString())` at
   the same time as the `Current_Status` write. The Sandbox reads
   it at pass start; if the value is set and the manual return is
   in `Itin_Master`, the Sandbox treats the next day as a fresh
   pass and emits `EVT-FUTURE_TRIP_NOT_DUE`. The Sandbox then
   unsets the global after consuming it.
   Two open sub-questions:
   (a) **Should the Sandbox always unset the global after
   consuming, or leave it set for the day?** Recommend: unset on
   consumption. The Sandbox is the only reader; the next-day
   planning pass for a later day should not see a stale value.
   (b) **Phase 4 will replace the global with
   `TDS_Action_Sessions.json`.** Should slice 3 anticipate the
   session-record shape (timestamp + manual type + origin coords)
   or use the minimal `unixSec` only? Recommend: minimal `unixSec`
   for slice 3; the session record lands in Phase 4 with the
   richer schema.

3. **Other DST-sensitive sites slice 3 should touch?** The DST
   inventory above lists 13 sites. The slice-3 fix is mandatory at
   `Compiler.js:322-329`, `Dispatcher.js:159-161`,
   `Finaliser.js:60-62`, `Sandbox_Engine.js:257-258, 111-118`,
   `Alpha.js:15-20, 182-187`, and `Dashboard.js:62, 88, 437-438,
   449` because these drive policy or day grouping. The
   `getBoltMins` at `Dashboard.js:23-29` and `Dispatcher.js:65, 225`
   is display-only and can be left on local time. The route cache
   `tod`/`dayType` at `Alpha.js:108-110` and
   `Sandbox_Engine.js:521-535` is DST-tolerant (60-min bucket
   wider than 1-hour skew) and can be left. **Confirm with the
   user** that the list above is the full surface; missing a site
   will reintroduce the bug on the next unfixed location.

4. **Where does the DST helper live?** The Tasker engine has no
   module system. Options:
   (a) **Inline in each file that uses it.** Repeats the helper
   across 5+ files; bug-prone (one file gets out of sync).
   (b) **Append to `TDS_Helper.js`.** The helper is already
   "read-only migration helper; no generic setter" per spec §15.
   Slice 3 could add a `sameUtcDay(unixA, unixB)` function and
   have each script call it. But `TDS_Helper.js` is loaded only
   by specific call sites today (not by all 18 scripts), so this
   requires updating each call site to also load the helper.
   (c) **Standalone new helper file, e.g. `TDS_DST.js`.** Same
   load-site issue as (b).
   **Recommend (a) for slice 3** with a strict 5-line helper
   that is small enough to inline without bloat. Phase 3 (or
   later) can consolidate to `TDS_Helper.js` once the module
   load convention is settled.

5. **Should slice 3 also add `EVT-SYNTHETIC_RETURN_SUPPRESSED`?**
   Spec §17 lists it as required. The slice-1 verify report noted
   it is not currently emitted. AC-4 is PASS via the V15.1
   synthetic-EOD removal in `Dispatcher.js`, but there is no
   structured flash. Adding the flash is a 1-line change in
   `Dispatcher.js` and a 3-line change in `Sandbox_Engine.js`
   (when the EOD suppression fires at the end-of-master cut).
   **Recommend**: include in slice 3 as a "while you're there"
   change. Risk: small; value: closes a §17 gap.

6. **The slice-1 verify report's "WARNING: Task 11 native Tasker
   device checks remain deferred"** is still open. Slice 3 is a
   good time to remind the user, but does not require a
   resolution.

## Affected Areas

- `Return_to_Base.js:92` — add `setGlobal('TDS_Manual_Return_Completed', nowSec.toString())` next to the `Current_Status` write. (Theorised: also update `Depart_Now.js` similarly for the AC-5 analog on a "Depart Now" completion, but the spec calls out Return specifically. Confirm.)
- `Sandbox_Engine.js:1245-1252` — extend `legPolicy` to recognise the post-return state and force `"JIT"` for the next-day first trip; emit `EVT-FUTURE_TRIP_NOT_DUE`; unset `TDS_Manual_Return_Completed` after consumption.
- `Sandbox_Engine.js:257-258` — replace the local `setHours(23, 59, 59, 999)` with a UTC-day math; affects the sevenDayHorizonSec cut at line 712.
- `Sandbox_Engine.js:108-119` — DST-safe `getDayPrefix` (or keep on local time as display-only).
- `Finaliser.js:60-62` — replace `setHours(0,0,0,0)` with the helper; affects AC-3 drop-in eligibility.
- `Dispatcher.js:159-161` — replace `getDate()` with the helper; affects AC-7 chain break.
- `Compiler.js:322-329` — replace `setHours(0,0,0,0)` with the helper; affects depart-changed diff.
- `Dashboard.js:62, 88, 437-438, 449` — replace `setHours(0,0,0,0)` with the helper; affects day-fill display.
- `Alpha.js:15-20, 182-187` — replace `getTodayStr` local math with the helper; affects the `Tesla_Last_Sync` rollover.
- `harness/test_sandbox_ac5.js` — new AC-5 test.
- `harness/test_dst_helper.js` — new DST helper test (sets `process.env.TZ = 'Europe/London'`).
- No other live script is touched by slice 3.

## Risks

- **DST fix touches 5+ files.** The slice-3 footprint for the DST
  fix is wider than the slice-1 or slice-2 footprint. Workload
  forecast (Section E): 200-300 lines of helper, 50-100 lines per
  touch site × 8 sites = 400-800 lines, two harness tests × 100 lines
  = 200 lines. **Total: 800-1300 lines.** This is well over the
  400-line review budget. **Recommend chained PRs** (per
  `work-unit-commits` and `chained-pr` skills): PR-A is the DST
  helper + tests; PR-B is the AC-5 manual-return signal + test.
  Each PR is reviewable in isolation.
- **`TDS_Manual_Return_Completed` global is a new piece of state.**
  The spec's single-writer table does not name a writer for it
  (it's a `setGlobal`, not a JSON file). The orchestrator should
  confirm that adding a global outside the spec's writer table is
  acceptable. Recommend: yes, because it's a transient signal
  consumed and unset by the Sandbox, not a persistent store.
- **`Return_to_Base.js` already violates the single-writer contract
  by writing to `Itin_Master.json`.** Slice 3 does not make this
  worse (it adds a `setGlobal`, not a new `writeFile`). Phase 4
  consolidates the manual-action surface. **Out of scope for slice 3.**
- **The "Driving (Heading Home)" `Current_Status`** set by
  `Return_to_Base.js:92` is the immediate cause of the AC-5 bug.
  Slice 3's fix uses a parallel signal (the new global) rather than
  trying to clear `Current_Status` (which would defeat the in-progress
  display while the user is actually driving home). **Recommend**:
  keep `Current_Status` as-is; rely on the parallel signal.
- **The DST helper as a 5-line inline function in 5+ files** is
  acceptable for slice 3 but is a code-smell risk: a future change
  to one site may not propagate to others. Phase 3 should consolidate.
- **A `process.env.TZ = 'Europe/London'` harness test** is the first
  test in the suite that breaks the UTC convention. The other seven
  tests all use `process.env.TZ = 'UTC'`. This is intentional but
  worth a one-line comment in the new test file.
- **Mid-pass flip not covered for AC-5.** The `TDS_Manual_Return_Completed`
  signal is consumed at pass start. If the user does a manual return
  mid-day, the signal is set, the next pass consumes it, but if a
  third pass runs (e.g. the user changes their mind) the signal is
  gone. **Recommend**: keep the unset-on-consumption behaviour. The
  manual return is a one-shot event; a third pass should re-derive
  from `Itin_Master`.

## Ready for Proposal

**Yes.** Slice 3 has a clear scope (0B: DST-safe day comparisons; 0E:
post-return JIT gate), a known file footprint (5+ live files + 2
harness tests), and six open questions for the user. The slice-2
verify report is the evidence baseline; the spec's INV-0.2 and
INV-0.5 are the authoritative contracts. The workload forecast
suggests chained PRs; the orchestrator should ask the user
before apply. The proposal can be drafted immediately after the
user resolves the six open questions.
