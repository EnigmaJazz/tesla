## 1. Goal

Slice 3 delivers AC-3, AC-5, and AC-7 and makes day-boundary math DST-safe through UTC helpers across 13 sites. PR-A is the DST fix; PR-B is the manual-return signal plus AC-5. The chain is PR-A → PR-B within the 400-line review budget.

## 2. PR-A — DST fix

### 2.1 A.1 — UTC day-comparison helper

`Alpha.js:60-65` has drifted and now contains cache iteration. The live day code is:

```javascript
function getTodayStr() {
    let d = new Date();
    let mm = (d.getMonth()+1 < 10 ? '0' : '') + (d.getMonth()+1);
    let dd = (d.getDate() < 10 ? '0' : '') + d.getDate();
    return d.getFullYear() + "-" + mm + "-" + dd;
}
if (lastSyncDate !== todayStr) {
```

Define identically in affected scripts and `harness/day_utils.js`:

```javascript
const SECONDS_PER_DAY = 86400;
function isSameUTCDay(a, b) {
    const dA=new Date(a*1000),dB=new Date(b*1000);
    return dA.getUTCFullYear()===dB.getUTCFullYear() && dA.getUTCMonth()===dB.getUTCMonth() && dA.getUTCDate()===dB.getUTCDate();
}
function utcDayBoundaryUnix(unixSec) {
    const d=new Date(unixSec*1000);
    return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())/1000;
}
```

### 2.2 A.2 — Replace 13 DST-unsafe sites

Five policy sites change; eight non-boundary sites remain unchanged.

| # | Site | Before → after |
|---|---|---|
| 1 | `Alpha.js:15-20,182-187` | `lastSyncDate !== todayStr` → parse Unix, compare with `isSameUTCDay`, store UTC boundary; legacy values migrate once. |
| 2 | `Alpha.js:108-110` | local cache bucket → unchanged; metadata, not boundary. |
| 3 | `Sandbox_Engine.js:108-119` | local `getDayPrefix` → unchanged; display label. |
| 4 | `Sandbox_Engine.js:257-258,712` | local seven-day end → `utcDayBoundaryUnix(nowSec)+8*SECONDS_PER_DAY-1`; live code is unsafe. |
| 5 | `Sandbox_Engine.js:792` | `< 43200` → unchanged; duration. |
| 6 | `Sandbox_Engine.js:1263-1285` | `distToEndBase > 200` → unchanged; distance. |
| 7 | `Finaliser.js:60-62` | two `setHours(...)`, then equality → `isSameUTCDay(ev.start,nowSec)`. |
| 8 | `Finaliser.js:117-120` | `< 43200` → unchanged; duration. |
| 9 | `Finaliser.js:201-237` | `veEnd <= nowSec` → unchanged; instant expiry. |
| 10 | `Compiler.js:183-200` | `hardFloor = prevEnd + ...` → unchanged; Unix arithmetic. |
| 11 | `Compiler.js:324-329` | local-midnight difference → UTC-boundary difference / `SECONDS_PER_DAY`. |
| 12 | `Dispatcher.js:159-161` | `d1 !== d2` via `getDate()` → `!isSameUTCDay(lastArrive,nextDep)`. |
| 13 | `Dashboard.js:52-112,436-450` | local grouping/rendering → unchanged; read-only display. |

### 2.3 A.3 — DST test fixtures

`harness/test_dst_utc.js` uses the harness bootstrap:

```javascript
process.env.TZ = 'Europe/London';
const { isSameUTCDay, utcDayBoundaryUnix } = require('./day_utils');
[['2026-10-25T00:30:00Z','2026-10-25T01:30:00Z'],
 ['2027-03-28T00:30:00Z','2027-03-28T01:30:00Z']].forEach(([a,b]) => {
  assert.equal(isSameUTCDay(Date.parse(a)/1000, Date.parse(b)/1000), true);
  assert.equal(utcDayBoundaryUnix(Date.parse(b)/1000), Date.parse(b.slice(0,10)+'T00:00:00Z')/1000);
});
assert.equal(isSameUTCDay(Date.parse('2026-10-25T23:59:59Z')/1000, Date.parse('2026-10-26T00:00:00Z')/1000), false);
const row = runSandboxCompilerFixture({ now:'2026-10-25T00:30:00Z', evStart:'2026-10-25T01:30:00Z' });
assert.equal(row.policy, 'JIT');
assert.equal(row.crossDayBreak, false);
```

## 3. PR-B — Manual-return signal + AC-5

### 3.1 B.1 — `setGlobal` in `Return_to_Base.js`

```javascript
itinerary.unshift(returnLeg);
writeFile(itinFile, JSON.stringify(itinerary), false);
setGlobal('TDS_Manual_Return_Completed', nowSec.toString());
```

### 3.2 B.2 — Sandbox reads the global and applies the override

After the existing `state.loc` rebind, establish a one-shot override before the policy block:

```javascript
const manualReturnCompletedUnix = parseInt(global('TDS_Manual_Return_Completed'), 10) || 0;
const priorDayManualReturn = manualReturnCompletedUnix > 0 && !isSameUTCDay(manualReturnCompletedUnix, nowSec);
if (priorDayManualReturn) { simAtBase = true; state.loc = getBase(state.time).coords; state.isStableOrigin = true; }
// In the loop:
const forceFutureJIT = priorDayManualReturn && queue.length === 0 && isSameUTCDay(evStart, nowSec);
if (forceFutureJIT) return "JIT"; // first legPolicy rule
```

After enqueueing the head, flash and clear the signal:

```javascript
flash(JSON.stringify({timestamp:nowSec,generationId:null,component:"Sandbox",severity:"INFO",code:"FUTURE_TRIP_NOT_DUE",tripId:evId,details:{manualReturnCompletedUnix,nextDayFirstTripPolicy:"JIT"}}));
setGlobal('TDS_Manual_Return_Completed', '');
```

### 3.3 B.3 — AC-5 test

`harness/test_ac5.js` copies the AC-6 fixture:

```javascript
globals.Current_Status = 'Driving (Heading Home)';
globals.TDS_Manual_Return_Completed = String(nowSec - SECONDS_PER_DAY);
runScript(sandboxPath, sandbox, store);
const head = store.locals.block_queue.split('~')[0].split('|');
assert.equal(head[7], 'DEPART');
assert.ok(Number(head[5]) > nowSec); // future/PLANNED
assert.equal(head[head.length - 1], 'JIT');
assert.equal(store.locals.block_step19, 'JIT');
assert.ok(store.flashLog.some(x => x.includes('FUTURE_TRIP_NOT_DUE')));
```

### 3.4 B.4 — `EVT-SYNTHETIC_RETURN_SUPPRESSED`

Existing empty-day skip:

```javascript
if (idx > master.length) {
    setLocal('block_queue', "EOF");
```

Before EOF, when `master.length === 0 && global('User_At_Base') !== "true"`, flash `{"timestamp":nowSec,"generationId":null,"component":"Sandbox","severity":"INFO","code":"SYNTHETIC_RETURN_SUPPRESSED","tripId":null,"details":{"reason":"no_planned_activity_today","userAtBase":false}}`.

## 4. Cross-cutting concerns

- **GGA review**: review each PR against `AGENTS.md`; `SECONDS_PER_DAY` avoids new magic numbers.
- **DST regression risk**: UTC policy math protects AC-3/AC-7; tests cover both transitions.
- **Transient state**: the global is not persistent JSON. Convention: `Return_to_Base.js` produces it; Sandbox consumes and clears it once.
- **Decisions**: inline helpers because Tasker has no module loader; retain local Dashboard presentation.

| Threat boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no classification. |
| Git repository selection | N/A — no Git. |
| Commit state | N/A — no commits. |
| Push state | N/A — no pushes. |
| PR commands | N/A — no PR commands. |

## 5. Test plan (manual, since no test runner for the device)

- After PR-A: run both UK-transition fixtures; Sandbox and Dispatcher follow UTC boundaries.
- After PR-B: complete a manual return yesterday; today’s head remains `PLANNED`/`JIT`, with `EVT-FUTURE_TRIP_NOT_DUE` visible.

## 6. Open questions for tasks phase

- Confirm one signal producer (`Return_to_Base.js`) and one consumer/clearer (`Sandbox_Engine.js` at pass start).
- Keep event emission as `flash(JSON.stringify(...))`, matching slices 1/2; defer persistent structured logging to Phase 2 rather than introducing `setLocal` now.
