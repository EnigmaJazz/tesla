## 1. Goal

This first slice delivers AC-8, AC-9, and AC-10 through two small, ordered diffs: route-only duration in `Compiler.js`, then stale-departure containment and idle sync in `Dispatcher.js`.

## 2. Patch A — Compiler stop-padding fix

### 2.1 Current code excerpt

```javascript

            setLocal('api_duration_secs', duration.toString());
            setLocal('api_distance_miles', distMiles.toString());
        } else {
            duration = duration > 0 ? duration : 0; 
        }
    }

    let stopPadSecs = 0;
    let stopUiStr = "";

    if (pendingStopsRaw) {
        let pArr = pendingStopsRaw.split(",");
        for (let s = 0; s < pArr.length; s++) {
            if (!pArr[s]) continue;
            stopPadSecs += (parseInt(pArr[s], 10) * 60);
            stopUiStr += (stopUiStr ? ", " : "") + pArr[s] + "m";
        }

        // Preserve V24.16 behaviour.
        duration += stopPadSecs; // BUG: stopPadSecs counted twice
    }

    const nowSec = Math.floor(Date.now() / 1000);

    let masterRaw = readFile("Tasker/Tesla/Data/TDS_Master.json") || "[]";
    if (masterRaw.indexOf("%") === 0) masterRaw = "[]";

    let masterArr = [];
    try { 
        masterArr = JSON.parse(masterRaw); 
    } catch(e) {}

    let mEv = masterArr.find(e => (e.id || "DEFAULT") === evId);
    let evStartSecs = mEv ? parseInt(mEv.start, 10) : parseInt(local('block_step5'), 10) || nowSec;
    let dropinDur = mEv ? (parseInt(mEv.duration, 10) || 0) : 0;

    let isDepartEventLateCheck = /(#leave|#depart)\b/i.test((destName || "") + " " + targetDesc);

    let currentLeg = {
```

### 2.2 Forward-propagation excerpt

```javascript
        } else {
            tailLeg.depTarget = Math.max(
                vTime, 
                (tailLeg.apiType === "ARRIVE" ? tailLeg.apiUnix - tailLeg.durationSecs : tailLeg.apiUnix)
            );
        }

        for (let i = cLen - 2; i >= 0; i--) {
            let leg = pendingChain[i]; 
            let nextLeg = pendingChain[i + 1];

            let arrTarget = nextLeg.depTarget - leg.dropinDur - leg.stopPadSecs; // BUG: same stopPadSecs re-applied
            leg.depTarget = arrTarget - leg.durationSecs;
        }

        let headLeg = pendingChain[0];
        let actualHeadDeparture;
        
        let leaveASAP = false;
        if (!isPrevBase || headLeg.actionType === "EOD_RETURN") {
            leaveASAP = true;
        }

        if (leaveASAP || headLeg.apiType === "ACTIVE_TRAVEL") {
            actualHeadDeparture = hardFloor;
        } else {
            actualHeadDeparture = Math.max(hardFloor, headLeg.depTarget);
        }

        let currentUnix = actualHeadDeparture;
        let outTitles = []; 
```

```javascript
            if (delta >= 0) {
                if (leg.isDepart) {
                    leg.actualBuffer = 9999; 
                }
            } else {
                leg.actualLate = Math.ceil(Math.abs(delta) / 60);
                leg.actualBuffer = 0;
            }

            currentUnix = leg.actualArrival + (leg.dropinDur || 0) + leg.stopPadSecs; // BUG: same stopPadSecs re-applied

            newDepMem.push(leg.targetEventId + "~" + leg.actualDeparture);

            if (i === cLen - 1) {
                let oldD = null;

                if (depMemRaw.length > 2) {
                    let parts = depMemRaw.split(",");

                    for (let k = 0; k < parts.length; k++) {
                        let dp = parts[k].split("~");

```

### 2.3 Proposed change

Remove only the duration mutation; keep both gap calculations unchanged. Do not add `stopDurationSecs` in this schema-preserving slice.

```javascript
    let stopPadSecs = 0;
    let stopUiStr = "";

    if (pendingStopsRaw) {
        let pArr = pendingStopsRaw.split(",");
        for (let s = 0; s < pArr.length; s++) {
            if (!pArr[s]) continue;
            stopPadSecs += (parseInt(pArr[s], 10) * 60);
            stopUiStr += (stopUiStr ? ", " : "") + pArr[s] + "m";
        }
    }

    let arrTarget = nextLeg.depTarget - leg.dropinDur - leg.stopPadSecs;
    leg.depTarget = arrTarget - leg.durationSecs;

    currentUnix = leg.actualArrival + (leg.dropinDur || 0) + leg.stopPadSecs;
```

### 2.4 Why this is safe

- `durationSecs` feeds Compiler head-departure math, Dispatcher HVAC/NAV scheduling, and Dashboard display. Pure route time matches the spec; next-leg scheduling is unchanged because lines 241 and 308 remain.
- Sandbox `adHocObj.secs` is independent: it represents `#stop:NN` description markers, not `pendingStopsRaw`. This slice leaves it unchanged.
- The leg JSON shape is unchanged; only `durationSecs` decreases by `stopPadSecs`.

### 2.5 Acceptance test (AC-8)

For `pendingStopsRaw="5,10"`, before: `durationSecs = routeSecs + 900`. After: `durationSecs = routeSecs`; the following `depTarget` advances by 900 seconds, not 1,800.

## 3. Patch B — Dispatcher stale-departure containment + idle sync

### 3.1 Current code excerpt

```javascript
    try { masterRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]"; } catch(e) { masterRaw = "[]"; }
    
    if (masterRaw.indexOf("%") === 0 || masterRaw.trim() === "" || masterRaw === "undefined") {
        masterRaw = "[]";
    }
    var master = JSON.parse(masterRaw);

    var targetDrive = null;
    var driveIdx = -1;

    for (var i = 0; i < master.length; i++) {
        var trip = master[i];
        if (!trip) continue;
        
        var tripMode = (trip.mode || "").toUpperCase();
        var depUnix  = parseInt(trip.departUnix || trip.time || 0);

        // Locates the next valid active routing block within a 24-hour window
        if ((tripMode === "DRIVE" || tripMode === "EOD_RETURN" || tripMode === "WALK" || tripMode === "TRANSIT" || tripMode === "LIFT") && (depUnix - nowSec) <= 86400) { // BUG: past departure matches < 86400
            targetDrive = trip;
            driveIdx = i;
            break;
        }
    }

    if (targetDrive) {
        var dTime    = parseInt(targetDrive.departUnix || targetDrive.time || 0);
        var title    = targetDrive.targetTitle || targetDrive.loc || "Destination";
        var coords   = targetDrive.targetCoords || targetDrive.coords || "0,0";
        var coordArr = coords.split(',');
        var startVal = parseInt(targetDrive.arriveUnix || targetDrive.start || dTime);
```

```javascript
            }
        }
    } catch(e) {}

    if (isDriving) {
        isActionLocked = true;
    } else if (isAdHoc) {
        isActionLocked = false;
    }

    var syncIntervalMins = 120; 
    if (isActionLocked) {
        syncIntervalMins = 120; 
    } else if (master.length > 0) {
        var immediateHead = master[0]; 
        var headTimeSecs  = parseFloat(immediateHead.departUnix || immediateHead.time || immediateHead.start || 0);
        if (headTimeSecs > 0) {
            var gapMins = Math.floor((headTimeSecs - nowSec) / 60);
            if (gapMins > 180) syncIntervalMins = 120; 
            else if (gapMins > 60) syncIntervalMins = 60; 
            else if (gapMins > 30) syncIntervalMins = 30; 
            else syncIntervalMins = 3; // BUG: negative gapMins produces 3-min loop
        }
    }

    var nextSyncMs = Date.now() + (syncIntervalMins * 60000);
    var syncDate   = new Date(nextSyncMs);
    setGlobal('Next_Sync', (syncDate.getHours()<10?'0':'')+syncDate.getHours() + "." + (syncDate.getMinutes()<10?'0':'')+syncDate.getMinutes());

} catch(err) { flash("Dispatcher Fault: " + err.message); }
```

### 3.2 Proposed change

```javascript
const IDLE_SYNC_MINS = 60;
const LOCKED_SYNC_MINS = 120;
const FAR_SYNC_MINS = 120;
const MID_SYNC_MINS = 60;
const DUE_SYNC_MINS = 30;
const SOON_SYNC_MINS = 10;
const ACTIONABLE_LOOKAHEAD_SECS = 86400;
const FAR_SYNC_THRESHOLD_MINS = 180;
const MID_SYNC_THRESHOLD_MINS = 60;
const DUE_SYNC_THRESHOLD_MINS = 30;

let targetDrive;
let driveIdx = -1;
let skippedStale = 0;

for (let i = 0; i < master.length; i++) {
    const trip = master[i];
    if (!trip) continue;

    const tripMode = (trip.mode || "").toUpperCase();
    const depUnix = parseInt(trip.departUnix || trip.time || 0);

    if (depUnix < nowSec) {
        skippedStale++;
        emitDispatcherEvent(nowSec, "WARN", "STALE_DEPARTURE_REJECTED", trip.tripId || trip.targetEventId || null, {});
        continue;
    }

    if ((tripMode === "DRIVE" || tripMode === "EOD_RETURN" || tripMode === "WALK" || tripMode === "TRANSIT" || tripMode === "LIFT") && (depUnix - nowSec) <= ACTIONABLE_LOOKAHEAD_SECS) {
        targetDrive = trip;
        driveIdx = i;
        break;
    }
}

const selectedTimeSecs = targetDrive ? parseFloat(targetDrive.departUnix || targetDrive.time || targetDrive.start || 0) : 0;
let syncIntervalMins;

if (!targetDrive || selectedTimeSecs < nowSec) {
    syncIntervalMins = IDLE_SYNC_MINS;
    emitDispatcherEvent(nowSec, "INFO", "IDLE_SYNC_ENGAGED", null, { syncIntervalMins: IDLE_SYNC_MINS });
} else if (isActionLocked) {
    syncIntervalMins = LOCKED_SYNC_MINS;
} else {
    const gapMins = Math.floor((selectedTimeSecs - nowSec) / 60);
    if (gapMins > FAR_SYNC_THRESHOLD_MINS) syncIntervalMins = FAR_SYNC_MINS;
    else if (gapMins > MID_SYNC_THRESHOLD_MINS) syncIntervalMins = MID_SYNC_MINS;
    else if (gapMins >= DUE_SYNC_THRESHOLD_MINS) syncIntervalMins = DUE_SYNC_MINS;
    else syncIntervalMins = SOON_SYNC_MINS;
}
```

The existing `targetDrive` false branch clears action locals; no head fallback or new `setGlobal` key is added.

### 3.3 Logging

Dispatcher already uses `flash`; use it to emit JSON without adding a file writer or Tasker key:

```javascript
function emitDispatcherEvent(timestamp, severity, code, tripId, details) {
    flash(JSON.stringify({
        timestamp: timestamp,
        generationId: null,
        component: "Dispatcher",
        severity: severity,
        code: code,
        tripId: tripId,
        details: details
    }));
}
```

This yields the delta-spec shapes for `STALE_DEPARTURE_REJECTED` and `IDLE_SYNC_ENGAGED`; append-only persistence remains Phase 2.

### 3.4 Why this is safe

- Skip-and-continue preserves array order while allowing the second, future leg to satisfy AC-9.
- Idle removes the negative-gap three-minute path. A 30-minute gap remains 30 minutes; gaps below 30 use the 10-minute bucket.
- Events use `generationId: null` as required and identify Dispatcher plus the known trip ID.

### 3.5 Acceptance tests

- **AC-9:** With DRIVE departures at `nowSec - 3600` and `nowSec + 1800`, the old code selects leg 0 and syncs in 3 minutes; the new code logs its rejection, selects leg 1, and syncs in 30.
- **AC-10:** An empty master currently clears outputs but defaults to 120 minutes; an all-past master selects stale output and syncs in 3. Afterward, both clear action outputs, emit `IDLE_SYNC_ENGAGED`, and sync in 60.

## 4. Cross-cutting concerns

- **GGA review:** Named sync constants avoid new magic bucket values; neither patch writes the published itinerary directly or adds a silent fallback.
- **Sandbox `adHocObj.secs`:** Patch A does not change Sandbox stop handling; its interaction is a second-slice item.

| Threat-matrix boundary | Applicability |
|---|---|
| Documentation-like paths | N/A — no classification or execution change. |
| Git repository selection | N/A — no repository command. |
| Commit state | N/A — no VCS automation. |
| Push state | N/A — no push automation. |
| PR commands | N/A — no PR command composition. |

No threat-matrix RED tests apply; the in-process itinerary scan adds no shell, subprocess, executable-classification, or process-launch boundary.

### Out of scope

- DST-safe day boundaries.
- Existing `id.split("_")[0]` violations.
- Sandbox `adHocObj.secs` reconciliation, §6 ranking, and per-leg `relevanceDeadlineUnix`.

## 5. Test plan (manual, since no test runner)

- After Patch A, run an event with `#stop:5,#stop:5` or equivalent `pendingStopsRaw`; verify the next planned departure is 10 minutes after route-only ETA, not 20.
- After Patch B: (a) set leg 0 to `nowSec - 3600`; (b) empty the master; (c) set leg 0 to `nowSec + 600`. Record Tasker-observed `syncIntervalMins` and event JSON. Expect stale rejection plus future selection, idle 60, then the 10-minute bucket respectively.

## 6. Open questions for tasks phase

- Resolved: use `flash(JSON.stringify(event))`, the Dispatcher's existing diagnostic primitive; no new `setLocal`, `setGlobal`, or `writeFile` surface.
- Recommendation: keep `IDLE_SYNC_MINS` and the related bucket constants inline in `Dispatcher.js`; `TDS_Helper.js` remains read-only.
