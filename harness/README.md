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
  test_compiler_ac8.js    # AC-8: stop padding applied once
  test_dispatcher_ac9.js  # AC-9: stale past leg rejected; future leg selected
  test_dispatcher_ac10.js # AC-10: empty master → idle sync at 60 min
  README.md        # this file
```

## Running

From the project root:

```
node harness/test_compiler_ac8.js
node harness/test_dispatcher_ac9.js
node harness/test_dispatcher_ac10.js
```

Each test prints `PASS:` or `FAIL:` with a single-line reason and
exits 0/1. Run all three with a loop:

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
| `test_dispatcher_ac9.js`      | past leg rejected with `STALE_TRIP_REJECTED`; future leg selected |
| `test_dispatcher_ac10.js`     | empty master → `IDLE_SYNC_ENGAGED`; `Next_Sync` = +60 min |

## Known issues

`Dispatcher.js` references `targetDrive.depUnix` (line 235 and 248)
but the master entries carry `targetDrive.departUnix`. With the typo
`Math.floor((undefined - nowSec) / 60) = NaN`, so the bucket
selection falls through into the SOON bucket (`syncIntervalMins = 10`).
The harness asserts the actual current behaviour and labels the
non-bucket result. Fix the typo in `Dispatcher.js` and update
`test_dispatcher_ac9.js` if you want the test to lock in the
correct bucket.

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
