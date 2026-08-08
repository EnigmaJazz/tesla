// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";
// Normalize: a dataRoot without a trailing slash would silently concatenate into
// invalid paths (R4-WARNING on the extraction refactor).
if (DATA_ROOT.charAt(DATA_ROOT.length - 1) !== "/") { DATA_ROOT += "/"; }

// ==========================================
// SCRIPT 4: UNIFIED COMPILER (v24.18)
// Translates multiple #stop:XX delays into physical Calendar travel blocks.
// Publishes the committed generation through the Generation_Publisher and
// exports pending stops for Tasker UI integration.
// [V24.18] Merged V24.17 Tasker-safe dummy array injection ("IGNORE")
//          while preserving V24.16 conflict detection, Hold/Flush JIT,
//          active-travel fallback recalculation, and stop padding behaviour.
// ==========================================

const SECONDS_PER_DAY = 86400;

// Phase 2: travel leg types whose route duration must be positive before
// publication. Zero-duration synthetic or placeholder legs are rejected.
const TRAVEL_API_TYPES = { DEPART: true, ARRIVE: true, ACTIVE_TRAVEL: true };

// INV-0.7: route distance conversion from metres to statute miles.
const METERS_TO_MILES = 0.000621371;
// Actionability relevance window: departures more than 18 hours out are not
// candidates for the depart-changed signal (named deadline, never a raw delta).
const RELEVANCE_WINDOW_SECS = 64800;
// Phase 4 Slice B (REQ-4SESSION-2): legacy lock freshness window for the
// migration-only fallback when the session store is absent/unreadable.
const LOCK_FRESH_SECS = 7200;

// Phase 5 (REQ-5QUEUE-1): typed queue envelope contract. block_queue is one
// JSON document {schemaVersion,rows,eof,skipIdxUntil,stepConflict,notifications};
// the Compiler JSON.parses it once inside its JSlet — Tasker Variable Split
// never processes it. Malformed JSON, an unsupported schema, or any invalid
// row rejects the whole queue without compiling partial rows (TYPED_QUEUE_REJECTED).
const TYPED_QUEUE_SCHEMA_VERSION = 1;
const TYPED_QUEUE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidTypedRow(row) {
    return !!row && typeof row === "object"
        && typeof row.rowType === "string" && row.rowType !== ""
        && typeof row.evId === "string" && row.evId !== ""
        && typeof row.title === "string"
        && typeof row.coords === "string"
        && typeof row.evLoc === "string"
        && typeof row.mode === "string"
        && typeof row.displayTime === "number"
        && typeof row.departTime === "number"
        && typeof row.pitstopState === "string"
        && typeof row.apiTimeType === "string"
        && typeof row.apiTimeUnix === "number"
        && typeof row.engineLateMins === "number"
        && typeof row.currentLegStable === "boolean"
        && typeof row.dropinStatusFlag === "string"
        && typeof row.safeDesc === "string"
        && Array.isArray(row.adHoc)
        && (row.routeDurationSecs === null || (typeof row.routeDurationSecs === "number" && row.routeDurationSecs > 0))
        && (row.routeDistanceMiles === null || (typeof row.routeDistanceMiles === "number" && row.routeDistanceMiles > 0))
        && (row.departurePolicy === "ASAP" || row.departurePolicy === "JIT")
        && typeof row.planningDay === "string"
        && (row.planningDay === "" || TYPED_QUEUE_DAY_RE.test(row.planningDay))
        && typeof row.originSource === "string";
}

function parseQueueEnvelope(raw) {
    let env = null;
    try { env = JSON.parse(raw); } catch (e) { env = null; }
    if (!env || env.schemaVersion !== TYPED_QUEUE_SCHEMA_VERSION || !Array.isArray(env.rows)) return null;
    // REQ-5QUEUE-1 (SCN-5QUEUE-1): controls MUST retain exact values.
    // eof is a boolean; skipIdxUntil is a non-negative integer;
    // stepConflict is null or a non-empty string; notifications is an array.
    if (typeof env.eof !== "boolean") return null;
    if (typeof env.skipIdxUntil !== "number" || !isFinite(env.skipIdxUntil) || env.skipIdxUntil < 0 || Math.floor(env.skipIdxUntil) !== env.skipIdxUntil) return null;
    if (env.stepConflict !== null && (typeof env.stepConflict !== "string" || env.stepConflict === "")) return null;
    if (!Array.isArray(env.notifications)) return null;
    for (let r = 0; r < env.rows.length; r++) {
        if (!isValidTypedRow(env.rows[r])) return null;
    }
    return env;
}

// Exact-token membership over a CSV row list (OVR-10): a row matches only when
// it equals the id or starts with "<id>~" — never a bare substring, so decoy
// occurrence IDs like ev_10 cannot satisfy an ev_1 lookup.
function csvHasExactToken(csv, id) {
    if (!csv || typeof id !== "string" || id === "") return false;
    const rows = csv.split(",");
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (row === id) return true;
        if (row.indexOf(id + "~") === 0) return true;
    }
    return false;
}

// INV-0.2: DST-safe day-boundary comparison. Both unixSec values are in UTC.
function isSameUTCDay(unixSecA, unixSecB) {
    const dA = new Date(unixSecA * 1000);
    const dB = new Date(unixSecB * 1000);
    return dA.getUTCFullYear() === dB.getUTCFullYear()
        && dA.getUTCMonth() === dB.getUTCMonth()
        && dA.getUTCDate() === dB.getUTCDate();
}

// INV-0.2: UTC midnight of the day containing unixSec (the "day boundary" in UTC).
function utcDayBoundaryUnix(unixSec) {
    const d = new Date(unixSec * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

function getDist(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const rLat1 = lat1 * Math.PI / 180; 
    const rLat2 = lat2 * Math.PI / 180;
    const dLat = (lat2 - lat1) * Math.PI / 180; 
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
              Math.cos(rLat1) * Math.cos(rLat2) * 
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSpeed(mode) {
    const map = { "WALK": 1.4, "TRANSIT": 8.0, "LIFT": 10.0, "DRIVE": 13.0 };
    return map[mode] || 1.4;
}

// Phase 2 hand-off: the Compiler no longer writes the live Itin_Master.json.
// It stages a complete generation candidate and delegates the commit to the
// Generation_Publisher. In Tasker the next action reads local('par1') and
// runs the publisher; in the test harness a sandbox.publish callback is
// available, so use it when present.
function publishCandidate(candidate) {
    // Phase 4 Slice B (REQ-4SESSION-2): sessions are authoritative. An active
    // session suppresses the heartbeat candidate; the legacy lock is honoured
    // only when the session store is absent/unreadable; an empty session map
    // means unlocked.
    if (actionLockActive()) {
        flash(JSON.stringify({
            timestamp: Math.floor(Date.now() / 1000),
            generationId: global('TDS_Active_Generation') || null,
            component: "Compiler",
            severity: "INFO",
            code: "ACTION_LOCKED",
            tripId: null,
            details: { reason: "active manual session suppresses heartbeat build" }
        }));
        return null;
    }
    setLocal('par1', JSON.stringify(candidate));
    if (typeof publish === 'function') {
        return publish(candidate);
    }
    return null;
}

// Phase 2 reader cutover: the Compiler assembles against the committed
// generation's master and itinerary when available, falling back to the
// legacy TDS_Master.json / Itin_Master.json while migration is in flight.
function readJson(path) {
    let raw = "";
    try { raw = readFile(path) || ""; } catch(e) {}
    if (!raw || raw.indexOf("%") === 0) return null;
    try { return JSON.parse(raw); } catch(e) { return null; }
}
function pathFor(g, kind) {
    return DATA_ROOT + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + String(g).replace(/:/g, "_") + ".json";
}
// Phase 3 PR-E: Local copy of readActiveGeneration. The canonical
// implementation lives in TDS_Helper.js. Kept local because Tasker
// scripts are standalone and cannot call functions from other scripts.
function readActiveGeneration(kind) {
    const m = readJson(DATA_ROOT + "TDS_Run_Manifest.json");
    const key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
    if (m && m.state === "committed" && m.activeGeneration) {
        const data = readJson(m[key] || pathFor(m.activeGeneration, kind));
        if (data !== null) return data;
    }
    if (m && m.previousGeneration) {
        const prev = readJson(pathFor(m.previousGeneration, kind));
        if (prev !== null) return prev;
    }
    if (kind === "events" || kind === "master") {
        const legacy = readJson(DATA_ROOT + "TDS_Master.json");
        if (legacy !== null) return legacy;
    }
    if (kind === "itinerary") {
        const legacyItin = readJson(DATA_ROOT + "Itin_Master.json");
        if (legacyItin !== null) return legacyItin;
    }
    return [];
}
// Phase 4 Slice B: session-primary action lock. Shared by the Compiler and
// Dispatcher readers (standalone copies). Active sessions/manual trips are
// authoritative; only absent/unreadable sessions permit honouring an
// unexpired legacy lock; a readable empty session map means unlocked.
function actionLockActive() {
    const now = Math.floor(Date.now() / 1000);
    const sessionsRaw = readFile(DATA_ROOT + "TDS_Action_Sessions.json") || "";
    if (sessionsRaw && sessionsRaw.indexOf("%") !== 0) {
        try {
            const sessions = JSON.parse(sessionsRaw);
            if (sessions && sessions.sessions && typeof sessions.sessions === "object") {
                const keys = Object.keys(sessions.sessions);
                for (let i = 0; i < keys.length; i++) {
                    const s = sessions.sessions[keys[i]];
                    if (s && s.status === "ACTIVE" && now <= parseInt(s.expiresAt, 10)) return true;
                }
                return false; // readable session map is authoritative: unlocked
            }
        } catch (e) { /* unreadable sessions fall through to the legacy lock */ }
    }
    try {
        const lockRaw = readFile(DATA_ROOT + "TDS_Action_Lock.json") || "";
        if (lockRaw && lockRaw.indexOf("%") !== 0 && lockRaw !== "{}") {
            const lock = JSON.parse(lockRaw);
            if (now - parseInt(lock.timestamp || 0, 10) < LOCK_FRESH_SECS) return true;
        }
    } catch (e) { /* no lock: unlocked */ }
    return false;
}

try {
    // Phase 5 (REQ-5QUEUE-1): parse + validate the typed queue envelope once.
    const envelope = parseQueueEnvelope(local('block_queue'));
    if (!envelope) {
        flash(JSON.stringify({
            timestamp: Math.floor(Date.now() / 1000),
            generationId: global('TDS_Active_Generation') || null,
            component: "Compiler",
            severity: "WARN",
            code: "TYPED_QUEUE_REJECTED",
            tripId: null,
            details: { reason: "malformed_json_unsupported_schema_or_invalid_row", queueHead: String(local('block_queue')).slice(0, 120) }
        }));
    } else {
        // REQ-5QUEUE-1 / SCN-5QUEUE-1 [EVT: TYPED_QUEUE_ACCEPTED]: a valid
        // envelope is accepted and its controls are retained for the pass.
        flash(JSON.stringify({
            timestamp: Math.floor(Date.now() / 1000),
            generationId: global('TDS_Active_Generation') || null,
            component: "Compiler",
            severity: "INFO",
            code: "TYPED_QUEUE_ACCEPTED",
            tripId: null,
            details: { rows: envelope.rows.length, eof: envelope.eof, skipIdxUntil: envelope.skipIdxUntil, stepConflict: envelope.stepConflict, notifications: envelope.notifications }
        }));
        const queueRows = envelope.rows || [];
        // REQ-5CUTOVER-2: the typed row fields are authoritative — the legacy
        // block_step17-21 split locals are retired and never read here.
        // [EVT: TYPED_QUEUE_CUTOVER_COMPLETED] is emitted once per pass below.
        let compiledRows = 0;
        for (let qi = 0; qi < queueRows.length; qi++) {
            compileTypedRow(queueRows[qi]);
            compiledRows++;
        }
        flash(JSON.stringify({
            timestamp: Math.floor(Date.now() / 1000),
            generationId: global('TDS_Active_Generation') || null,
            component: "Compiler",
            severity: "INFO",
            code: "TYPED_QUEUE_CUTOVER_COMPLETED",
            tripId: null,
            details: { compiledRows: compiledRows, legacyStepsRetired: true }
        }));
    }
} catch(e) { flash("Unified Engine Crash:\n" + e.message); }

// Phase 5: compile one typed row. Replaces the per-leg block_step1-21 local
// reads with explicit TypedRow fields.
function compileTypedRow(row) {
    const mode        = (row.mode || "WALK").toUpperCase().trim(); 
    const apiType     = (row.apiTimeType || "DEPART").trim(); 
    const dest        = (row.coords || "0,0").trim();
    const vTime       = parseInt(local('virtual_time'), 10) || Math.floor(Date.now() / 1000); 
    const evId        = (row.evId || "").trim(); 
    const apiUnix     = row.apiTimeUnix || vTime; 
    const actionType  = (row.rowType || "").trim(); 
    const destName    = (row.title || "Destination").trim();
    const targetDesc  = decodeURIComponent(row.safeDesc || "");
    const pendingStopsRaw = (Array.isArray(row.adHoc) ? row.adHoc.join(",") : "").trim();
    const isAttachedDropin = (row.dropinStatusFlag === "attached_dropin");

    let duration = parseInt(local('api_duration_secs'), 10);
    let distMiles = parseFloat(local('api_distance_miles')) || 0;

    // INV-0.7: metric fallback tiers — validated API metrics, then positive
    // typed Sandbox metrics (row.routeDurationSecs / row.routeDistanceMiles),
    // then a local haversine estimate for ACTIVE_TRAVEL only, else the leg
    // stays zero and is rejected as zero-duration. Every fallback logs
    // EVT-DEPARTURE_POLICY_FALLBACK_USED with {from,to,durationSecs,distanceMiles}.
    if (isNaN(duration) || duration <= 0 || isNaN(distMiles) || distMiles <= 0) {
        const sbDuration = (typeof row.routeDurationSecs === "number" && row.routeDurationSecs > 0) ? row.routeDurationSecs : NaN;
        const sbDistance = (typeof row.routeDistanceMiles === "number" && row.routeDistanceMiles > 0) ? row.routeDistanceMiles : NaN;
        if (!isNaN(sbDuration) && !isNaN(sbDistance)) {
            duration = sbDuration;
            distMiles = sbDistance;
            setLocal('api_duration_secs', duration.toString());
            setLocal('api_distance_miles', distMiles.toString());
            flash(JSON.stringify({
                timestamp: Math.floor(Date.now() / 1000),
                generationId: global('TDS_Active_Generation') || null,
                component: "Compiler",
                severity: "INFO",
                code: "DEPARTURE_POLICY_FALLBACK_USED",
                tripId: evId || null,
                details: { from: "API", to: "SANDBOX", durationSecs: duration, distanceMiles: distMiles }
            }));
        } else if (apiType === "ACTIVE_TRAVEL") {
            const orig = (global('User_Loc') || "0,0").trim(); 
            const oP = orig.split(","); 
            const dP = dest.split(",");

            const distM = getDist(
                parseFloat(oP[0]), 
                parseFloat(oP[1]), 
                parseFloat(dP[0]), 
                parseFloat(dP[1])
            );

            duration = Math.round(distM / getSpeed(mode));
            // Preserve positivity: one-decimal rounding turns a short but real
            // distance (e.g. 10 m) into 0.0, producing an incomplete metric
            // pair. Three decimals keeps short local estimates positive.
            distMiles = parseFloat((distM * METERS_TO_MILES).toFixed(3));

            setLocal('api_duration_secs', duration.toString());
            setLocal('api_distance_miles', distMiles.toString());
            flash(JSON.stringify({
                timestamp: Math.floor(Date.now() / 1000),
                generationId: global('TDS_Active_Generation') || null,
                component: "Compiler",
                severity: "INFO",
                code: "DEPARTURE_POLICY_FALLBACK_USED",
                tripId: evId || null,
                details: { from: "SANDBOX", to: "LOCAL_ESTIMATE", durationSecs: duration, distanceMiles: distMiles }
            }));
        } else {
            // Partial API metrics (one side valid, the other not) with no
            // later tier: the pair is incomplete, so the leg is rejected as
            // zero-duration rather than publishing with a partial metric
            // (INV-0.7 complete-metric contract).
            duration = 0;
            distMiles = 0;
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

        // stopPadSecs enters the next-leg gap at lines 241/308; durationSecs is route-only.
    }

    const nowSec = Math.floor(Date.now() / 1000);

    const masterArr = readActiveGeneration("master");

    let mEv = masterArr.find(e => (e.id || "DEFAULT") === evId);
    let evStartSecs = mEv ? parseInt(mEv.start, 10) : (row.departTime || nowSec);
    let dropinDur = mEv ? (parseInt(mEv.duration, 10) || 0) : 0;

    let isDepartEventLateCheck = /(#leave|#depart)\b/i.test((destName || "") + " " + targetDesc);

    let currentLeg = {
        targetEventId: evId,
        targetTitle: destName,
        targetDesc: targetDesc,
        targetCoords: dest,
        mode: mode,
        durationSecs: duration,
        distanceMiles: distMiles,
        pitstopState: row.pitstopState || "false",
        evStartSecs: evStartSecs,
        isDepart: isDepartEventLateCheck,
        transitStepsRaw: local('api_transit_steps') || "", 
        pendingStopsRaw: pendingStopsRaw,
        isAttachedDropin: isAttachedDropin,
        dropinDur: dropinDur, 
        stopPadSecs: stopPadSecs,
        stopUiStr: stopUiStr,
        apiType: apiType,
        actionType: actionType,
        apiUnix: apiUnix,
        planningDay: row.planningDay || null,
        originSource: row.originSource || null
    };

    let pendingCompilerRaw = readFile(DATA_ROOT + "Pending_Compiler.json") || "[]";
    if (pendingCompilerRaw.indexOf("%") === 0) pendingCompilerRaw = "[]";

    let pendingChain = []; 
    try { 
        pendingChain = JSON.parse(pendingCompilerRaw); 
    } catch(e) {}

    // INV-0.1: assign the explicit departure policy before storing the leg.
    // Attached chains are always ASAP per spec §0.1; non-attached heads carry
    // the typed row departurePolicy from the Sandbox (Phase 5 cutover — the
    // legacy block_step19 local is retired).
    const rawPolicy = (row.departurePolicy || "ASAP").toString().toUpperCase().trim();
    currentLeg.departurePolicy = (actionType === "EVENT" && isAttachedDropin) ? "ASAP" : (rawPolicy || "ASAP");

    if (actionType === "EVENT" && isAttachedDropin) {
        pendingChain.push(currentLeg);
        writeFile(DATA_ROOT + "Pending_Compiler.json", JSON.stringify(pendingChain), false);

        setLocal('cal_title_out', "HOLD");

        // V24.17 update:
        // Use dummy values to stop Tasker Variable Split crashes on empty arrays.
        setLocal('cal_start_out', "IGNORE");
        setLocal('cal_end_out', "IGNORE");
    } 
    else {
        pendingChain.push(currentLeg);
        writeFile(DATA_ROOT + "Pending_Compiler.json", "[]", false); 

    let itinerary = readActiveGeneration("itinerary");

        let hardFloor = nowSec; 

        if (itinerary.length > 0) {
            let prevLeg = itinerary[itinerary.length - 1];
            let prevArr = parseInt(prevLeg.arriveUnix, 10);

            hardFloor = prevArr + 60; 

            let pId = prevLeg.targetEventId;
            let pEv = masterArr.find(e => (e.id || "DEFAULT") === pId);

            if (pEv) {
                let isPrevDropin = /(#dropin)/i.test((pEv.title || "") + " " + (pEv.desc || "")) || pEv.isDropin;

                if (isPrevDropin) {
                    let pDropinDur = parseInt(pEv.duration, 10) || 0;
                    let adHocSecs = 0; 
                    let stopRegex = /#stop:(\d+)/gi; 
                    let adHocMatch;

                    while ((adHocMatch = stopRegex.exec(pEv.desc || "")) !== null) {
                        adHocSecs += (parseInt(adHocMatch[1], 10) * 60);
                    }

                    hardFloor = prevArr + pDropinDur + adHocSecs;
                } else {
                    let prevEnd = parseInt(pEv.end, 10);

                    if (pId.indexOf("_IN") !== -1 && pEv.deadline) {
                        prevEnd = parseInt(pEv.deadline, 10);
                    }

                    let depM = (pEv.desc || "").match(/(?:#dep:|#leave:)(\d+)/i);
                    let defDepMins = parseInt(global('Departure_Buffer_Mins'), 10) || 5;
                    let isPDep = /(#leave|#depart)\b/i.test((pEv.title || "") + " " + (pEv.desc || ""));

                    hardFloor = prevEnd + (isPDep ? 0 : (depM ? parseInt(depM[1], 10) : defDepMins) * 60);
                }
            } else if (prevLeg.pitstopState === "forced" || prevLeg.pitstopState === "handled") {
                hardFloor = prevArr + 1800; 
            } else if (prevLeg.mode === "EOD_RETURN" || prevLeg.pitstopState === "end_of_day") {
                hardFloor = prevArr;
            }
        }
        
        hardFloor = Math.max(nowSec, hardFloor);

        let activeHold = parseInt(global('TDS_Hold_Until'), 10) || 0;
        if (itinerary.length === 0 && activeHold > nowSec) {
            hardFloor = Math.max(hardFloor, activeHold);
        }

        let cLen = pendingChain.length;
        let tailLeg = pendingChain[cLen - 1];

        let arrMatch = tailLeg.targetDesc.match(/#arr:(\d+)/i);
        let defArrMins = parseInt(global('Arrival_Buffer_Mins'), 10) || 5;
        let targetBufferSecs = tailLeg.isDepart ? 0 : (arrMatch ? parseInt(arrMatch[1], 10) : defArrMins) * 60;
        
        if (tailLeg.apiType === "DEPART") {
            tailLeg.depTarget = tailLeg.isDepart 
                ? tailLeg.evStartSecs 
                : (tailLeg.evStartSecs - targetBufferSecs - tailLeg.durationSecs);
        } else {
            tailLeg.depTarget = Math.max(
                vTime, 
                (tailLeg.apiType === "ARRIVE" ? tailLeg.apiUnix - tailLeg.durationSecs : tailLeg.apiUnix)
            );
        }

        for (let i = cLen - 2; i >= 0; i--) {
            let leg = pendingChain[i]; 
            let nextLeg = pendingChain[i + 1];

            let arrTarget = nextLeg.depTarget - leg.dropinDur - leg.stopPadSecs;
            leg.depTarget = arrTarget - leg.durationSecs;
        }

        let headLeg = pendingChain[0];

        const chainForcesASAP = pendingChain.some(leg => leg.departurePolicy === "ASAP" || leg.actionType === "EOD_RETURN" || leg.mode === "EOD_RETURN");
        const leaveASAP = (headLeg.departurePolicy === "ASAP") || chainForcesASAP;

        let actualHeadDeparture;
        if (leaveASAP || headLeg.apiType === "ACTIVE_TRAVEL") {
            actualHeadDeparture = hardFloor;
        } else {
            actualHeadDeparture = Math.max(hardFloor, headLeg.depTarget);
        }

        let currentUnix = actualHeadDeparture;
        let outTitles = []; 
        let outStarts = []; 
        let outEnds = [];

        let ovrRaw = readFile(DATA_ROOT + "TDS_Overrides.json") || "{}";
        let OVR = {}; 
        try { 
            OVR = JSON.parse(ovrRaw); 
        } catch(e) {}

        // Phase 6 (REQ-6STATE-1/4): Depart_Memory is trip-state-only. The
        // reducer records observed departures (OBSERVE_DEPARTURE) in
        // state.trips[tripId].departures[]; the Compiler reads that state for
        // the cross-day departChanged/departDiffMins signal. The legacy
        // TDS_Depart_Memory global is no longer read or written here — a
        // fresh planning pass honours committed state (REQ-6STATE-4).
        let stateTrips = null;
        try {
            const stRaw = readFile(DATA_ROOT + "TDS_Trip_State.json") || "";
            if (stRaw) {
                const parsedState = JSON.parse(stRaw);
                stateTrips = parsedState.trips || null;
            }
        } catch (e) { stateTrips = null; }

        for (let i = 0; i < cLen; i++) {
            let leg = pendingChain[i];

            leg.actualDeparture = currentUnix;
            leg.actualArrival = leg.actualDeparture + leg.durationSecs;
            
            let delta = leg.evStartSecs - (leg.isDepart ? leg.actualDeparture : leg.actualArrival);
            
            if (delta >= 0) {
                leg.actualBuffer = Math.floor(delta / 60);

                if (leg.isDepart) {
                    leg.actualBuffer = 9999; 
                }
            } else {
                leg.actualLate = Math.ceil(Math.abs(delta) / 60);
                leg.actualBuffer = 0;
            }

            currentUnix = leg.actualArrival + (leg.dropinDur || 0) + leg.stopPadSecs;

            if (i === cLen - 1) {
                let oldD = null;

                // REQ-6STATE-4: the prior actual departure for this event
                // comes from state.trips[].departures[] (OBSERVE_DEPARTURE
                // records) — the most recent observation is the cross-day
                // comparison baseline, never a same-day reconstruction.
                const stTrip = stateTrips ? stateTrips[leg.targetEventId] : null;
                const depArr = (stTrip && stTrip.departures) || [];
                if (depArr.length > 0) {
                    const lastDep = depArr[depArr.length - 1];
                    oldD = (typeof lastDep.at === "number") ? lastDep.at : parseInt(lastDep.at, 10);
                }
                
                let departChanged = "false"; 
                let departDiffMins = 0;
                let apiConflictStr = "";
                let liveLateMins = (typeof row.engineLateMins === "number") ? row.engineLateMins : 0;
                let timeGapFromNow = leg.apiUnix - nowSec; 
                
                if (timeGapFromNow <= RELEVANCE_WINDOW_SECS) {
                    if (oldD !== null && !isNaN(oldD) && oldD !== leg.actualDeparture) {
                        let diffDays = Math.round(
                            (utcDayBoundaryUnix(leg.apiUnix) - utcDayBoundaryUnix(nowSec)) / SECONDS_PER_DAY
                        );

                        if (
                            diffDays === 1 &&
                            leg.actionType !== "EOD_RETURN" &&
                            leg.actionType !== "EOD"
                        ) {
                            departChanged = "true"; 
                            departDiffMins = Math.round((leg.actualDeparture - oldD) / 60); 
                        }
                    }

                    let ignored = OVR['Ignored_Lateness'] || "";
                    // OVR-10: lateness-ignore membership consults the schema-v2
                    // eventOverrides map by exact key first, then falls back to
                    // exact-token CSV rows — never substring matching.
                    const ovrEntry = (OVR && OVR.eventOverrides) ? OVR.eventOverrides[leg.targetEventId] : null;
                    const ignoredByMap = !!(ovrEntry && ovrEntry.ignoreLateness === true);

                    if (
                        liveLateMins > 0 &&
                        !ignoredByMap &&
                        !csvHasExactToken(ignored, leg.targetEventId) &&
                        leg.actionType === "EVENT" &&
                        leg.apiType !== "ACTIVE_TRAVEL"
                    ) {
                        apiConflictStr = "AUTO_REPLAN|" + leg.targetEventId;
                    }
                }

            setLocal('depart_changed', departChanged); 
            setLocal('depart_diff_mins', departDiffMins.toString());
            setLocal('api_conflict', apiConflictStr); 
            setLocal('live_late_mins', liveLateMins.toString());
        }

        if (TRAVEL_API_TYPES[leg.apiType] && (leg.durationSecs <= 0 || !(leg.distanceMiles > 0))) {
            flash(JSON.stringify({
                timestamp: nowSec,
                generationId: global('TDS_Active_Generation') || null,
                component: "Compiler",
                severity: "WARN",
                code: "ZERO_DURATION_LEG_REJECTED",
                tripId: leg.targetEventId || null,
                details: { apiType: leg.apiType, durationSecs: leg.durationSecs, distanceMiles: leg.distanceMiles, targetTitle: leg.targetTitle }
            }));
            continue;
        }

        // Phase 6 (REQ-6STATE-1): departure records are trip-state-only.
        // OBSERVE_DEPARTURE (staged by the Sandbox base-leave caller) is the
        // sole writer of state.trips[].departures[]; the Compiler no longer
        // maintains a legacy depart-memory global. A rejected leg never
        // reaches state, so nothing is leaked here.

        if (leg.apiType === "ACTIVE_TRAVEL" || leg.durationSecs <= 0) {
                outTitles.push("SKIP_CALENDAR");

                // V24.17 update:
                // Use dummy values rather than blanks to protect Tasker Variable Split.
                outStarts.push("IGNORE");
                outEnds.push("IGNORE");
            } else {
                let modeEmoji = "🚗"; 

                if (leg.mode === "WALK") {
                    modeEmoji = "🚶";
                } else if (leg.mode === "TRANSIT") {
                    modeEmoji = "🚆";
                } else if (leg.mode === "LIFT") {
                    modeEmoji = "🚕";
                }

                let finalTitle = leg.isAttachedDropin 
                    ? ("🔄 Drop-in: " + leg.targetTitle) 
                    : (modeEmoji + " to " + leg.targetTitle);

                if (leg.stopPadSecs > 0) {
                    finalTitle += " (+" + leg.stopUiStr + " stop" + 
                        (leg.pendingStopsRaw.indexOf(",") !== -1 ? "s" : "") + ")";
                }

                outTitles.push(finalTitle);
                outStarts.push(String(leg.actualDeparture * 1000));
                outEnds.push(String(leg.actualArrival * 1000));
            }

            itinerary.push({
                targetEventId: leg.targetEventId,
                targetTitle: leg.targetTitle,
                targetDesc: leg.targetDesc,
                targetCoords: leg.targetCoords,
                mode: leg.mode,
                departurePolicy: leg.departurePolicy,
                planningDay: leg.planningDay,
                originSource: leg.originSource,
                departUnix: leg.actualDeparture,
                arriveUnix: leg.actualArrival,
                durationSecs: leg.durationSecs,
                distanceMiles: leg.distanceMiles,
                pitstopState: leg.pitstopState, 
                latenessMins: leg.actualLate || 0,
                bufferMins: leg.actualBuffer,
                transitStepsRaw: leg.transitStepsRaw,
                holdUntilUnix: activeHold,
                pendingStopsRaw: leg.pendingStopsRaw 
            });
        }
        
        publishCandidate({ events: masterArr, master: masterArr, itinerary: itinerary });

        setLocal('cal_title_out', outTitles.join("|"));
        setLocal('cal_start_out', outStarts.join("|"));
        setLocal('cal_end_out', outEnds.join("|"));
    }
}