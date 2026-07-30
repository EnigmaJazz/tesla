# Exploration: tasker-tesla-upgrade-phase-2-atomic-publication

Read-only audit scoped to spec §1A/§1B, §7 (atomic publication), §8 RULE-8A
(Generation Publisher), and the deferred Phase 2 items called out in slices
1–4. Source is the 18 live scripts (`_archive/Backup/` excluded), the
canonical spec at `openspec/specs/itinerary/spec.md` (slices 1–4 merged),
and the spec source at `_spec_source.md` (verbatim spec, with §7 lines
600–640, §8 lines 645–671, §16 Phase 2 lines 1101–1107, and §17 lines
1140–1176). Slice 4's verify is the evidence baseline; Phase 0 AC is 10/10
PASS.

## 1. Current state inventory

### 1.1 Writers of `TDS_Master.*` and `Itin_Master.*` today

`grep -n -E "writeFile.*(TDS_Master|Itin_Master)" *.js` (live files only) returns:

| File:Line | File written | Operation | Authorisation under RULE-8A |
|---|---|---|---|
| `Finaliser.js:155` | `TDS_Master.json` | Write the validated event array as JSON | Generation Publisher (§1A) — **authorised** |
| `Gatekeeper.js:56` | `TDS_Master.json` | Reorder the existing master after cluster decision | Spec §15 says Gatekeeper is "no write, cache decision only" — **VIOLATION** |
| `API_Parser.js:33` | `TDS_Master.json` | Reorder the existing master after cluster decision | Spec §15 says API_Parser is "no write, cache only via manager" — **VIOLATION** |
| `Alpha.js:392` | `TDS_Master.json` | Clear the file to `"[]"` | Spec §7: "Published files MUST NOT be cleared or incrementally rebuilt" — **VIOLATION** |
| `Compiler.js:452` | `Itin_Master.json` | Write the compiled itinerary array as JSON | Generation Publisher (§1B) — **authorised** |
| `Alpha.js:393` | `Itin_Master.json` | Clear the file to `"[]"` | Spec §7: "Published files MUST NOT be cleared or incrementally rebuilt" — **VIOLATION** |

`TDS_Run_Manifest.json` has **no writers** today; it does not exist on disk
and is referenced only in spec §7/§8/§16 and in the slice-1/2/4 verify
reports as a Phase 2 deliverable.

`Override_Handler.js:36` and `Compiler.js:50` carry a `generationId: null`
placeholder in their `flash()` payloads. The `null` is documented in the
slice-1 spec as a Phase-2 placeholder; every other §17 shape field is
already populated.

### 1.2 Readers of `TDS_Master.*` and `Itin_Master.*` today

`grep -n -E "readFile.*(TDS_Master|Itin_Master)" *.js` (live files only) returns:

| File:Line | File read | Purpose |
|---|---|---|
| `Compiler.js:126` | `TDS_Master.json` | Source of events to compile into legs |
| `Compiler.js:191` | `Itin_Master.json` | "Previous itinerary" for delta + ASAP/JIT policy |
| `Sandbox_Engine.js:270` | `TDS_Master.json` | `GLOBAL_MASTER_ARR` global cache for the planning pass |
| `Sandbox_Engine.js:380, 516` | `Itin_Master.json` | `oldItin` for `simAtBase` legacy-itinerary fallback (INV-0.3) |
| `Gatekeeper.js:37` | `TDS_Master.json` | Reorder lookup (pre-write at line 56) |
| `API_Parser.js:17` | `TDS_Master.json` | Reorder lookup (pre-write at line 33) |
| `Finaliser.js:181` | `Itin_Master.json` | Migration / drop-in duplicate detection (reads what it does not own) |
| `Dashboard.js:17` | `Itin_Master.json` | Render active itinerary |
| `Dispatcher.js:85` | `Itin_Master.json` | Candidate selection (SEL-6) |
| `Override_Injector.js:14` | `Itin_Master.json` | Read `targetEventId` for override dispatch |
| `Depart_Now.js:8`, `Return_to_Base.js:57` | `Itin_Master.json` | Manual-action context (slice-1 audit) |

**Read-then-write pattern across `Gatekeeper` and `API_Parser` is the
highest-risk area for Phase 2:** both scripts read `TDS_Master.json` to
make a reorder decision, then immediately write the entire file back.
Under atomic publication this is the exact pattern the spec forbids
(§7: "MUST NOT be cleared or incrementally rebuilt"). These two writes
must move to the Generation Publisher — either by emitting a typed
"reorder these IDs" command that the Publisher applies at the end of
the generation, or by being deprecated entirely in favour of the
Publisher's own ordering logic. (Open question.)

### 1.3 Current JSON shapes

`TDS_Master.json` — array of event records. Live shape (per
`harness/test_single_writer.js:97-106` and the data fixture in the
slice-1 archive):

```json
[
  {
    "id": "abc123_kx8f00",
    "start": 1700003600,
    "end": 1700007200,
    "duration": 3600,
    "title": "Future Event",
    "desc": "",
    "loc": "Work",
    "coords": "52.1,-2.2"
  }
]
```

`Finaliser.js:155` writes this shape (`validEvents` array). It is the
raw event list after geocode, override-merge, and validation. Note
that the field set is narrower than the spec's §3 event schema
(missing `seriesId`, `instanceStartUnix`, `eventType`, `isDropin`,
`isEssential`, `requestedMode`, `arrivalBufferMins`, `stops`). Phase 2
must bring the on-disk shape up to the spec's §3 event fields, or
publish the §3 fields into `TDS_Events.<gen>.json` (the spec's §1A
output) and let the legacy `TDS_Master.json` be deprecated. The
spec names `TDS_Events.<generationId>.json` as the event output
(`_spec_source.md:214`), distinct from `TDS_Master.<generationId>.json`
(line 610). The current `TDS_Master.json` is acting as a hybrid
event-store-and-marker. (Open question: the spec's split into events
vs master files is not yet implemented; today's `TDS_Master.json` is
neither.)

`Itin_Master.json` — array of leg records. Live shape (per
`harness/test_single_writer.js:172-177` and the slice-1/2 audit):

```json
[
  {
    "tripId": "test_leg",
    "targetEventId": "abc123_kx8f00",
    "mode": "DRIVE",
    "targetCoords": "52.1,-2.2"
  }
]
```

`Compiler.js:440-447` shows the full live leg record before
serialisation:

```javascript
{
  tripId, targetEventId, targetTitle, targetDesc, targetLoc,
  originCoords, targetCoords, departUnix, arriveUnix,
  durationSecs, distanceMiles, pitstopState, latenessMins,
  bufferMins, transitStepsRaw, holdUntilUnix, pendingStopsRaw
}
```

The spec's §3 leg schema (`_spec_source.md:354-378`) requires:
`eventId`, `seriesId`, `generationId`, `legType`,
`departurePolicy`, `originSource`, `planningDay`,
`relevanceDeadlineUnix`, `stopDurationSecs`, `completionPolicy`.
Slices 2 and 4 added `block_step17/18/19` to the queue; the
on-disk `Itin_Master.json` leg object has not yet been migrated to
the §3 shape. Phase 2 must publish the spec's leg shape.

### 1.4 `generationId` lifecycle today

- **Minting:** none. Every leg/trip has no generation identity; the
  `block_step17/18/19` queue fields are filled by the Sandbox but the
  persisted leg does not carry a `generationId`.
- **Propagation:** none. No file, global, or local carries a
  generation ID between scripts.
- **"Committed":** undefined. There is no commit step today; the
  `Itin_Master.json` file IS the live state at all times. Any reader
  picks up whatever the most recent `writeFile` left.
- **Slice-1/2/4 evidence:** slices 1, 2, and 4 each placed
  `generationId: null` in their `flash()` payloads with a comment that
  this is a Phase-2 placeholder. The slice-4 verify report
  (`verify-report.md:256`) calls out Phase 2 as the slice that
  "introduce[s] versioned `TDS_Master.<generation>.json` and
  `Itin_Master.<generation>.json` resources and publish[es]
  `TDS_Run_Manifest.json` last."

### 1.5 Test surface

- `harness/test_single_writer.js` — the writer-set assertion is the
  template for Phase 2's manifest-conformance test. It exercises
  every adapter that touches `TDS_Overrides.json` and asserts a
  one-writer invariant. Phase 2 needs an analogous
  `test_atomic_publication.js` that asserts (a) `TDS_Master.<gen>` and
  `Itin_Master.<gen>` are created, (b) `TDS_Run_Manifest.json` is
  written last, (c) only the Generation Publisher's output is on
  disk, and (d) prior generation is preserved on failure.
- `harness/mock_tasker.js` — provides `readFile`, `writeFile` (with
  `append` boolean), `local`, `setLocal`, `global`, `setGlobal`,
  `flash`, and a `flashLog` array. **No `rename` or `atomicWrite`
  primitive** is exposed; the harness file map is `Record<string,string>`.
  This is the local ceiling on what a "write-temp-then-rename" option
  can be tested with today.
- `harness/runner.js` — runs each script in a `vm.createContext`
  sandbox with the `createSandbox` fixture. Used as-is by every
  `test_*.js`.

## 2. Atomic-publication design space

The exploration does **not** select a design. The four dimensions
below each list the candidates; the proposal phase picks one per
dimension based on the tradeoffs summarised in §4 and §5.

### 2.1 Generation ID format

The spec example (`_spec_source.md:359`, `:1149`):

```text
gen:<unixSeconds>:<4-hex-chars>
e.g. gen:1784369000:ab12
```

Candidates:

| Option | Example | Pros | Cons |
|---|---|---|---|
| A. Spec literal `gen:<unix>:<hex>` | `gen:1784369000:ab12` | Matches the spec verbatim; recognisable; parseable via `id.lastIndexOf("_")`-style separator; the hex suffix reduces collision risk on back-to-back builds within the same second. | 4-hex = 65 536 suffixes per second; not a hard uniqueness guarantee under crash-restart loops. |
| B. ULID | `01HXYZ...` | Lexicographically sortable; 80 bits of randomness; standard library concept. | Not Tasker-native; the spec's `lastIndexOf("_")` / `base36` convention is for occurrence IDs, not for `generationId`; introduces a new pattern. |
| C. Monotonic counter per day | `gen:20260719:0007` | Human-readable; easy to grep. | Requires a persistent counter file (writes outside the single-writer contract); timezone-sensitive; the spec example does not use a counter. |
| D. `unixMillis_base36` (matches occurrence ID suffix style) | `gen:kx8f00` | Reuses the spec §2 base-36 suffix convention; smallest possible representation. | Loses the "two-part" clarity of the spec example; collisions if two generations build in the same millisecond. |
| E. UUIDv4 | `gen:550e8400-e29b-41d4-a716-446655440000` | Standard; zero collision risk. | Larger; not human-friendly; Tasker `Math.random` quality is unverified for crypto. |

**Recommendation direction (not a decision):** Option A. It is the
spec literal, satisfies the single-second uniqueness needed for one
generation per task-run, and matches the codebase's existing
`base36` suffix convention. The 4-hex suffix is sufficient because the
Generation Publisher is a single writer; a collision only happens if
two builds complete within the same Unix second, which the
single-writer guarantee already prevents.

### 2.2 Manifest schema

The spec example (`_spec_source.md:622-627`):

```json
{
  "activeGeneration": "gen:1784369000:ab12",
  "publishedAt": 1784369050
}
```

Candidates for the full manifest:

| Field | Purpose | Spec-anchored? |
|---|---|---|
| `schemaVersion` (number) | Version of the manifest schema itself. Lets Phase 3+ evolve the field set without breaking readers. | Not in spec example. Required for forward compat. |
| `activeGeneration` (string) | The `generationId` readers should load. | Yes (spec line 624). |
| `previousGeneration` (string) | The prior generation; readers can fall back to it if `activeGeneration` files are missing. | Implicit in spec §7 step 9 ("preserve the previous generation on any failure"). |
| `publishedAt` (number) | Unix seconds of the manifest write. | Yes (spec line 625). |
| `committedAt` (number) | Same as `publishedAt`, or a separate field if generation start vs publish end are tracked. | Spec line 304: "`generationId` identifies one scheduler build." A `startedAt` may be useful for diffing. |
| `startedAt` (number) | Unix seconds of the planning pass start. | Not in spec example. Useful for "duration of generation" telemetry. |
| `writer` (string) | The component that produced this manifest, e.g. `"Finaliser"`. Spec §15 names "Generation Publisher" as the logical role; the live implementation is split between `Finaliser.js` and `Compiler.js`. | Not in spec example. Useful for audit. |
| `itinPath` (string) | Filename of the matching itinerary, e.g. `"Itin_Master.gen:1784369000:ab12.json"`. | Not in spec example. Lets the manifest avoid filename parsing on the read side. |
| `masterPath` (string) | Same idea for `TDS_Master.<gen>.json`. | Not in spec example. |
| `eventsPath` (string) | Same idea for `TDS_Events.<gen>.json` (spec §1A). | Not in spec example. |
| `legCount` (number) | Leg count for sanity-checks. | Not in spec example. Cheap. |
| `eventCount` (number) | Event count for sanity-checks. | Not in spec example. Cheap. |
| `validationCodes` (array of strings) | The §17 event codes that fired during this generation's publication. | Not in spec example. Useful for shadow mode (§18). |
| `state` (string) | `"committed"` | `"building"` | `"failed"`. Lets readers detect a torn manifest write (the file exists but is partial). | Not in spec example. A torn manifest is a real risk under Tasker's non-atomic `writeFile`. |

**Recommendation direction:** minimum viable manifest = spec literal
+ `schemaVersion` + `previousGeneration` + `itinPath` + `masterPath` +
`eventsPath` + `state`. The explicit paths avoid the reader having to
**guess** the filename pattern, which removes a class of bugs (e.g.
`id.split("_")[0]`-style breakage on a generation ID that contains
an underscore or colon).

### 2.3 File-system atomicity options

The Tasker runtime is a JSlet engine with `readFile(path)` and
`writeFile(path, content, append)` (`TDS_Helper.js:24` — third arg is
`append` boolean). No `rename`, no `fsync`, no `link`. The harness
mock at `harness/mock_tasker.js` matches these primitives exactly.

| Option | How it would work | Tasker / harness support | Verdict |
|---|---|---|---|
| **A. Single-writer, last-writer-wins, manifest-last** | One writer (Generation Publisher) writes `TDS_Events.<gen>.json` → `TDS_Master.<gen>.json` → `Itin_Master.<gen>.json` → `TDS_Run_Manifest.json` in that order. Readers always read what the manifest points at. The "atomic" property is "no two writers contend" + "manifest is the canonical switch." | Fully supported. All four writes use the existing `writeFile` primitive. The order is a property of the Publisher's script, not of the runtime. | **Recommended direction.** This is the spec's procedure verbatim (lines 629–639). |
| **B. Write-temp-then-rename** | Write to `TDS_Master.<gen>.json.tmp` then rename to `TDS_Master.<gen>.json`. | **Not supported.** Tasker's `writeFile` is the only file primitive; there is no `rename`, no `mv`, and the harness's `mock_tasker.js` does not model it. Adding it would require both Tasker native changes (out of scope) and a harness extension. | Rejected on platform grounds. |
| **C. In-place with a write-ahead log (WAL)** | Write a journal of intended writes, then replay. | Not in the spec. Out of scope for Phase 2. | Rejected. |
| **D. Generation directory per build** | `gen/gen:1784369000:ab12/{events,master,itin,manifest}.json` | Possible on Tasker (subdirectories exist) but adds a directory-create primitive that the harness does not model. | Rejected for the spec's flat-file convention. |

**Implication for "atomic":** the spec's procedure (lines 629–639) does
not depend on POSIX atomic rename. It depends on:

1. One writer per resource (RULE-8A).
2. Manifest written last.
3. Validation gates 1–7 (spec lines 631–637) before the manifest write.
4. Prior generation preserved on any failure (step 9).

The "atomic" property is "no reader ever sees a partial
generation" because (a) the new master/itin files are written before
the manifest, so a reader that follows the manifest pointer never sees
a half-written new file, and (b) if the manifest write fails, the
prior generation is still on disk and pointed at by the previous
manifest. This is **eventual consistency** under crash, not strict
atomicity. The exploration flags this in §3.

### 2.4 Reader discovery

How `Dispatcher.js`, `Dashboard.js`, `Override_Injector.js`,
`Finaliser.js`, and the cluster/return-to-base scripts find the
"current" generation:

| Option | Read sequence | Pros | Cons |
|---|---|---|---|
| **A. Manifest read** | `readFile("Tasker/Tesla/Data/TDS_Run_Manifest.json")` → parse `activeGeneration` → `readFile("Tasker/Tesla/Data/Itin_Master." + activeGen + ".json")` | Explicit; aligns with spec §7 ("Dashboard and Dispatcher read the manifest first"); one place to evolve the convention. | Two reads per consumer; the manifest itself can be torn. |
| **B. Lexicographic max** | `readDir(...)` of `TDS_Master.gen:*.json`, pick the highest. | No manifest to corrupt. | Requires `readDir`; spec §7 mandates manifest-first. |
| **C. Symlink** | A symlink `Itin_Master.current.json → Itin_Master.<gen>.json`. | Single read. | Not in Tasker's file primitives; spec §7 names the manifest. |

**Recommendation direction:** Option A. Spec §7 says "Dashboard and
Dispatcher read the manifest first and then read files from that
exact generation." This is the contract; the implementation should
follow it. A small reader helper (e.g. `readActiveItinerary()` in
`TDS_Helper.js`) prevents the pattern from being copy-pasted with
mistakes (e.g. one caller forgetting to read the manifest and reading
the legacy `Itin_Master.json` instead).

### 2.5 Garbage collection

The spec is silent on retention. Candidates:

| Option | Policy | Pros | Cons |
|---|---|---|---|
| A. Keep last N generations | `GEN_RETENTION_COUNT = 5` constant; Publisher prunes on each successful publish. | Bounded disk; predictable. | Hardcoded N; stale-reader fallback window is bounded. |
| B. Keep last 24 h | Time-based; prune at publish. | Aligns with the planning-day model. | Time math under DST; harder to bound disk. |
| C. Keep all | Never prune. | Simplest. | Disk grows unbounded. |
| D. Keep current + previous | Always two generations on disk. | Minimal; readers can always fall back. | Old generations lost; can't audit more than one back. |

**Recommendation direction:** Option A with a named constant
(`MAX_GENERATIONS_KEPT` per the project's no-magic-numbers rule). The
harness can simulate with `mock_fs.ls()` if needed. The publish flow
writes the new generation first, then prunes old ones only if the
write succeeded — preserving the spec's step 9 "preserve the previous
generation on any failure."

## 3. Risks and open questions

### 3.1 Risks

- **Stale-reader window during manifest swap.** A reader that read the
  manifest and is mid-flight reading `Itin_Master.<gen>.json` while a
  new publish starts. If the new publish is the same generation (no
  conflict), no problem. If the new publish is a new generation, the
  reader may finish reading a half-written new file. **Mitigation:**
  Publisher always writes the new file fully before updating the
  manifest, so the worst case is "read a different but complete
  generation" — a recoverable inconsistency. (Spec §7 step 2 + step 8
  are the contract.)

- **Torn manifest write under Tasker non-atomic `writeFile`.** If the
  process crashes between truncating and finalising the manifest, the
  manifest is partial JSON. A reader that parses it will throw, fall
  back to its last-known-good manifest, or default to the prior
  generation. **Mitigation:** the manifest's `state` field
  distinguishes `"building"` | `"committed"` | `"failed"`; readers
  treat a `state` other than `"committed"` as "do not use, fall back."
  This is a proposal-phase decision.

- **Generation Publisher's own failure mid-publish.** A failure
  between writing `TDS_Master.<gen>.json` and writing the manifest
  leaves a complete new master with no manifest pointer. A failure
  between writing `Itin_Master.<gen>.json` and writing the manifest
  is worse: the master is new, the itinerary is new, but the manifest
  points elsewhere, so the user sees a stale itinerary while a new
  master is orphaned on disk. **Mitigation:** the Publisher's
  validation gates (spec §7 steps 1–7) run before any write; once
  writing starts, the writes are short and sequential. The spec's
  step 9 ("preserve the previous generation on any failure") means
  the manifest is rewritten to the previous generation if the new
  publish aborts.

- **Torn `TDS_Master.<gen>.json` under crash.** A crash mid-write
  produces an unparseable file. A reader that follows the manifest to
  a torn master must recover. **Mitigation:** Publisher writes the
  master to a temp path first (`TDS_Master.<gen>.json.tmp`), then
  renames — but Tasker has no rename primitive (see §2.3 option B).
  **Fallback:** write the master in a single `writeFile` call
  (current pattern), and rely on the file being all-or-nothing per
  the Tasker writeFile contract. The exploration flags this as a
  platform limit; the design phase should confirm with the user that
  Tasker's `writeFile` is single-shot per call.

- **Mid-migration reader drift.** While `TDS_Master.json` (legacy) is
  still being read by some scripts and `TDS_Master.<gen>.json` (new)
  is being read by others, the system has two sources of truth.
  **Mitigation:** Phase 2 cuts over all readers in one change; no
  parallel-run window. The legacy `TDS_Master.json` is removed by
  the same change that introduces the versioned files. **Risk:** if
  one of the readers is missed, the system silently degrades to the
  old behaviour. (Mitigated by `harness/test_atomic_publication.js`
  asserting every reader follows the manifest.)

- **Manifest-versioning drift.** Phase 3+ may add fields to the
  manifest (e.g. `committedAt`, `legCount`). A Phase-2 manifest reader
  must not break on a Phase-3+ manifest. **Mitigation:** the
  `schemaVersion` field in the manifest.

- **Cluster reorder writers (Gatekeeper, API_Parser) bypass the
  Publisher.** Both scripts read and write `TDS_Master.json` today
  (§1.2). Under atomic publication this is forbidden: only the
  Generation Publisher writes the master. **Decision needed in the
  proposal:** either (a) Gatekeeper and API_Parser stop writing
  master entirely (the Publisher's own ordering logic decides the
  final master order), or (b) they emit a typed "reorder" command
  that the Publisher applies at the end of the generation.

- **`TDS_Events.<gen>.json` does not exist today.** Spec §1A names it
  as the event output. Today's `TDS_Master.json` is a hybrid
  event-store. Phase 2 must either (a) introduce `TDS_Events.<gen>.json`
  alongside the new `TDS_Master.<gen>.json` and deprecate the legacy
  `TDS_Master.json`, or (b) keep using the on-disk shape and add
  `TDS_Master.<gen>.json` directly. (a) is more spec-faithful but
  larger; (b) is the smaller diff. **Decision needed in the
  proposal.**

### 3.2 Open questions

- **Should the manifest be append-only (audit trail) or replaceable
  (last-writer)?** Spec §7 step 8 ("write the manifest last")
  implies replaceable; an append-only audit log is a different
  concern (the §17 event log). The manifest IS replaceable; the
  audit trail is the §17 event log. **Confirm.**

- **What happens to consumers mid-migration from `TDS_Master.json`
  (legacy) to `TDS_Master.<gen>.json` (new)?** Recommend: cut over
  every consumer in one change. The harness can simulate the
  mid-migration window (consumer still reading legacy, manifest
  pointing at new) and assert the consumer follows the manifest.

- **Does the manifest itself need versioning (manifest v1, v2)?**
  Recommend: yes, with a `schemaVersion` field. The v1 schema is
  the spec literal + `state`; v2+ can be added by the design phase
  as needs emerge.

- **Where is the Publisher's start time sourced?** Spec example uses
  `gen:1784369000:ab12` where `1784369000` is the build start. The
  Sandbox already has `nowSec` (live reading) and a `virtual_time`
  harness global. **Decision:** `Math.floor(Date.now()/1000)` at the
  start of the Publisher's script. (Harness sets `nowMs` via
  `createSandbox({ nowMs })` so the test value is deterministic.)

- **Is the `TDS_Events.<gen>.json` file required for Phase 2, or is
  the on-disk `TDS_Master.<gen>.json` enough?** Spec §1A names both;
  today's code only writes a master-shaped file. **Decision needed
  in the proposal.**

- **What is the failure semantics when the new manifest's
  `activeGeneration` is unreadable?** Recommend: readers fall back to
  the previous generation (whose `generationId` is in
  `previousGeneration`); if that is also unreadable, readers fall
  back to the empty default and the Dispatcher engages the idle
  sync interval per INV-0.6. The spec is silent on the
  previous-generation-fallback window; **decision needed.**

- **Should the `gen:` prefix be reserved?** Spec uses `gen:...`
  for `generationId` and `leg:inbound:...` / `leg:outbound:...` for
  `tripId` in the example shapes. The codebase already uses
  `stop:<eventId>:<ordinal>` for stop IDs (per spec §14). The
  namespace appears to be `gen|leg|stop|action|series|event|trip`.
  **Confirm** no other live code uses a `gen:` prefix.

## 4. Mapping to the existing single-writer contract

### 4.1 How the new design preserves RULE-8A

| Resource | Today's writer(s) | Phase-2 writer | Compliance |
|---|---|---|---|
| `TDS_Run_Manifest.json` | (none) | Generation Publisher | New resource; one writer. |
| `TDS_Master.<gen>.json` | `Finaliser.js:155`, `Gatekeeper.js:56`, `API_Parser.js:33`, `Alpha.js:392` (clear) | Generation Publisher | All four writes removed; Finaliser and the Publisher are merged under the Publisher role. Alpha no longer clears. |
| `Itin_Master.<gen>.json` | `Compiler.js:452`, `Alpha.js:393` (clear) | Generation Publisher | Both writes removed; Compiler and the Publisher are merged. Alpha no longer clears. |

The "Generation Publisher" is a logical role (spec §15). Today it is
physically split between `Finaliser.js` (events → `TDS_Master.json`)
and `Compiler.js` (events → `Itin_Master.json`). Phase 2 must collapse
this into a single entry point. Two options:

- **A. New file `Generation_Publisher.js`** that Finaliser and
  Compiler both call into, owning the manifest write and the versioned
  filename scheme. Smaller scripts delegate the final
  `writeFile("Tasker/Tesla/Data/TDS_Master.<gen>.json", ...)` and
  `writeFile("Tasker/Tesla/Data/Itin_Master.<gen>.json", ...)` calls.
  Alpha.js is updated to call the Publisher's `start()` instead of
  clearing.

- **B. Promote `Compiler.js` to the Publisher role** and have
  `Finaliser.js` return its staged events as a `setLocal` payload
  that Compiler serialises. Smaller diff (no new file), but
  `Compiler.js`'s existing responsibility ("compile whole generation;
  fallback duration; once-only stops; stage output") is already long.

**Recommendation direction:** Option A. The Publisher is its own
concept (spec §1D: "validate/commit complete generations"); a
dedicated file is the smallest mismatch with the spec's role model.

### 4.2 Read path for non-writers

The Override Handler, Manual Action Handler, Route Cache Manager, and
other RULE-8B/8C/8D/8E owners do not write masters, but they DO read
them (e.g. `Override_Injector.js:14` reads `Itin_Master.json` for
`targetEventId`). Phase 2 changes their read path:

| Script | Today | Phase 2 |
|---|---|---|
| `Dashboard.js:17` | `readFile("Tasker/Tesla/Data/Itin_Master.json")` | Read manifest, then read `Itin_Master.<activeGen>.json`. If manifest is missing or `state !== "committed"`, render empty. |
| `Dispatcher.js:85` | `readFile("Tasker/Tesla/Data/Itin_Master.json")` | Same as Dashboard. |
| `Override_Injector.js:14` | `readFile("Tasker/Tesla/Data/Itin_Master.json")` | Same. |
| `Finaliser.js:181` | `readFile("Tasker/Tesla/Data/Itin_Master.json")` | Read manifest, then read the prior generation's itinerary (for drop-in dedup). |
| `Depart_Now.js:8`, `Return_to_Base.js:57` | `readFile("Tasker/Tesla/Data/Itin_Master.json")` | Same. |
| `Compiler.js:191` | `readFile("Tasker/Tesla/Data/Itin_Master.json")` (prior itinerary) | Read manifest, read `Itin_Master.<prevGen>.json` (the prior generation for ASAP/JIT deltas). |
| `Sandbox_Engine.js:380, 516` | `readFile("Tasker/Tesla/Data/Itin_Master.json")` (legacy itinerary) | Same. |
| `Compiler.js:126`, `Sandbox_Engine.js:270` | `readFile("Tasker/Tesla/Data/TDS_Master.json")` | Read manifest, read `TDS_Master.<activeGen>.json` (events). |
| `Gatekeeper.js:37`, `API_Parser.js:17` | `readFile("Tasker/Tesla/Data/TDS_Master.json")` | Same. **Plus:** they must stop writing at lines 33/56. The decision of how the reorder is applied belongs to the Publisher. |

**Implication:** a single `readActiveGeneration()` helper in
`TDS_Helper.js` (or in the new `Generation_Publisher.js`) returning
`{ activeGeneration, master, itin, manifest }` would centralise the
read pattern. This prevents the "one reader forgot to read the
manifest" bug class.

### 4.3 Generation ID propagation into the §17 log

Every `flash(JSON.stringify({ ..., generationId: null, ... }))` site
must be updated to use the real `generationId` once it is minted.
There are 11 such sites in the live code:

| File:Line | Component | Phase 2 change |
|---|---|---|
| `Compiler.js:50` | `"Compiler"` | Use the Publisher's `activeGeneration` |
| `Sandbox_Engine.js:281` | `"Sandbox"` | Use the Publisher's `activeGeneration` |
| `Sandbox_Engine.js:462, 533, 1027, 1041, 1361` | `"Sandbox"` | Same |
| `API_Parser.js:99, 139` | `"API_Parser"` | Same (read from manifest or local set by Publisher) |
| `ID_Parser.js:37` | (component) | Same |
| `Dispatcher.js:123, 139, 156, 348` | `"Dispatcher"` | Same (read from manifest) |
| `Override_Handler.js:36` | `"Override_Handler"` | Same |

The cleanest path: the Publisher exposes the `generationId` as a
`setGlobal('TDS_Active_Generation', ...)` at the start of its run,
and every `flash()` site reads
`global('TDS_Active_Generation')`. (Or, every `flash()` site is
updated to take a `generationId` argument from the Publisher's local
context.) Both are proposal-phase decisions.

## 5. What this exploration does NOT decide

- The chosen manifest schema fields (proposal phase). The
  recommendation is "spec literal + `schemaVersion` +
  `previousGeneration` + path fields + `state`", but the proposal
  may justify a different subset.
- The migration sequence (proposal/design phase). Cut-over all
  readers in one change vs. parallel-run window.
- The actual `writeFile` primitive and torn-write recovery
  (design phase, after verifying Tasker runtime). The exploration
  assumes the existing `writeFile` is single-shot per call; the
  design must confirm with the user.
- The file-naming scheme for the versioned files. Spec uses
  `TDS_Master.<generationId>.json` and `Itin_Master.<generationId>.json`
  with the `gen:`-prefixed generationId embedded. A colon in a
  filename is unusual; confirm with the user.
- The garbage-collection policy (proposal phase).
- Whether `TDS_Events.<gen>.json` is created in Phase 2 (proposal
  phase).
- How the cluster-reorder path (Gatekeeper, API_Parser) is migrated
  to the Publisher (proposal phase).
- Whether the generationId is propagated via `setGlobal` or via a
  Publisher-injected argument (proposal phase).

## 6. Affected areas

- **New file:** `Generation_Publisher.js` (recommended) or
  `Publisher.js`. Owns the manifest write, the versioned filename
  scheme, and the single-writer invariant.
- **New file:** `Tasker/Tesla/Data/TDS_Run_Manifest.json`. Written
  by the Publisher.
- **New file pattern:** `Tasker/Tesla/Data/TDS_Master.<gen>.json`
  and `Tasker/Tesla/Data/Itin_Master.<gen>.json`. One pair per
  generation.
- **Removed writes:**
  - `Alpha.js:392, 393` — both `writeFile(... "[]" ...)` clears.
  - `Gatekeeper.js:56` — `writeFile("Tasker/Tesla/Data/TDS_Master.json", ...)`.
  - `API_Parser.js:33` — `writeFile("Tasker/Tesla/Data/TDS_Master.json", ...)`.
- **Migrated writes:**
  - `Finaliser.js:155` — moves into the Publisher; the file
    becomes `TDS_Master.<gen>.json`.
  - `Compiler.js:452` — moves into the Publisher; the file becomes
    `Itin_Master.<gen>.json`.
- **Migrated reads (manifest-first):** every read site in §1.2.
- **Generation ID propagation:** every `flash()` site with
  `generationId: null` (§4.3).
- **Harness:**
  - `harness/mock_tasker.js` — may need a `readDir` shim for GC
    tests; otherwise unchanged.
  - `harness/test_atomic_publication.js` — new. Asserts the
    Publisher is the sole writer of the versioned files and the
    manifest; asserts the prior generation is preserved on failure;
    asserts every reader follows the manifest.
  - `harness/test_manifest_swap.js` (recommended) — new. Asserts
    reader behaviour during a publish: a reader mid-flight during
    the manifest write sees either the old or the new generation,
    never a torn state.
  - `harness/test_generation_id_propagation.js` (recommended) —
    new. Asserts every `flash()` site carries the real
    `generationId`, not `null`.
- **No touch:** `Override_Handler.js`, `Override_Injector.js`,
  `Appender.js`, `Default.js`, `Stop_Logger.js`,
  `TDS_Manual_Trips.json`, `TDS_Action_Sessions.json`,
  `TDS_Route_Cache.json`, `TDS_Order_Cache.json`,
  `TDS_Overrides.json`, `TDS_Routine_Preferences.json`. These are
  out of Phase 2's scope (Phases 3–5 own them).

## 7. Summary

Phase 2 introduces a versioned, atomic publication model per spec §7
and RULE-8A. The current state is "one master per resource, four
writers, no manifest, and `generationId: null` everywhere"; the
target state is "one versioned file per resource, one writer
(Generation Publisher), one manifest as the atomic switch, and the
real `generationId` propagated to every `flash()` site." The design
space is well-bounded: `gen:<unix>:<hex>` for `generationId`,
replaceable manifest written last, no rename primitive available, GC
by a named `MAX_GENERATIONS_KEPT` constant. The highest-risk areas
are the cluster-reorder writers (Gatekeeper, API_Parser) and the
single-shot `writeFile` contract on Tasker. The workload is
substantial (12 file sites in §1.1, 10 read sites in §1.2, 11 log
sites in §4.3, 1 new file, 1 new manifest, 3–4 new harness tests);
chained PRs may be appropriate.

## 8. Ready for proposal

**Yes.** The exploration surfaces the full design space, the risks,
and the open questions. The proposal phase can pick (a) the manifest
schema fields, (b) the migration sequence (cut-over vs. parallel
run), (c) the GC policy, (d) whether `TDS_Events.<gen>.json` is in
or out of scope, and (e) how the cluster-reorder path migrates to
the Publisher. The design phase owns the `writeFile` torn-write
recovery and the filename-with-colon convention.
