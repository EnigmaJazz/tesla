# Tasker Tesla — Node Test Harness

A plain-Node harness that mocks the Tasker runtime primitives
(`local`, `setLocal`, `global`, `setGlobal`, `readFile`, `writeFile`,
`flash`, pinned `Date`) so the production Tasker scripts can run in
a `vm` sandbox and be exercised with synthetic data. No `npm install`,
no dependencies, no build step. The production `.js` files are not
modified — the harness only adapts to them.

## Why

The scheduler runs inside Tasker's JSlet engine, not Node. Each
script calls Tasker primitives that don't exist in Node, so the
scripts cannot be required directly. A `vm` sandbox with mocked
primitives lets the test observe behaviour through side effects
(`setLocal`, `writeFile`, `flash`) without touching the live device.

## Layout

```
harness/
  mock_tasker.js   # createSandbox({ locals, globals, files, nowMs }) → { sandbox, store }
  runner.js        # runScript(scriptPath, sandbox, store) — reads + runs in vm context
  test_compiler_ac8.js            # AC-8: stop padding applied once
  test_dispatcher_ac9.js          # AC-9: overdue-within-window ranks below future; future leg selected
  test_dispatcher_ac10.js         # AC-10: empty master → idle sync at 60 min
  test_dispatcher_relevance.js    # INV-0.6: truly stale leg rejected; idle sync at 60 min
  test_dispatcher_overdue_wins.js # INV-0.6: overdue-within-window selected when no future leg exists
  test_sandbox_ac6.js             # AC-6: stale-away itinerary loses to live base; future trip JIT
  test_compiler_ac1.js            # AC-1: Compiler consumes explicit block_step19 departure policy
  test_dst_utc.js                 # DST-safe UTC day-boundary helpers
  day_utils.js                    # Shared UTC helpers for DST tests
  README.md        # this file
```

## Running

From the project root:

```
node harness/test_compiler_ac8.js
node harness/test_dispatcher_ac9.js
node harness/test_dispatcher_ac10.js
node harness/test_dispatcher_relevance.js
node harness/test_dispatcher_overdue_wins.js
node harness/test_sandbox_ac6.js
node harness/test_compiler_ac1.js
node harness/test_dst_utc.js
```

Each test prints `PASS:` or `FAIL:` with a single-line reason and
exits 0/1. Run all eight with a loop:

```
for t in harness/test_*.js; do node "$t" || break; done
```

## Adding a test

1. Pick the acceptance criterion from `openspec/changes/tasker-tesla-upgrade/specs/itinerary/spec.md`.
2. Read the production script to confirm the `local()` / `global()` keys,
   file paths, and output contracts the script uses. Do not edit the
   script.
3. Create `harness/test_<script>_<ac>.js`:
   - `process.env.TZ = 'UTC'` at the top so `Date` math is reproducible.
   - `const { createSandbox } = require('./mock_tasker');`
   - `const { runScript } = require('./runner');`
   - Build `locals`, `globals`, `files` objects that match what the
     production script reads. Pass `nowMs` (ms) to pin `Date.now()`.
   - `createSandbox({...})` returns `{ sandbox, store }`. Pass both
     to `runScript(scriptPath, sandbox, store)`.
   - Inspect `store.locals`, `store.globals`, `store.files`,
     `store.flashLog`, and `store.runError` (set if the script threw).
4. Use `node:assert/strict` for assertions. End with
   `console.log('PASS: ' + testName)` or `console.log('FAIL: ' + ...)`,
   followed by `process.exit(0)` or `process.exit(1)`.

## Coverage (first slice)

| Test                          | What it verifies                                |
| ----------------------------- | ----------------------------------------------- |
| `test_compiler_ac8.js`        | `pendingStopsRaw="5,10"` → `durationSecs`=1800, next-leg gap = 900s |
| `test_dispatcher_ac9.js`      | overdue-within-window ranks below future; future leg selected; `Next_Sync` = +30 min bucket |
| `test_dispatcher_ac10.js`     | empty master → `IDLE_SYNC_ENGAGED`; `Next_Sync` = +60 min |
| `test_dispatcher_relevance.js` | truly stale leg rejected with `STALE_TRIP_REJECTED`; `IDLE_SYNC_ENGAGED`; `Next_Sync` = +60 min |
| `test_dispatcher_overdue_wins.js` | overdue-within-window selected when no future leg exists; `Next_Sync` = +10 min |
| `test_sandbox_ac6.js`             | stale `handled` itinerary + live `User_At_Base="true"` emits `LIVE_BASE_OVERRIDES_LEGACY_ORIGIN`; head leg policy = `JIT` |
| `test_compiler_ac1.js`            | `block_step19="ASAP"` → `departUnix` = `hardFloor`; `block_step19="JIT"` → `departUnix` = `Math.max(hardFloor, depTarget)`; no fallback flash |
| `test_dst_utc.js`                 | UTC day-boundary helpers; Dispatcher breaks multi-waypoint chains at UTC midnight, not local midnight |

## Known issues

None at the time of writing. The `targetDrive.depUnix` typo that the
harness originally caught was fixed in Patch B' and `test_dispatcher_ac9.js`
was tightened to assert the 30-min bucket. See the commit message of
that patch for the line-level change.

## Notes

- The mock treats every value passed to `setLocal`, `setGlobal`, and
  `writeFile` as a string (Tasker does this). The test passes numbers
  to those calls only for legibility; the sandbox stringifies.
- `Date` is wrapped so `Date.now()` returns the pinned `nowMs`, but
  `new Date(ms)` still constructs a real `Date` (so the dispatcher's
  `getHours()`/`getMinutes()` still work). Methods like `setHours`
  operate on the underlying `Date.prototype` and return ms offsets.
- `parseInt`, `parseFloat`, `isNaN`, `Math`, `JSON`, `console`,
  `Object`, `Array`, `String`, `Number`, `Boolean` are passed through
  to the real Node globals. The script uses these; without them the
  sandbox would crash on the first `parseInt`.
