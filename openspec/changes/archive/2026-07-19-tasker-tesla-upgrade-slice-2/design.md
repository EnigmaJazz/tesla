## 1. Goal

Slice 2 delivers AC-1/AC-6 through queue column 19, `block_step19`, and pass-start live origin.

## 2. Patch D — `Sandbox_Engine.js`

### 2.1 D.1 — Live origin at pass start

Current `Sandbox_Engine.js:434-450`:

```javascript
                ssdTier.push({ o: sp[0].trim(), d: sp[1].trim(), m: sp[2].trim(), meanDur: parseInt(sp[3], 10), updatedSec: parseInt(sp[5], 10), tod: parseInt(sp[7], 10), dayType: parseInt(sp[8], 10) });
            }
        }

        let simAtBase = false;
        let oldItinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
        if (oldItinRaw.indexOf("%") === 0) oldItinRaw = "[]";
        let oldItin = []; try { oldItin = JSON.parse(oldItinRaw); } catch(e){}
        // BUG: live origin only consulted when oldItin is empty; INV-0.3 violated when stale itinerary says away.
        if (oldItin.length > 0) {
            let aLeg = oldItin[oldItin.length - 1];
            if (aLeg.mode === "EOD_RETURN" || aLeg.pitstopState === "end_of_day" || aLeg.pitstopState === "forced" || aLeg.pitstopState === "handled" || (aLeg.targetEventId || "").indexOf("_IN") !== -1) {
                simAtBase = true;
            }
        } else {
            simAtBase = (global('User_At_Base') === "true");
        }
```

Proposed:

```javascript
const liveAtBase = (global('User_At_Base') === "true");
const activeInProgress=/^(Driving|Walking|Public Transport|Lift)/i.test(incomingStatus);
const priorLeg=oldItin.length?oldItin[oldItin.length-1]:null;
const priorSimAtBase=!!priorLeg&&(priorLeg.mode==="EOD_RETURN"||priorLeg.pitstopState==="end_of_day"||/_IN$/.test(priorLeg.targetEventId||""));
simAtBase=priorSimAtBase;
if(activeInProgress)simAtBase=false; // Active destination binding is deferred.
else if(liveAtBase){
    if(priorLeg&&!priorSimAtBase)flash(JSON.stringify({timestamp:nowSec,generationId:null,component:"Sandbox",severity:"WARN",code:"LIVE_BASE_OVERRIDES_LEGACY_ORIGIN",tripId:null,details:{oldItinLength:oldItin.length,userAtBase:"true",priorSimAtBase:false}}));
    simAtBase=true;
}
```

### 2.2 D.2 — Emit `departurePolicy` as the 19th queue column

Current `Sandbox_Engine.js:1184-1190`:

```javascript

            let displayTime = (ev.isDropin && isAttachedDropin) ? Math.max(state.time, openUnix) : evStart;
            let safeDesc = encodeURIComponent(evDesc);
            let dropinStatusFlag = (ev.isDropin && isAttachedDropin) ? "attached_dropin" : (isNormalStrict ? "detached_strict" : "none");
            
            queue.push("EVENT|" + evTitle + "|" + evCoords + "|" + routeToEv.mode + "|" + displayTime + "|" + trueDepartureTime + "|" + pitstopState + "|" + apiTimeType + "|" + apiTimeUnix + "|" + evId + "|" + evLoc + "|" + engineLateMins + "|" + currentLegStable + "|" + dropinStatusFlag + "|" + safeDesc + "|" + adHocObj.arr.join(","));
            
```

The source has 16 fields. Reserve 17–18; route planned rows through:

```javascript
function enqueueLeg(fields,policy){
    while(fields.length<18)fields.push("");
    fields.push(policy);queue.push(fields.join("|"));
    if(queue.length===1)setLocal('block_step19',policy);
}
const legPolicy=(apiTimeType==="ACTIVE_TRAVEL"||!isPrevBase||isAttachedDropin||trueDepartureTime<=nowSec)?"ASAP":"JIT";
enqueueLeg(["EVENT",evTitle,evCoords,routeToEv.mode,displayTime,trueDepartureTime,pitstopState,apiTimeType,apiTimeUnix,evId,evLoc,engineLateMins,currentLegStable,dropinStatusFlag,safeDesc,adHocObj.arr.join(",")],legPolicy);
```

Recovery, return/EOD, manual, due/in-progress, between-event, and attached rows use ASAP; first/base/future post-overnight rows use JIT. ASAP promotes its chain.

### 2.3 Why this is safe

- D.1 runs at pass start; mid-pass flips propagate next pass. Flash audits overrides.
- D.2 preserves fields 1–16 and reserves 17–18; the Tasker splitter MUST change atomically.
- Head `block_step19` protects the transition.

### 2.4 AC-6 test

Seed stale `handled`, live base, home coordinates, unexpired base, future event, and pinned time. Assert no throw, flash, queue home origin `[2]`, policy `[18]`.

## 3. Patch E — `Compiler.js`

### 3.1 E.1 — Consume `block_step19`

Current `Compiler.js:245-260`:

```javascript
        let actualHeadDeparture;
        
        // BUG: leaveASAP reconstructed from isPrevBase which is reconstructed from pitstopState/_IN/EOD_RETURN; spec §0.1 forbids silent inference.
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
        let outStarts = []; 
```

Proposed; store policy on `currentLeg` and the published leg:

```javascript
const rawPolicy=(local('block_step19')||"").toUpperCase().trim();
if(!rawPolicy)flash(JSON.stringify({timestamp:nowSec,generationId:null,component:"Compiler",severity:"WARN",code:"DEPARTURE_POLICY_FALLBACK_USED",tripId:evId||null,details:{block_step19:null,reconstructed:"ASAP"}}));
currentLeg.departurePolicy=rawPolicy||"ASAP";
const chainForcesASAP=pendingChain.some(leg=>leg.departurePolicy==="ASAP"||leg.actionType==="EOD_RETURN"||leg.mode==="EOD_RETURN");
const leaveASAP=headLeg.departurePolicy==="ASAP"||chainForcesASAP;
actualHeadDeparture=(leaveASAP||headLeg.apiType==="ACTIVE_TRAVEL")?hardFloor:Math.max(hardFloor,headLeg.depTarget);
```

Add `departurePolicy:leg.departurePolicy` at `Compiler.js:402-418`.

### 3.2 E.2 — Remove `isPrevBase` reconstruction

Current `Compiler.js:158-172`:

```javascript
            hardFloor = prevArr + 60; 
            
            // BUG: silent state inference; the previous leg's pitstopState/_IN/EOD_RETURN are not authoritative for the next leg's policy.
            if (
                prevLeg.mode === "EOD_RETURN" ||
                prevLeg.pitstopState === "end_of_day" ||
                prevLeg.pitstopState === "forced" ||
                prevLeg.pitstopState === "handled" ||
                (prevLeg.targetEventId || "").indexOf("_IN") !== -1
            ) {
                isPrevBase = true;
            }
            
            let pId = prevLeg.targetEventId;
            let pEv = masterArr.find(e => (e.id || "DEFAULT") === pId);
```

Proposed:

```javascript
hardFloor=prevArr+60;
const previousPolicy=(prevLeg.departurePolicy||local('block_step19')||"ASAP").toUpperCase().trim(); // Metadata only.
let pId=prevLeg.targetEventId;
let pEv=masterArr.find(e=>(e.id||"DEFAULT")===pId);
```

Keep lines 173–204 unchanged. Legacy legs default to head policy, then ASAP.

### 3.3 Why this is safe

- E.1 consumes and persists the typed slot.
- E.2 preserves explicit `prevEnd`/`hardFloor` math.
- Missing policy safely becomes ASAP with an audit flash.

### 3.4 AC-1 test

Run ASAP/JIT fixtures. Assert `departUnix` equals `hardFloor` or `Math.max(hardFloor,depTarget)`; no fallback flash; legacy `handled` cannot force ASAP.

## 4. Cross-cutting concerns

- **External coupling**: atomically update the Tasker splitter or defer Patch D.
- **GGA**: review against `AGENTS.md`; `--no-verify` covers pre-existing flags.
- **Mid-pass flip**: next-pass propagation.
- **`originSource`**: Phase 1.

| Threat boundary | Applicability / RED test |
|---|---|
| Documentation-like paths | N/A — no classification |
| Git repository selection | N/A — no Git |
| Commit state | N/A — no commits |
| Push state | N/A — no pushes |
| PR commands | N/A — no PR automation |

## 5. Test plan (manual, since no test runner for the device)

- Patch D: stale-away plus live-base yields base origin and override flash.
- Patch E: ASAP uses `hardFloor`; JIT uses `Math.max(hardFloor,depTarget)`.

## 6. Open questions for tasks phase

- Confirm the Tasker splitter is in Patch D.
- Confirm per-leg queue policy; `pendingChain.some(...)` promotes the chain while head `block_step19` remains redundant.
