// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";
// Normalize: a dataRoot without a trailing slash would silently concatenate into
// invalid paths (R4-WARNING on the extraction refactor).
if (DATA_ROOT.charAt(DATA_ROOT.length - 1) !== "/") { DATA_ROOT += "/"; }

// ==========================================
// V36 ENGINE SANDBOX (v16.5)
// - Drop-in Gravity: Evaluates Drop-ins against logical A-to-B trip windows on the fly.
// - ASAP Dispatch: Engine routes immediately and pads wait time at destination.
// - Ironclad Latch: Survives GPS drift while in meetings.
// [V16.5] Chronological simAtBase tracking & Temporal Ghost Trip Attachment.
// ==========================================

let GLOBAL_MASTER_ARR = [];

let ovrRaw = "";
try { ovrRaw = readFile(DATA_ROOT + "TDS_Overrides.json") || "{}"; } catch(e) {}
let OVR = {};
try { OVR = JSON.parse(ovrRaw); } catch(e) {}
function getOvr(key) { return OVR[key] || ""; }

// Phase 6 (REQ-6STATE-1): Completed_Stops is trip-state-only. The snapshot is
// read ONCE at module top (single-snapshot-per-pass) from
// state.completedStops; the legacy global is no longer read or written.
let completedStopsRaw = "";
try {
    const stRaw = readFile(DATA_ROOT + "TDS_Trip_State.json") || "";
    if (stRaw) {
        const parsedState = JSON.parse(stRaw);
        const stopMap = parsedState.completedStops || {};
        const stopKeys = [];
        for (let sk in stopMap) {
            if (stopMap.hasOwnProperty(sk)) stopKeys.push(sk);
        }
        completedStopsRaw = stopKeys.join(",");
    }
} catch (e) {}

// E1 (RULE-8C): preferences are read directly from the PREFS file —
// Route_Defaults lives in TDS_Routine_Preferences.json, not OVR.
let prefsRaw = "";
try { prefsRaw = readFile(DATA_ROOT + "TDS_Routine_Preferences.json") || "{}"; } catch(e) {}
let PREFS = {};
try { PREFS = JSON.parse(prefsRaw); } catch(e) {}
function getPrefs(key) { return PREFS[key] || ""; }

// OVR-10 (REQ-OVR10-1): exact-key readers over the schema-v2 stores. Identity
// membership MUST use own-property keys of eventOverrides/seriesPreferences —
// never substring matching — so decoy occurrence IDs like ev_10 can never
// satisfy an ev_1 lookup. CSV projections remain compatibility views; the
// exact-token fallback preserves legacy files without substring matches.
function getOvrEntry(occId) {
    const map = (OVR && OVR.eventOverrides) || {};
    if (typeof occId !== "string" || occId === "") return null;
    return Object.prototype.hasOwnProperty.call(map, occId) ? map[occId] : null;
}
function hasExactOverride(occId, field, value) {
    const entry = getOvrEntry(occId);
    if (!entry) return false;
    if (field === "mode") return entry.mode === value;
    if (field === "pitstop") return entry.pitstop === value;
    if (field === "skip") return entry.skip === true;
    if (field === "ignoreLateness") return entry.ignoreLateness === true;
    if (field === "ignoreWalk") return entry.ignoreWalk === true;
    return false;
}
// Exact-row membership over CSV rows and in-memory accumulators. A row matches
// only when it equals the occurrence id or starts with "<id>~" (suffixed rows
// like ev_1~fixed) — never a bare substring.
function csvHasOccurrence(csv, occId) {
    if (!csv || typeof occId !== "string" || occId === "") return false;
    const rows = csv.split(",");
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (row === occId) return true;
        if (row.indexOf(occId + "~") === 0) return true;
    }
    return false;
}
// Lateness mode: a map-backed ignoreLateness entry is "shifted" (the map
// carries no fixed/shifted distinction); legacy rows retain eventId~fixed /
// ~shifted and are matched by exact row, so a decoy id can never satisfy it.
function getLatenessMode(evId, ignoredLatenessStr) {
    const entry = getOvrEntry(evId);
    if (entry && entry.ignoreLateness === true) return "shifted";
    if (ignoredLatenessStr) {
        const rows = ignoredLatenessStr.split(",");
        for (let r = 0; r < rows.length; r++) {
            const p = rows[r].split("~");
            if (p[0] === evId && p.length > 1) return p[1].trim().toLowerCase();
        }
    }
    return "shifted";
}
function hasExactPref(seriesId, routeSig, modifier) {
    const map = (PREFS && PREFS.seriesPreferences) || {};
    if (typeof seriesId !== "string" || typeof routeSig !== "string" || typeof modifier !== "string") return false;
    if (!Object.prototype.hasOwnProperty.call(map, seriesId)) return false;
    const routes = map[seriesId] || {};
    if (!Object.prototype.hasOwnProperty.call(routes, routeSig)) return false;
    const defaults = (routes[routeSig] || {}).defaults || {};
    return Object.prototype.hasOwnProperty.call(defaults, modifier) && defaults[modifier] === true;
}

let trimmedEventsRaw = getOvr('Trimmed_Events');
let skippedEvents = getOvr('Skipped_Events'); 

function getSafeId(eventObj) {
    if (!eventObj) return "DEFAULT";
    return eventObj.id || "DEFAULT"; 
}

// [ID-2] Strict occurrence-ID parsing (inlined copy; canonical: ID_Parser.js).
// Occurrence IDs are <coreId>_<base36StartUnix>; cores may contain underscores,
// so the split uses lastIndexOf("_"). Malformed/out-of-range IDs flash
// ID_PARSE_REJECTED and skip the rejected work (no apply).
const ID_SUFFIX_MIN_UNIX = 1e9;
const ID_SUFFIX_MAX_UNIX = 2.5e9;
const ID_OCCURRENCE_REGEX = /^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$/;

// Route metric conversion: metres to statute miles (INV-0.7 columns 17/18).
const METERS_TO_MILES = 0.000621371;
// Actionability relevance window: an event more than 18 hours out is not a
// candidate for lateness/next-day decisions (named deadline, never a raw delta).
const RELEVANCE_WINDOW_SECS = 64800;
// Bounds for the raw target delta used by the lateness floor (6 hours).
const RAW_DELTA_BOUND_MINS = 360;

function parseOccurrenceId(rawId, component) {
    component = component || "ID_Parser";
    if (typeof rawId !== "string" || rawId.length === 0) {
        return rejectOccurrenceId(rawId, "empty_id", component);
    }
    const lastSep = rawId.lastIndexOf("_");
    if (lastSep <= 0 || lastSep === rawId.length - 1) {
        return rejectOccurrenceId(rawId, "malformed_format", component);
    }
    const match = ID_OCCURRENCE_REGEX.exec(rawId);
    if (!match) {
        return rejectOccurrenceId(rawId, "malformed_format", component);
    }
    const suffixNum = parseInt(match[2], 36);
    if (isNaN(suffixNum) || suffixNum < ID_SUFFIX_MIN_UNIX || suffixNum >= ID_SUFFIX_MAX_UNIX) {
        return rejectOccurrenceId(rawId, "invalid_suffix", component);
    }
    return { ok: true, coreId: match[1], instanceStartUnix: suffixNum, rawId: rawId };
}

function rejectOccurrenceId(rawId, reason, component) {
    flash(JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        generationId: null,
        component: component,
        severity: "WARN",
        code: "ID_PARSE_REJECTED",
        tripId: null,
        details: { rawId: rawId, reason: reason }
    }));
    return { ok: false, reason: reason };
}

// Phase 2 reader cutover: discover the committed generation through the manifest.
// Mirrors TDS_Helper.readActive; includes a legacy fallback while the migration
// is in flight.
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
    let m = readJson(DATA_ROOT + "TDS_Run_Manifest.json");
    let key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
    if (m && m.state === "committed" && m.activeGeneration) {
        let data = readJson(m[key] || pathFor(m.activeGeneration, kind));
        if (data !== null) return data;
    }
    if (m && m.previousGeneration) {
        let prev = readJson(pathFor(m.previousGeneration, kind));
        if (prev !== null) return prev;
    }
    if (kind === "events" || kind === "master") {
        let legacy = readJson(DATA_ROOT + "TDS_Master.json");
        if (legacy !== null) return legacy;
    }
    if (kind === "itinerary") {
        let legacyItin = readJson(DATA_ROOT + "Itin_Master.json");
        if (legacyItin !== null) return legacyItin;
    }
    return [];
}

function getTrimmedEnd(evId, rawEnd, start, trimRaw) {
    let e = rawEnd || (start + 3600);
    if (trimRaw && csvHasOccurrence(trimRaw, evId)) {
        let tRows = trimRaw.split(",");
        for (let t = 0; t < tRows.length; t++) {
            let tp = tRows[t].split("~");
            if (tp[0] === evId && !isNaN(parseInt(tp[1], 10))) e = Math.min(e, parseInt(tp[1], 10));
        }
    }
    return e;
}

function isIdInChain(testId, chainStr) {
    if (!chainStr || chainStr.indexOf("~") === -1) return false;
    let parts = chainStr.split("|");
    for (let c = 0; c < parts.length; c++) {
        let cParts = parts[c].split("~");
        if (cParts.length !== 2) continue;
        let sIdx = -1, eIdx = -1, tIdx = -1;
        for (let x = 0; x < GLOBAL_MASTER_ARR.length; x++) {
            let mId = getSafeId(GLOBAL_MASTER_ARR[x]);
            if (mId === cParts[0]) sIdx = x;
            if (mId === cParts[1]) eIdx = x;
            if (mId === testId)   tIdx = x;
        }
        if (sIdx !== -1 && eIdx !== -1 && tIdx !== -1 && tIdx >= sIdx && tIdx <= eIdx) return true;
    }
    return false;
}

function getDist(lat1, lon1, lat2, lon2) {
    let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function forceSeconds(val) {
    let v = parseFloat(val); if (isNaN(v) || v <= 0) return 0;
    return Math.floor(v); 
}

function getSpeed(mode) {
    let map = { "WALK": 1.4, "TRANSIT": 8.0, "LIFT": 10.0, "DRIVE": 13.0 };
    return map[mode] || 1.4;
}

const SECONDS_PER_DAY = 86400;

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

function getBase(targetTimeSecs) {
    let baseCoords = global('Home_Coords') || "0,0"; 
    let baseName = "Home"; 
    let baseData = readFile(DATA_ROOT + "TDS_Base_Geocodes.txt") || "none";
    
    if (baseData !== "none" && baseData.length > 3) {
        let bases = baseData.split("|");
        let bestBase = null;
        let shortestDuration = 99999999999; 

        for (let j = 0; j < bases.length; j++) {
            if (!bases[j]) continue; 
            let parts = bases[j].split("~");
            let bStart = parseFloat(parts[0]);
            let bEnd = parseFloat(parts[1]);
            
            let bId = parts[6];
            if (bId) {
                bEnd = getTrimmedEnd(bId, bEnd, bStart, trimmedEventsRaw);
                bEnd = getTrimmedEnd(bId + "_OUT", bEnd, bStart, trimmedEventsRaw);
            }
            let bDur = bEnd - bStart;

            if (targetTimeSecs >= bStart && targetTimeSecs <= bEnd) {
                if (bDur < shortestDuration) {
                    shortestDuration = bDur;
                    bestBase = { coords: parts[2], name: parts[4] || "Base" };
                }
            }
        }
        if (bestBase) return bestBase;
    }
    return { coords: baseCoords, name: baseName };
}

function getDayPrefix(targetUnixSecs, currentUnixSecs) {
    let tDate = new Date(targetUnixSecs * 1000);
    let cDate = new Date(currentUnixSecs * 1000);
    let tMidnight = new Date(tDate.getFullYear(), tDate.getMonth(), tDate.getDate()).getTime();
    let cMidnight = new Date(cDate.getFullYear(), cDate.getMonth(), cDate.getDate()).getTime();
    let diffDays = Math.round((tMidnight - cMidnight) / (86400 * 1000));
    
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    let days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (diffDays > 6) ? ("Next " + days[tDate.getDay()]) : days[tDate.getDay()];
}

function localPlanningDay(targetUnixSecs) {
    let d = new Date(targetUnixSecs * 1000);
    let y = d.getFullYear();
    let m = ("0" + (d.getMonth() + 1)).slice(-2);
    let day = ("0" + d.getDate()).slice(-2);
    return y + "-" + m + "-" + day;
}

function snapCoords(rawCoords, masterArray, targetCoordsToIgnore) {
    if (!rawCoords || rawCoords === "0,0") return { coords: rawCoords, snapped: false };
    let parts = rawCoords.split(",");
    let rLat = parseFloat(parts[0]); let rLon = parseFloat(parts[1]);
    if (isNaN(rLat) || isNaN(rLon)) return { coords: rawCoords, snapped: false };

    if (targetCoordsToIgnore && targetCoordsToIgnore !== "0,0") {
        let tParts = targetCoordsToIgnore.split(",");
        if (getDist(rLat, rLon, parseFloat(tParts[0]), parseFloat(tParts[1])) <= 75) {
            return { coords: rawCoords, snapped: true };
        }
    }

    let homeRaw = global('Home_Coords') || "0,0";
    let hParts = homeRaw.split(",");
    let hLat = parseFloat(hParts[0]); let hLon = parseFloat(hParts[1]);
    if (!isNaN(hLat) && !isNaN(hLon) && hLat !== 0) {
        if (getDist(rLat, rLon, hLat, hLon) <= 75) return { coords: homeRaw.trim(), snapped: true };
    }

    let baseGeos = readFile(DATA_ROOT + "TDS_Base_Geocodes.txt") || "";
    if (baseGeos.indexOf("%") === -1 && baseGeos.length > 5) {
        let bRows = baseGeos.split("|");
        for (let b = 0; b < bRows.length; b++) {
            if (!bRows[b]) continue;
            let bParts = bRows[b].split("~");
            let bcP = (bParts[2] || "0,0").split(",");
            if (getDist(rLat, rLon, parseFloat(bcP[0]), parseFloat(bcP[1])) <= 75) return { coords: bParts[2].trim(), snapped: true };
        }
    }

    for (let e = 0; e < masterArray.length; e++) {
        let ecP = (masterArray[e].coords || "0,0").split(",");
        if (getDist(rLat, rLon, parseFloat(ecP[0]), parseFloat(ecP[1])) <= 75) return { coords: masterArray[e].coords.trim(), snapped: true };
    }
    return { coords: rawCoords, snapped: false };
}

function calcMode(startCoords, targetCoords, evStartStr, evText, evId) {
    let dist = getDist(parseFloat(startCoords.split(",")[0]), parseFloat(startCoords.split(",")[1]), parseFloat(targetCoords.split(",")[0]), parseFloat(targetCoords.split(",")[1]));
    let mode = "WALK";
    if (dist >= 1500) mode = "DRIVE";

    let cityZonesRaw = global('City_Transit_Zones') || "";
    if (cityZonesRaw.length > 5 && dist >= 1500) {
        let zones = cityZonesRaw.split("|");
        let evLat = parseFloat(targetCoords.split(",")[0]); let evLon = parseFloat(targetCoords.split(",")[1]);
        for (let z = 0; z < zones.length; z++) {
            let zLat = parseFloat(zones[z].split(",")[0]); let zLon = parseFloat(zones[z].split(",")[1]);
            if (getDist(evLat, evLon, zLat, zLon) <= 5000) { mode = "TRANSIT"; break; }
        }
    }
    
    let safeId = (evId || evStartStr || "").trim(); 
    let forced = false; 

    if (/(lift|#lift)/i.test(evText)) { mode = "LIFT"; forced = true; }
    else if (/(transit|#transit)/i.test(evText)) { mode = "TRANSIT"; forced = true; }
    else if (/(drive|#drive)/i.test(evText)) { mode = "DRIVE"; forced = true; }

    if (safeId !== "") {
        if (hasExactOverride(safeId, "mode", "lift") || csvHasOccurrence(getOvr('Forced_Lifts'), safeId)) { mode = "LIFT"; forced = true; }
        if (hasExactOverride(safeId, "mode", "transit") || csvHasOccurrence(getOvr('Forced_Transit'), safeId)) { mode = "TRANSIT"; forced = true; }
        if (hasExactOverride(safeId, "mode", "walk") || csvHasOccurrence(getOvr('Forced_Walks'), safeId)) { mode = "WALK"; forced = true; }
        if (hasExactOverride(safeId, "mode", "drive") || csvHasOccurrence(getOvr('Forced_Drives'), safeId)) { mode = "DRIVE"; forced = true; }
        if (isIdInChain(safeId, getOvr('Forced_Drive_Chains'))) { mode = "DRIVE"; forced = true; }
        if (isIdInChain(safeId, getOvr('Forced_Lift_Chains')))  { mode = "LIFT"; forced = true; }
    }
    return { mode: mode, dist: dist, isForced: forced };
}

function getRecoveryMode(bLoc, cLoc, d) {
    if (d < 1500) return "WALK";
    let m = calcMode(bLoc, cLoc, "0", "", "").mode;
    return (m === "TRANSIT") ? "TRANSIT" : "LIFT";
}

function getRemainingStops(evId, desc, completedRaw) {
    let stopRegex = /#stop:(\d+)/gi;
    let match; let planned = [];
    while ((match = stopRegex.exec(desc)) !== null) {
        planned.push(parseInt(match[1], 10));
    }
    if (planned.length === 0) return { secs: 0, arr: [] };

    let completed = [];
    if (completedRaw) {
        let csArr = completedRaw.split(",");
        for (let c=0; c<csArr.length; c++) {
            if (!csArr[c]) continue;
            if (csArr[c].indexOf(evId + "_") === 0) {
                let parts = csArr[c].split("_");
                completed.push(parseInt(parts[parts.length-1], 10)); 
            }
        }
    }

    let remSecs = 0; let pendingArr = [];
    for (let s=0; s<planned.length; s++) {
        let dur = planned[s];
        let cIdx = completed.indexOf(dur);
        if (cIdx !== -1) {
            completed.splice(cIdx, 1);
        } else {
            remSecs += (dur * 60);
            pendingArr.push(dur);
        }
    }
    return { secs: remSecs, arr: pendingArr };
}

// FU1 (REQ-6FU-1): per-pass accumulation of every observation staged in one
// Sandbox pass. The serial Tasker model delivers only the LAST staged par1/par2
// to TDS_State_Command, so observations are appended to an ordered array here
// and, at pass end, staged as ONE REDUCER_BATCH envelope — the reducer applies
// each sub-command in order. The synchronous reducer shim (harness) still
// applies each observation immediately (28/28 regression stays green); when the
// reducer is NOT a function (serial Tasker / harness serialMode) the batch is
// accumulated only, never double-applied. The reducer stays the sole writer of
// the state file and project() the sole writer of the five status globals
// (REQ-6STATE-2/3).
let stagedReducerCommands = [];
function stageReducerCommand(name, payload) {
    stagedReducerCommands.push({ command: name, payload: payload });
    if (typeof reducer === 'function') {
        setLocal('par1', name);
        setLocal('par2', JSON.stringify(payload));
        reducer(name, payload);
    }
}

try {
    let idx = parseInt(local('idx'), 10) || 1; 
    let master = readActiveGeneration("master");
    GLOBAL_MASTER_ARR = master;

    if (idx > master.length) { 
        // REQ-5QUEUE-1: EOF is an empty-row envelope, never a bare token.
        setLocal('block_queue', JSON.stringify({ schemaVersion: 1, rows: [], eof: true, skipIdxUntil: (master.length + 99), stepConflict: null, notifications: [] }));
        setLocal('is_drive_block', "false");
    } else {
        let nowSec = Math.floor(Date.now() / 1000);
        let incomingStatus = global('Current_Status') || "Idle";
        const sevenDayHorizonSec = utcDayBoundaryUnix(nowSec) + 8 * SECONDS_PER_DAY - 1;

        let resolvedStatus = incomingStatus;
        let isAtMeeting = false;
        let currentlyAtBase = false;

        if (incomingStatus === "Updating") {
            let uParts = (global('User_Loc') || "0,0").split(",");
            let uLat = parseFloat(uParts[0]) || 0; let uLng = parseFloat(uParts[1]) || 0;
            let activeLatch = global('Active_Geo_Latch') || "";
            let nextLatch = activeLatch; resolvedStatus = "Idle";

            let isAtBase = false; let activeBaseName = "Base"; let activeBaseId = "";

            if (uLat !== 0 && uLng !== 0) {
                let hCoords = (global('Home_Coords') || "0,0").split(",");
                let isAtHome = getDist(uLat, uLng, parseFloat(hCoords[0]), parseFloat(hCoords[1])) < 75;
                if (isAtHome) nextLatch = ""; 

                let isAtAdHocBase = false; let adHocRaw = global('AdHoc_Base') || "";
                if (!isAtHome && adHocRaw.indexOf("%") !== 0 && adHocRaw.length > 3) {
                    let aParts = adHocRaw.split("~");
                    if (aParts.length >= 3) {
                        let dA = getDist(uLat, uLng, parseFloat(aParts[2].split(",")[0]), parseFloat(aParts[2].split(",")[1]));
                        let isALatched = (activeLatch === "ADHOC~" + aParts[2] && dA < 1000);
                        if (dA < 75 || isALatched) { isAtAdHocBase = true; nextLatch = "ADHOC~" + aParts[2]; } 
                        else if (activeLatch === "ADHOC~" + aParts[2] && dA >= 1000) {
                            if (nextLatch === activeLatch) nextLatch = "";
                        }
                    }
                }

                let baseData = readFile(DATA_ROOT + "TDS_Base_Geocodes.txt") || "";
                if (!isAtHome && !isAtAdHocBase && baseData.indexOf("%") !== 0 && baseData.length > 3) {
                    let bases = baseData.split("|");
                    for (let b = 0; b < bases.length; b++) {
                        if (!bases[b]) continue; let parts = bases[b].split("~");
                        if (parts[0] === "0" && parts[1] === "5000000000") continue; 
                        let bStart = parseFloat(parts[0]); let bEnd = parseFloat(parts[1]);
                        let bId = parts[6];
                        if (bId) {
                            bEnd = getTrimmedEnd(bId, bEnd, bStart, trimmedEventsRaw);
                            bEnd = getTrimmedEnd(bId + "_OUT", bEnd, bStart, trimmedEventsRaw);
                        }
                        if (nowSec >= bStart && nowSec <= bEnd) {
                            let bCStr = parts[2] || "0,0";
                            let dB = getDist(uLat, uLng, parseFloat(bCStr.split(",")[0]), parseFloat(bCStr.split(",")[1]));
                            let isBLatched = (activeLatch === "BASE~" + bCStr && dB < 1000);
                            if (dB < 75 || isBLatched) { 
                                isAtBase = true; activeBaseName = parts[4] || "Base"; activeBaseId = bId || "";
                                nextLatch = "BASE~" + bCStr; break; 
                            } 
                            else if (activeLatch === "BASE~" + bCStr && dB >= 1000) {
                                if (nextLatch === activeLatch) nextLatch = "";
                            }
                        }
                    }
                }

                let nextMeet = master[0]; 
                if (!isAtHome && !isAtAdHocBase && nextMeet && nextMeet.coords && nextMeet.coords !== "0,0") {
                    let mCoords = nextMeet.coords.split(",");
                    let mStartSec = parseFloat(nextMeet.start) || 0;
                    let mEndSec = parseFloat(nextMeet.end) || 0;
                    let mId = getSafeId(nextMeet);
                    let dM = getDist(uLat, uLng, parseFloat(mCoords[0]), parseFloat(mCoords[1]));
                    
                    let isMLatched = (activeLatch === "MEET~" + mId && dM < 1000);

                    if ((dM < 300 || isMLatched) && nowSec >= (mStartSec - 7200) && nowSec <= mEndSec) {
                        isAtMeeting = true; nextLatch = "MEET~" + mId;
                    } else if (activeLatch === "MEET~" + mId && dM >= 1000) {
                        if (nextLatch === activeLatch) nextLatch = "";
                    }
                }

                if (nextLatch !== activeLatch) setGlobal('Active_Geo_Latch', nextLatch);
                
                currentlyAtBase = (isAtHome || isAtAdHocBase || isAtBase);
                let prevAtBase = (global('User_At_Base') === "true");
                let oldItin = readActiveGeneration("itinerary");
                if (currentlyAtBase && !prevAtBase) {
                    // Phase 3 PR-B: stage OBSERVE_LIVE_BASE to the reducer. The reducer
                    // is the sole writer of TDS_Trip_State.json and tracks currentOrigin.
                    // Phase 6: the legacy User_At_Base/Base_Arrival_Unix writes are gone —
                    // the reducer's project() owns those projections post-commit.
                    stageReducerCommand('OBSERVE_LIVE_BASE', {
                        generationId: global('TDS_Active_Generation') || "gen:0:0000",
                        at: nowSec
                    });
                    // Slice B (AC-5/0E): base arrival completes the active
                    // manual return. Read the reducer state, find the
                    // IN_PROGRESS/ARRIVED trip on TODAY's planning day (the
                    // manual return), and submit COMPLETE_TRIP so the trip
                    // lifecycle ends and the action lock can close downstream
                    // (B3). Other-day active trips and tomorrow's PLANNED
                    // trips are never touched by the reducer.
                    // manualReturnCompleted records the success signal.
                    let activeManualTrips = [];
                    try {
                        const stRaw = readFile(DATA_ROOT + "TDS_Trip_State.json") || "";
                        if (stRaw) {
                            const st = JSON.parse(stRaw);
                            const trips = st.trips || {};
                            const todayLabel = localPlanningDay(nowSec);
                            Object.keys(trips).forEach(function (tid) {
                                const t = trips[tid];
                                if (t && (t.lifecycleState === 'IN_PROGRESS' || t.lifecycleState === 'ARRIVED') && t.currentPlanningDay === todayLabel) {
                                    activeManualTrips.push(tid);
                                }
                            });
                        }
                    } catch (e) {}
                    activeManualTrips.forEach(function (tid) {
                        const completionPayload = {
                            generationId: global('TDS_Active_Generation') || "gen:0:0000",
                            tripId: tid,
                            at: nowSec,
                            planningDay: localPlanningDay(nowSec)
                        };
                        stageReducerCommand('COMPLETE_TRIP', completionPayload);
                    });
                } else if (!currentlyAtBase && prevAtBase) {
                    // Phase 6 (REQ-6STATE-3/4, SCN-6STATE-5/7): base departure clears
                    // base state via OBSERVE_BASE_LEAVE and records the actual departure
                    // of the active leg via OBSERVE_DEPARTURE (tripId from the head leg's
                    // targetEventId; cross-day diff authority, REQ-6STATE-4). project()
                    // owns the User_At_Base/Base_Arrival_Unix projections.
                    stageReducerCommand('OBSERVE_BASE_LEAVE', {
                        generationId: global('TDS_Active_Generation') || "gen:0:0000",
                        at: nowSec
                    });
                    if (oldItin.length > 0 && oldItin[0].targetEventId) {
                        stageReducerCommand('OBSERVE_DEPARTURE', {
                            generationId: global('TDS_Active_Generation') || "gen:0:0000",
                            tripId: oldItin[0].targetEventId,
                            at: nowSec,
                            planningDay: localPlanningDay(nowSec)
                        });
                    }
                }

                let pitStr = "";
                if (oldItin.length > 0) {
                    let aLeg = oldItin[0];
                    if (aLeg.pitstopState === 'true' || aLeg.pitstopState === 'forced' || aLeg.pitstopState === 'handled') {
                        pitStr = " (Pitstop)";
                    } else if (aLeg.pitstopState === 'end_of_day') {
                        pitStr = " (Heading Home)";
                    }
                }

                if (isAtMeeting) {
                    let mTitle = (master[0].title || "Meeting").replace(/^(Start:|End:)\s*/i, "");
                    resolvedStatus = "At " + mTitle; 
                }
                else if (isAtHome) resolvedStatus = "At Home";
                else if (isAtAdHocBase) resolvedStatus = "At Ad-Hoc Base";
                else if (isAtBase) resolvedStatus = (activeBaseName !== "Base" ? "At " + activeBaseName : "At Base"); 
                else {
                    let activeLeg = oldItin[0]; let leaveSec = 0; let legMode = "WALK"; let targetId = "";
                    if (activeLeg) { 
                        leaveSec = parseFloat(activeLeg.departUnix || activeLeg.time || activeLeg.apiTimeUnix || activeLeg.start || 0); 
                        legMode = (activeLeg.mode || "WALK").toUpperCase().trim(); 
                        targetId = activeLeg.targetEventId || "";
                    }
                    
                    let latestValidDepart = leaveSec + 3600; 
                    if (targetId) {
                        let tEv = master.find(e => getSafeId(e) === targetId);
                        if (tEv) latestValidDepart = forceSeconds(tEv.end) - (activeLeg.durationSecs || 0);
                    }

                    if (leaveSec > 0 && nowSec >= (leaveSec - 600) && nowSec <= latestValidDepart) {
                        let isCarPaired = (global('Car_Connected') || "").toLowerCase() === "true";
                        if (legMode === "DRIVE") resolvedStatus = isCarPaired ? ("Driving" + pitStr) : ("Lift" + pitStr);
                        else {
                            let modeDict = { "LIFT": "Lift", "WALK": "Walking", "TRANSIT": "Public Transport" };
                            resolvedStatus = (modeDict[legMode] || "Walking") + pitStr;
                        }
                        // FU2 (REQ-6FU-5, SCN-6FU-10/11): non-base-origin
                        // departure observation. A JIT head leg entering its
                        // departure window while the vehicle is already away
                        // (prevAtBase false — NOT a base-leave) has no other
                        // observation site, so complete REQ-6STATE-4 here.
                        // Once-per-leg guard: skip when the last departures[]
                        // record for this trip already matches the current
                        // planning day — prevents per-pass spam (the reducer
                        // only dedupes identical `at`) and a cross-pass
                        // double observation of a base-leave departure.
                        if (targetId && !currentlyAtBase && !prevAtBase) {
                            let departureRecordedToday = false;
                            try {
                                const stRaw = readFile(DATA_ROOT + "TDS_Trip_State.json") || "";
                                if (stRaw) {
                                    const st = JSON.parse(stRaw);
                                    const trip = (st.trips || {})[targetId];
                                    const deps = (trip && trip.departures) || [];
                                    const lastDep = deps[deps.length - 1];
                                    departureRecordedToday = !!(lastDep && lastDep.planningDay === localPlanningDay(nowSec));
                                }
                            } catch (e) {}
                            if (!departureRecordedToday) {
                                stageReducerCommand('OBSERVE_DEPARTURE', {
                                    generationId: global('TDS_Active_Generation') || "gen:0:0000",
                                    tripId: targetId,
                                    at: nowSec,
                                    planningDay: localPlanningDay(nowSec)
                                });
                            }
                        }
                    } else resolvedStatus = "Idle";
                }
                stageReducerCommand('OBSERVE_STATUS', {
                    generationId: global('TDS_Active_Generation') || "gen:0:0000",
                    status: resolvedStatus,
                    at: nowSec
                });
            }
        } else {
            currentlyAtBase = (global('User_At_Base') === "true");
            isAtMeeting = /(At )/i.test(incomingStatus) && !/(Home|Base)/i.test(incomingStatus);
        }

        let baseArrivalUnix = parseInt(global('Base_Arrival_Unix'), 10) || nowSec;
        let snapLoc = snapCoords(local('virtual_loc') || "0,0", master, master[idx-1] ? master[idx-1].coords : null);
        let snapCar = snapCoords(local('vcar_loc') || "0,0", master, null);

        let state = { time: forceSeconds(local('virtual_time')) || nowSec, loc: snapLoc.coords, carLoc: snapCar.coords, isStableOrigin: snapLoc.snapped };
        
        if (idx === 1) {
            state.time = Math.max(state.time, nowSec + 120);
        }

        let queue = []; let notifQueue = []; let blockMode = null; let skipIdx = idx; let stepConflict = "";
        // Slice B (AC-5/INV-0.4): tracks whether any real planned travel row
        // was enqueued this pass. The tail EOD return is legitimate only when
        // the day actually had planned travel; an observation-only day must
        // suppress it (REQ-INV0_4-1).
        let plannedEventSeen = false;
        let stateHistory = {};

        // INV-0.1 / AC-1: every planned queue row must carry an explicit
        // Phase 5 (REQ-5QUEUE-1): every planned row is a TypedRow object inside
        // the block_queue JSON envelope; the Compiler JSON.parses it once inside
        // its JSlet. Policy/day/origin stay explicit row fields — never
        // reconstructed downstream from location, leg order, or event type.
        function toPosInt(v) { const n = parseInt(v, 10); return (isNaN(n) || n <= 0) ? null : n; }
        function toPosNum(v) { const n = parseFloat(v); return (isNaN(n) || n <= 0) ? null : n; }
        function toNumArr(v) {
            if (v === null || v === undefined || v === "") return [];
            const src = Array.isArray(v) ? v : String(v).split(",");
            const out = [];
            for (let k = 0; k < src.length; k++) {
                const n = parseInt(src[k], 10);
                if (!isNaN(n)) out.push(n);
            }
            return out;
        }
        function toBool(v) { return (v === true || v === "true"); }
        function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
        function toNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

        // INV-0.1: the planning engine owns departurePolicy. An empty policy
        // defaults to ASAP with a structured fallback flash (named code).
        function buildTypedRow(row) {
            let effectivePolicy = (row.departurePolicy || "").toString().toUpperCase().trim();
            if (!effectivePolicy) {
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: global('TDS_Active_Generation') || null,
                    component: "Sandbox",
                    severity: "WARN",
                    code: "DEPARTURE_POLICY_FALLBACK_USED",
                    tripId: row.evId || null,
                    details: { departurePolicy: null, rowType: row.rowType || "UNKNOWN", reconstructed: "ASAP" }
                }));
                effectivePolicy = "ASAP";
            }
            return {
                rowType: String(row.rowType || ""),
                title: String(row.title || ""),
                coords: String(row.coords || ""),
                mode: String(row.mode || ""),
                displayTime: toInt(row.displayTime),
                departTime: toInt(row.departTime),
                pitstopState: String(row.pitstopState || ""),
                apiTimeType: String(row.apiTimeType || ""),
                apiTimeUnix: toInt(row.apiTimeUnix),
                evId: String(row.evId || ""),
                evLoc: String(row.evLoc || ""),
                engineLateMins: toNum(row.engineLateMins),
                currentLegStable: toBool(row.currentLegStable),
                dropinStatusFlag: String(row.dropinStatusFlag || ""),
                safeDesc: String(row.safeDesc || ""),
                adHoc: toNumArr(row.adHoc),
                routeDurationSecs: toPosInt(row.routeDurationSecs),
                routeDistanceMiles: toPosNum(row.routeDistanceMiles),
                departurePolicy: effectivePolicy,
                planningDay: String(row.planningDay || chainPlanningDay || ""),
                originSource: String(row.originSource || ((queue.length === 0) ? passOriginSource : "CONFIRMED_LAST_DESTINATION"))
            };
        }

        function enqueueTypedRow(row) {
            const typed = buildTypedRow(row);
            queue.push(typed);
        }
        
        let ignoredLateness = getOvr('Ignored_Lateness'); let ignoredWalks = getOvr('Ignored_Walks');

        let maxWalk = parseInt(global('Max_Walk_Meters'), 10) || 8046; 
        let dailyWalkDist = parseInt(global('Daily_Walk_Meters'), 10) || 0;
        let liveThreshold = parseInt(global('Live_Traffic_Threshold'), 10) || 7200;

        let defArrMins = parseInt(global('Arrival_Buffer_Mins'), 10) || 5; 
        let defDepMins = parseInt(global('Departure_Buffer_Mins'), 10) || 5; 

        // Slice D (REQ-5CACHE-1/2): read-only JSON cache readers. The Route
        // Cache Manager is the SOLE writer of TDS_Route_Cache.json and
        // Temp_Route_Cache.json (RULE-8E); this engine never mutates them. The
        // legacy RouteCache.txt / Temp_Route_Cache.txt projections were retired
        // in Slice D — JSON is the only format. Expired, nonpositive, malformed,
        // wrong-bucket, and key-mismatched entries are misses (SCN-5CACHE-3),
        // replicating the manager's CACHE_READ filter inline so getCachedTime
        // sees the identical envelope; every dropped entry emits reader-origin
        // CACHE_ENTRY_REJECTED LOG-17 (REQ-5LOG-1).
        const CACHE_MODE_WALK = "WALK";
        function sbRouteKey(o, d, m, bucket, dayClass) {
            return o + "~~" + d + "~~" + m + "~~" + (bucket === null ? "null" : bucket) + "~~" + dayClass;
        }
        function sbTempKey(o, d, m, apiUnix) {
            return o + "~~" + d + "~~" + m + "~~" + apiUnix;
        }
        function sbRejectCacheEntry(reason, key, extra) {
            flash(JSON.stringify({
                timestamp: Date.now(),
                generationId: global('TDS_Active_Generation') || null,
                component: "Sandbox",
                severity: "warn",
                code: "CACHE_ENTRY_REJECTED",
                tripId: null,
                details: Object.assign({ reason: reason, key: key }, extra || {})
            }));
        }
        function sbReadCacheJson(filePath, kind) {
            let raw = "";
            try { raw = readFile(filePath) || ""; } catch (e) { return null; }
            if (!raw) return null;
            try {
                let obj = JSON.parse(raw);
                if (!obj || obj.schemaVersion !== 1 || !obj.entries || typeof obj.entries !== "object") return null;
                let out = {};
                let keys = Object.keys(obj.entries);
                for (let i = 0; i < keys.length; i++) {
                    let e = obj.entries[keys[i]];
                    if (kind === "temp") {
                        if (!e || typeof e !== "object") { sbRejectCacheEntry("temp entry not an object", keys[i]); continue; }
                        if (typeof e.originCell !== "string" || typeof e.destinationCell !== "string" || typeof e.mode !== "string"
                            || typeof e.meanDurationSecs !== "number" || !isFinite(e.meanDurationSecs) || typeof e.sampleCount !== "number" || !isFinite(e.sampleCount)
                            || typeof e.m2 !== "number" || !isFinite(e.m2) || typeof e.distanceMiles !== "number" || !isFinite(e.distanceMiles)
                            || typeof e.apiUnix !== "number" || !isFinite(e.apiUnix) || typeof e.targetUnix !== "number" || !isFinite(e.targetUnix)
                            || e.dayClass === undefined || e.bucket === undefined
                            || (e.dayClass !== null && (typeof e.dayClass !== "number" || !isFinite(e.dayClass)))
                            || (e.bucket !== null && (typeof e.bucket !== "number" || !isFinite(e.bucket)))
                            || typeof e.createdAt !== "number" || typeof e.updatedAt !== "number") {
                            sbRejectCacheEntry("temp entry malformed fields", keys[i]); continue;
                        }
                        if (typeof e.expiresAt !== "number" || e.expiresAt <= nowSec) { sbRejectCacheEntry("temp entry expired", keys[i], { expiresAt: e.expiresAt }); continue; }
                        if (!(e.meanDurationSecs > 0)) { sbRejectCacheEntry("temp entry nonpositive duration", keys[i]); continue; }
                        if (sbTempKey(e.originCell, e.destinationCell, e.mode, e.apiUnix) !== keys[i]) { sbRejectCacheEntry("temp key mismatch", keys[i]); continue; }
                        out[keys[i]] = e;
                        continue;
                    }
                    // route kind: replicate rcmFilterRouteEntries exactly
                    if (!e || typeof e !== "object") { sbRejectCacheEntry("route entry not an object", keys[i]); continue; }
                    if (typeof e.originCell !== "string" || typeof e.destinationCell !== "string" || typeof e.mode !== "string"
                        || typeof e.meanDurationSecs !== "number" || !isFinite(e.meanDurationSecs) || typeof e.sampleCount !== "number" || !isFinite(e.sampleCount)
                        || typeof e.m2 !== "number" || !isFinite(e.m2) || typeof e.distanceMiles !== "number" || !isFinite(e.distanceMiles)
                        || typeof e.dayClass !== "number" || (e.bucket !== null && typeof e.bucket !== "number") || typeof e.createdAt !== "number" || typeof e.updatedAt !== "number") {
                        sbRejectCacheEntry("route entry malformed fields", keys[i]); continue;
                    }
                    if (e.mode === CACHE_MODE_WALK && e.bucket !== null) { sbRejectCacheEntry("walk entry must have null bucket", keys[i]); continue; }
                    if (e.mode !== CACHE_MODE_WALK && e.bucket === null) { sbRejectCacheEntry("non-walk entry must have numeric bucket", keys[i]); continue; }
                    if (typeof e.expiresAt !== "number" || e.expiresAt <= nowSec) { sbRejectCacheEntry("route entry expired", keys[i], { expiresAt: e.expiresAt }); continue; }
                    if (!(e.meanDurationSecs > 0)) { sbRejectCacheEntry("route entry nonpositive duration", keys[i]); continue; }
                    if (sbRouteKey(e.originCell, e.destinationCell, e.mode, e.bucket, e.dayClass) !== keys[i]) { sbRejectCacheEntry("route key/bucket mismatch", keys[i]); continue; }
                    out[keys[i]] = e;
                }
                return out;
            } catch (e) { return null; }
        }

        // Temp tier (session samples): fresh samples (pulled within the live
        // threshold) win the first getCachedTime pass; the tod/dayClass master
        // pass and the no-recency fallback keep the legacy semantics.
        let ramTier = [];
        let tempJson = sbReadCacheJson(DATA_ROOT + "Temp_Route_Cache.json", "temp");
        if (tempJson) {
            let tKeys = Object.keys(tempJson);
            for (let r = 0; r < tKeys.length; r++) {
                let e = tempJson[tKeys[r]];
                if (typeof e.meanDurationSecs !== "number" || !(e.meanDurationSecs > 0)
                    || typeof e.originCell !== "string" || typeof e.destinationCell !== "string" || typeof e.mode !== "string") continue;
                ramTier.push({ o: e.originCell, d: e.destinationCell, m: e.mode, dur: e.meanDurationSecs, dist: (typeof e.distanceMiles === "number") ? e.distanceMiles : 0, pulledSec: (typeof e.apiUnix === "number") ? e.apiUnix : 0 });
            }
        }

        // Master tier (Welford cache): mean/bucket/dayClass map 1:1 from the
        // JSON entry (bucket null -> legacy tod -999 sentinel for WALK).
        let ssdTier = [];
        let routeJson = sbReadCacheJson(DATA_ROOT + "TDS_Route_Cache.json", "route");
        if (routeJson) {
            let rKeys = Object.keys(routeJson);
            for (let s = 0; s < rKeys.length; s++) {
                let e = routeJson[rKeys[s]];
                if (typeof e.meanDurationSecs !== "number" || !(e.meanDurationSecs > 0)
                    || typeof e.originCell !== "string" || typeof e.destinationCell !== "string" || typeof e.mode !== "string") continue;
                ssdTier.push({ o: e.originCell, d: e.destinationCell, m: e.mode, meanDur: e.meanDurationSecs, updatedSec: (typeof e.updatedAt === "number") ? e.updatedAt : 0, tod: (e.bucket === null) ? -999 : e.bucket, dayType: (typeof e.dayClass === "number") ? e.dayClass : -999 });
            }
        }

        let simAtBase = false;
        let oldItin = readActiveGeneration("itinerary");

        const liveAtBase = (global('User_At_Base') === "true");
        const currentStatus = (global('Current_Status') || "").trim();
        const activeInProgress = /^(Driving|Walking|Public Transport|Lift)/i.test(currentStatus);

        if (oldItin.length > 0) {
            let aLeg = oldItin[oldItin.length - 1];
            const priorLegAtBase = (aLeg.mode === "EOD_RETURN" || aLeg.pitstopState === "end_of_day") ? "true" : "false";
            if (activeInProgress) {
                simAtBase = false;
            } else if (liveAtBase) {
                if (priorLegAtBase === "false") {
                    flash(JSON.stringify({
                        timestamp: nowSec,
                        generationId: global('TDS_Active_Generation') || null,
                        component: "Sandbox",
                        severity: "WARN",
                        code: "LIVE_BASE_OVERRIDES_LEGACY_ORIGIN",
                        tripId: null,
                        details: { oldItinLength: oldItin.length, userAtBase: "true", priorSimAtBase: false }
                    }));
                }
                simAtBase = true;
            } else {
                simAtBase = (priorLegAtBase === "true");
            }
        } else {
            simAtBase = liveAtBase;
        }

        // Slice A: explicit SCH-3 origin source for the head leg, derived
        // from pass state only — never from event-id suffix inference.
        let passOriginSource = "LEGACY_ITINERARY_FALLBACK";
        if (activeInProgress) {
            passOriginSource = "ACTIVE_PLANNED_TRIP";
        } else if (liveAtBase) {
            passOriginSource = "LIVE_BASE";
        } else if (oldItin.length === 0) {
            passOriginSource = "LIVE_LOCATION";
        } else if (simAtBase) {
            passOriginSource = "OVERNIGHT_BASE_RESET";
        }
        // Slice A: the chain's local planning day, seeded at the pass start
        // and overridden by the head event's own local day at loop entry.
        let chainPlanningDay = localPlanningDay(nowSec);

        // Phase 6 (REQ-6STATE-2): per-pass lateness-halt reset. Delivered as a
        // staged OBSERVE_LATENESS_HALT so the reducer owns latenessHalt and
        // project() owns the TDS_Lateness_Halt projection. This runs only after
        // the pass has read its live User_At_Base/Current_Status/Base_Arrival_Unix
        // inputs — a reducer commit here would otherwise re-project stale state
        // bytes over those inputs before they are consumed.
        stageReducerCommand('OBSERVE_LATENESS_HALT', { generationId: global('TDS_Active_Generation') || "gen:0:0000", halt: false, at: nowSec });

        // INV-0.3: a fresh pass with a stale away itinerary and live base must
        // plan from the actual base coords, not from the stale virtual origin.
        // Only rebind for the first leg of this pass; chain math carries
        // state.loc forward after the first emission. The live base is a stable
        // origin, so the first leg is eligible for JIT planning.
        if (oldItin.length > 0 && liveAtBase && !activeInProgress) {
            state.loc = getBase(state.time).coords;
            state.isStableOrigin = true;
        }

        function getCachedTime(orig, dest, mode, targetUnix) {
            if (!orig || !dest || orig === "0,0" || dest === "0,0") return null;
            let isFuture = ((targetUnix - nowSec) > liveThreshold);
            if (!isFuture) {
                let bestRamDur = -1; let latestTimestamp = -1;
                for (let r = 0; r < ramTier.length; r++) {
                    let item = ramTier[r];
                    if (item.o === orig && item.d === dest && item.m === mode) {
                        if ((nowSec - item.pulledSec) <= liveThreshold && item.pulledSec > latestTimestamp && !isNaN(item.dur) && item.dur > 0 && item.dur <= 86400) {
                            latestTimestamp = item.pulledSec; bestRamDur = item.dur;
                        }
                    }
                }
                if (bestRamDur !== -1) return bestRamDur; 
            }
            let d = new Date(targetUnix * 1000); let targetTod = (d.getHours() * 60) + d.getMinutes(); let targetDayType = (d.getDay() === 0 || d.getDay() === 6) ? 1 : 0;
            if (mode === "WALK") {
                for (let w = ssdTier.length - 1; w >= 0; w--) {
                    if (ssdTier[w].o === orig && ssdTier[w].d === dest && ssdTier[w].m === mode && !isNaN(ssdTier[w].meanDur) && ssdTier[w].meanDur > 0) return ssdTier[w].meanDur;
                }
            } else {
                for (let s = ssdTier.length - 1; s >= 0; s--) {
                    let row = ssdTier[s];
                    if (row.o === orig && row.d === dest && row.m === mode) {
                        if (isNaN(row.meanDur) || row.meanDur <= 0 || row.meanDur > 86400) continue;
                        if ((nowSec - row.updatedSec) < 900 && row.updatedSec > 0) return row.meanDur;
                        if (row.tod !== -999 && row.dayType === targetDayType) {
                            let diff = Math.abs(targetTod - row.tod);
                            if (diff > 720) diff = 1440 - diff;
                            if (diff <= 60) return row.meanDur;
                        }
                    }
                }
            }
            let bestRamDur = -1; let latestTimestamp = -1;
            for (let r = 0; r < ramTier.length; r++) {
                let item = ramTier[r];
                if (item.o === orig && item.d === dest && item.m === mode) {
                    if (item.pulledSec > latestTimestamp && !isNaN(item.dur) && item.dur > 0 && item.dur <= 86400) {
                        latestTimestamp = item.pulledSec; bestRamDur = item.dur;
                    }
                }
            }
            if (bestRamDur !== -1) return bestRamDur;
            return null;
        }

        function simulateChainArrival(startIndex, endIndex, startState, targetMode, skipEvId) {
            let sTime = startState.time; let sLoc = startState.loc; let sCarLoc = startState.carLoc;
            for (let m = startIndex; m <= endIndex; m++) {
                let sEv = master[m - 1]; let sEvId = getSafeId(sEv);
                if (skipEvId && sEvId === skipEvId) continue; 
                
                let sEvStart = forceSeconds(sEv.start); let sCoords = sEv.coords || "0,0"; let sDesc = sEv.desc || "";
                let isDepart = /(#leave|#depart)\b/i.test((sEv.title || "") + " " + sDesc);
                let sArrMatch = sDesc.match(/#arr:(\d+)/i); 
                let sDepMatch = sDesc.match(/(?:#dep:|#leave:)(\d+)/i);
                let sArrBuf = isDepart ? 0 : (sArrMatch ? parseInt(sArrMatch[1], 10) : defArrMins) * 60;
                let sDepBuf = isDepart ? 0 : (sDepMatch ? parseInt(sDepMatch[1], 10) : defDepMins) * 60;
                
                let travelSecs = 0; let recSecs = 0;
                if (targetMode === "DRIVE") {
                    let cDist = getDist(parseFloat(sLoc.split(",")[0]), parseFloat(sLoc.split(",")[1]), parseFloat(sCarLoc.split(",")[0]), parseFloat(sCarLoc.split(",")[1]));
                    if (cDist > 200) {
                        let cMode = getRecoveryMode(sLoc, sCarLoc, cDist);
                        recSecs = getCachedTime(sLoc, sCarLoc, cMode, sTime) || Math.round(cDist / getSpeed(cMode));
                        travelSecs += recSecs; sLoc = sCarLoc; 
                    }
                }
                let simRouteSecs = getCachedTime(sLoc, sCoords, targetMode, (sTime + recSecs)) || Math.round(getDist(parseFloat(sLoc.split(",")[0]), parseFloat(sLoc.split(",")[1]), parseFloat(sCoords.split(",")[0]), parseFloat(sCoords.split(",")[1])) / getSpeed(targetMode));
                travelSecs += simRouteSecs;
                
                let adHocObj = getRemainingStops(sEvId, sDesc, completedStopsRaw);
                travelSecs += adHocObj.secs;

                let testTime = sTime + recSecs + travelSecs;
                if (m === endIndex) return testTime;
                
                let sEvEnd = getTrimmedEnd(sEvId, forceSeconds(sEv.end), sEvStart, trimmedEventsRaw);
                let arr = sTime + travelSecs;
                let sIgnoredPref = getLatenessMode(sEvId, ignoredLateness);
                
                let doorTarget = isDepart ? (sEvStart + travelSecs) : (sEvStart - sArrBuf);

                if (sEv.isDropin) {
                    let openUnix = sTime;
                    let oMatch = sDesc.match(/#open:(\d{1,2}):?(\d{2})/i);
                    if (oMatch) {
                        let oD = new Date(sEvStart * 1000); oD.setHours(parseInt(oMatch[1], 10), parseInt(oMatch[2], 10), 0, 0);
                        openUnix = Math.floor(oD.getTime() / 1000);
                    }
                    sTime = Math.max(arr, openUnix) + (sEv.duration || 0) + sDepBuf;
                } else if (sIgnoredPref === "fixed") {
                    sTime = Math.max(arr, sEvEnd) + sDepBuf;
                } else {
                    sTime = Math.max(arr, doorTarget) + sArrBuf + (sEvEnd - sEvStart) + sDepBuf;
                }
                
                sLoc = sCoords; if (targetMode === "DRIVE") sCarLoc = sCoords; 
            }
            return sTime;
        }

        function simulateScenario(targetIdx, overrides) {
            let simTime = stateHistory[idx].time; let simLoc = stateHistory[idx].loc; let simCar = stateHistory[idx].carLoc;
            let targetResult = null; let maxDownstreamLate = 0;

            for (let m = idx; m <= master.length; m++) {
                let sEv = master[m - 1]; let sStart = forceSeconds(sEv.start); 
                let sId = getSafeId(sEv); let sCoords = sEv.coords || "0,0"; let sText = (sEv.title || "") + " " + (sEv.desc || "");
                let ov = overrides[m] || {};

                if (ov.skip || csvHasOccurrence(skippedEvents, sId) || hasExactOverride(sId, "skip")) continue;
                
                let sEnd = getTrimmedEnd(sId, forceSeconds(sEv.end), sStart, trimmedEventsRaw);
                if (ov.trimEnd) {
                    sEnd = Math.min(sEnd, ov.trimEnd);
                    if (sId.indexOf("_OUT") !== -1 || sId.indexOf("_IN") !== -1) {
                        sStart = Math.min(sStart, sEnd - 60);
                    }
                }

                let isDep = /(#leave|#depart)\b/i.test(sText);
                let arrM = (sEv.desc || "").match(/#arr:(\d+)/i); 
                let depM = (sEv.desc || "").match(/(?:#dep:|#leave:)(\d+)/i);
                let bufArr = isDep ? 0 : (arrM ? parseInt(arrM[1], 10) : defArrMins) * 60;
                let bufDep = isDep ? 0 : (depM ? parseInt(depM[1], 10) : defDepMins) * 60;
                
                let calc = calcMode(simLoc, sCoords, sEv.start ? sEv.start.toString() : "", sText, sId);
                let mode = ov.mode || calc.mode; let legSecs = 0;

                if (mode === "DRIVE") {
                    let dCar = getDist(parseFloat(simLoc.split(",")[0]), parseFloat(simLoc.split(",")[1]), parseFloat(simCar.split(",")[0]), parseFloat(simCar.split(",")[1]));
                    if (dCar > 200) {
                        let rMode = getRecoveryMode(simLoc, simCar, dCar);
                        legSecs += getCachedTime(simLoc, simCar, rMode, simTime) || Math.round(dCar / getSpeed(rMode));
                        simLoc = simCar;
                    }
                }

                legSecs += getCachedTime(simLoc, sCoords, mode, (simTime + legSecs)) || Math.round(getDist(parseFloat(simLoc.split(",")[0]), parseFloat(simLoc.split(",")[1]), parseFloat(sCoords.split(",")[0]), parseFloat(sCoords.split(",")[1])) / getSpeed(mode));
                
                let adHocObj = getRemainingStops(sId, sEv.desc || "", completedStopsRaw);
                legSecs += adHocObj.secs;

                let doorArr = simTime + legSecs;
                let doorTarget = isDep ? (sStart + legSecs) : (sStart - bufArr);
                let stepLate = Math.max(0, Math.ceil((doorArr - doorTarget) / 60));

                if (m === targetIdx) targetResult = { arr: doorArr, late: stepLate };
                else if (m > targetIdx && stepLate > maxDownstreamLate) maxDownstreamLate = stepLate;

                let sIgnoredPref = getLatenessMode(sId, ignoredLateness);
                
                if (sEv.isDropin) {
                    let openUnix = simTime;
                    let oMatch = sText.match(/#open:(\d{1,2}):?(\d{2})/i);
                    if (oMatch) {
                        let oD = new Date(sStart * 1000); oD.setHours(parseInt(oMatch[1], 10), parseInt(oMatch[2], 10), 0, 0);
                        openUnix = Math.floor(oD.getTime() / 1000);
                    }
                    simTime = Math.max(doorArr, openUnix) + (sEv.duration || 0) + bufDep;
                } else if (sIgnoredPref === "fixed") {
                    simTime = Math.max(doorArr, sEnd) + bufDep;
                } else {
                    simTime = Math.max(doorArr, doorTarget) + bufArr + (sEnd - sStart) + bufDep;
                }
                
                simLoc = sCoords; if (mode === "DRIVE") simCar = sCoords;
            }
            return { target: targetResult, maxSpill: maxDownstreamLate };
        }

        function buildSubEnvelope(titleStr, labelsArr, payloadsArr) {
            return JSON.stringify({ config: { notify: false }, menu: { title: titleStr, labels: labelsArr, s: payloadsArr } });
        }

        for (let i = idx; i <= master.length; i++) {
            let ev = master[i - 1]; let evStart = forceSeconds(ev.start); 
            let evCoords = ev.coords || "0,0"; let evStartStr = ev.start ? ev.start.toString() : "";
            let evTitle = (ev.title || "Event").replace(/^(Start:|End:)\s*/i, "");
            let evId = getSafeId(ev);
            let evLoc = ev.loc || "Unknown Location"; let evDesc = ev.desc || "";
            let evText = evTitle + " " + evDesc;
            
            let isPrevBase = simAtBase;
            let isEssential = ev.isEssential || /(#essential)/i.test(evText);

            let evEnd = getTrimmedEnd(evId, forceSeconds(ev.end), evStart, trimmedEventsRaw);
            let evDeadline = ev.deadline ? forceSeconds(ev.deadline) : evEnd;
            stateHistory[i] = { time: state.time, loc: state.loc, carLoc: state.carLoc };

            let distToEventDirect = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(evCoords.split(",")[0]), parseFloat(evCoords.split(",")[1]));
            let activeGeoLatch    = global('Active_Geo_Latch') || "";
            let isMeetingLatched  = (activeGeoLatch === "MEET~" + evId);

            // Slice A (AC-3/AC-7): the chain terminates at the local
            // planning-day boundary. The head leg is always planned, even
            // when it lands on the next local day (DST-late events); any
            // later event whose local day differs ends the chain with an EOD
            // return so tomorrow's rows survive for the next pass. No
            // cross-day chain propagation.
            let evPlanningDay = localPlanningDay(evStart);
            if (i === idx) {
                chainPlanningDay = evPlanningDay;
            } else if (chainPlanningDay !== evPlanningDay) {
                let activeBase = getBase(state.time);
                let distToBase = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1]));
                if (distToBase > 300) {
                    let eodModeB = calcMode(state.loc, activeBase.coords, "", "", "").mode;
                    let carDistB = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]));
                    if (carDistB > 200 && eodModeB === "DRIVE") {
                        let recModeB = getRecoveryMode(state.loc, state.carLoc, carDistB);
                        let rTimeB = getCachedTime(state.loc, state.carLoc, recModeB, state.time) || Math.round(carDistB / getSpeed(recModeB));
                        enqueueTypedRow({ rowType: "RECOVERY", title: "Car", coords: state.carLoc, mode: recModeB, displayTime: state.time, departTime: (state.time + rTimeB), pitstopState: "false", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: "REC_BND_" + evId, evLoc: state.carLoc, engineLateMins: 0, currentLegStable: false, dropinStatusFlag: "none", safeDesc: "Vehicle Retrieval", adHoc: [], departurePolicy: "ASAP", planningDay: chainPlanningDay });
                        state.time += rTimeB;
                        state.loc = state.carLoc;
                    }
                    enqueueTypedRow({ rowType: "EOD_RETURN", title: activeBase.name, coords: activeBase.coords, mode: eodModeB, displayTime: state.time, departTime: (state.time + 3600), pitstopState: "end_of_day", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: "EOD_BND_" + evId, evLoc: activeBase.name, engineLateMins: 0, currentLegStable: true, dropinStatusFlag: "none", safeDesc: "Return Journey", adHoc: [], departurePolicy: "ASAP", planningDay: chainPlanningDay });
                    simAtBase = true;
                    state.loc = activeBase.coords;
                    if (eodModeB === "DRIVE") state.carLoc = activeBase.coords;
                    flash(JSON.stringify({
                        timestamp: nowSec,
                        generationId: global('TDS_Active_Generation') || null,
                        component: "Sandbox",
                        severity: "INFO",
                        code: "OVERNIGHT_BOUNDARY_CREATED",
                        tripId: null,
                        details: { boundaryDay: evPlanningDay, chainDay: chainPlanningDay, skipIdx: i }
                    }));
                }
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: global('TDS_Active_Generation') || null,
                    component: "Sandbox",
                    severity: "INFO",
                    code: "CROSS_DAY_CHAIN_REJECTED",
                    tripId: evId,
                    details: { boundaryDay: evPlanningDay, chainDay: chainPlanningDay, skipIdx: i }
                }));
                skipIdx = i;
                break;
            }

            // Observation marker is case-insensitive: cores like "walk_out"
            // carry the movement marker in lowercase while some sources emit
            // uppercase "_OUT" (legacy structural convention, not a suffix
            // inference). Match both so the observation row is enqueued and
            // the tail EOD return stays suppressed.
            if (evId.toUpperCase().indexOf("_OUT") !== -1 && (distToEventDirect < 300 || isMeetingLatched)) {
                let sDepMatch = evDesc.match(/(?:#dep:|#leave:)(\d+)/i);
                let evDepBufSecs = (sDepMatch ? parseInt(sDepMatch[1], 10) : defDepMins) * 60;
                state.time = Math.max(state.time, evEnd) + evDepBufSecs;
                state.loc = evCoords;
                simAtBase = false;
                skipIdx = i + 1;
                // Slice B (INV-0.4): represent the observed movement as an
                // observation row (WALK), not a planning instruction. The
                // pass must still emit a queue so downstream knows the user
                // moved, but the tail EOD return is suppressed below.
                enqueueTypedRow({ rowType: "WALK", title: evTitle, coords: evCoords, mode: "WALK", displayTime: state.time, departTime: evEnd, pitstopState: "false", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: evId, evLoc: evLoc, engineLateMins: 0, currentLegStable: true, dropinStatusFlag: "none", safeDesc: encodeURIComponent(evDesc), adHoc: [], departurePolicy: "JIT", planningDay: chainPlanningDay });
                continue;
            }

            if (evStart > sevenDayHorizonSec) {
                let activeBase = getBase(state.time);
                let distToBase = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1]));

                if (distToBase > 300) {
                    let distToNextEv = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(evCoords.split(",")[0]), parseFloat(evCoords.split(",")[1]));
                    let timeGapSecs  = evStart - state.time;

                    if (distToNextEv > 500 || timeGapSecs > RELEVANCE_WINDOW_SECS) {
                        let eodMode = calcMode(state.loc, activeBase.coords, "", "", "").mode;
                        let tailInheritedId = "EOD_EARLY_" + (master[i - 2] ? getSafeId(master[i - 2]) : "DEFAULT");

                        let carDistToBase = getDist(parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]), parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1]));
                        if (carDistToBase > 300) eodMode = "DRIVE";

                        let carDistEOD = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]));
                        if (eodMode === "DRIVE" && carDistEOD > 200) {
                            let recModeEOD = getRecoveryMode(state.loc, state.carLoc, carDistEOD);
                            let rTimeEOD = getCachedTime(state.loc, state.carLoc, recModeEOD, state.time) || Math.round(carDistEOD / getSpeed(recModeEOD));
                            
                            enqueueTypedRow({ rowType: "RECOVERY", title: "Car", coords: state.carLoc, mode: recModeEOD, displayTime: state.time, departTime: (state.time + rTimeEOD), pitstopState: "false", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: "REC_" + tailInheritedId, evLoc: state.carLoc, engineLateMins: 0, currentLegStable: false, dropinStatusFlag: "none", safeDesc: "Vehicle Retrieval", adHoc: [], departurePolicy: "ASAP" });
                            state.time += rTimeEOD; 
                            state.loc = state.carLoc;
                        }

                        enqueueTypedRow({ rowType: "EOD_RETURN", title: activeBase.name, coords: activeBase.coords, mode: eodMode, displayTime: state.time, departTime: (state.time + 3600), pitstopState: "end_of_day", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: tailInheritedId, evLoc: activeBase.name, engineLateMins: 0, currentLegStable: true, dropinStatusFlag: "none", safeDesc: "Return Journey", adHoc: [], departurePolicy: "ASAP" });
                        state.loc = activeBase.coords;
                        if (eodMode === "DRIVE") state.carLoc = activeBase.coords;
                    } else state.loc = activeBase.coords;
                }
                 skipIdx = master.length + 99; break;
            }
            
            let isDepart = /(#leave|#depart)\b/i.test(evText);
            let arrMatch = evDesc.match(/#arr:(\d+)/i); 
            let depMatch = evDesc.match(/(?:#dep:|#leave:)(\d+)/i);
            let evArrBufSecs = isDepart ? 0 : (arrMatch ? parseInt(arrMatch[1], 10) : defArrMins) * 60;
            let evDepBufSecs = isDepart ? 0 : (depMatch ? parseInt(depMatch[1], 10) : defDepMins) * 60;
            
            let evStartTarget = isDepart ? evStart + (getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(evCoords.split(",")[0]), parseFloat(evCoords.split(",")[1])) / 13.0) : evStart - evArrBufSecs;

            let isBypassed = ((csvHasOccurrence(ignoredLateness, evId) || hasExactOverride(evId, "ignoreLateness")) || /(#late)\b/i.test(evText));
            
            let openUnix = state.time;
            let closeUnix = 2000000000;
            let isAttachedDropin = false;
            let isNormalStrict = false;

            if (ev.isDropin) {
                let oMatch = evDesc.match(/#open:(\d{1,2}):?(\d{2})/i);
                if (oMatch) {
                    let oD = new Date(evStart * 1000); oD.setHours(parseInt(oMatch[1], 10), parseInt(oMatch[2], 10), 0, 0);
                    openUnix = Math.floor(oD.getTime() / 1000);
                }

                let cMatch = evDesc.match(/#close:(\d{1,2}):?(\d{2})/i);
                if (cMatch) {
                    let cD = new Date(evStart * 1000); cD.setHours(parseInt(cMatch[1], 10), parseInt(cMatch[2], 10), 0, 0);
                    closeUnix = Math.floor(cD.getTime() / 1000);
                }

                if (!isEssential) isBypassed = true;
                
                let nextStrict = null;
                for (let j = i + 1; j <= master.length; j++) { if (!master[j-1].isDropin) { nextStrict = master[j-1]; break; } }
                
                if (nextStrict) {
                    let nC = nextStrict.coords.split(",");
                    let sLocP = state.loc.split(",");
                    let ghostDriveSecs = Math.round(getDist(parseFloat(sLocP[0]), parseFloat(sLocP[1]), parseFloat(nC[0]), parseFloat(nC[1])) / 13.0);
                    let nArrMatch = (nextStrict.desc || "").match(/#arr:(\d+)/i);
                    let nArrBuf = nArrMatch ? (parseInt(nArrMatch[1], 10) * 60) : (defArrMins * 60);
                    
                    let ghostArrival = forceSeconds(nextStrict.start) - nArrBuf;
                    let ghostDepart = ghostArrival - ghostDriveSecs;
                    
                    if (evStart >= (ghostDepart - 7200) && evStart <= (ghostArrival + 7200)) {
                        isAttachedDropin = true;
                    }
                } else {
                    if (Math.abs(evStart - state.time) < 43200) isAttachedDropin = true;
                }
                
                if (isAttachedDropin) {
                    if (isPrevBase && nextStrict) {
                        let nC = nextStrict.coords.split(",");
                        let eLocP = evCoords.split(",");
                        let baseDriveSecs = Math.round(getDist(parseFloat(eLocP[0]), parseFloat(eLocP[1]), parseFloat(nC[0]), parseFloat(nC[1])) / 13.0);
                        
                        let nArrMatch = (nextStrict.desc || "").match(/#arr:(\d+)/i);
                        let nArrBuf = nArrMatch ? (parseInt(nArrMatch[1], 10) * 60) : (defArrMins * 60);
                        let adHocObjDropin = getRemainingStops(evId, evDesc, completedStopsRaw);
                        
                        let strictAnchor = forceSeconds(nextStrict.start) - nArrBuf - baseDriveSecs - (ev.duration || 1800) - adHocObjDropin.secs - evDepBufSecs;
                        
                        evStartTarget = Math.min(strictAnchor, closeUnix - (ev.duration || 1800));
                        
                        if (evStartTarget < openUnix) {
                            let dayTag = getDayPrefix(evStart, nowSec);
                            let paradoxMenu = {
                                title: "⚠️ [" + dayTag + "] Early Drop-in Paradox: " + evTitle.replace(/[~|,]/g, ""),
                                labels: ["Skip Drop-in to save downstream Event", "Wait for open (Will make you late)"],
                                s: ["SKIP_EVENT|" + evId, "IGNORE_paradox|" + evId]
                            };
                            stepConflict = JSON.stringify({ config: { notify: true, notifyTitle: "Drop-in Paradox", notifyText: "Arriving before open breaks timeline." }, menu: paradoxMenu });
                            stageReducerCommand('OBSERVE_LATENESS_HALT', { generationId: global('TDS_Active_Generation') || "gen:0:0000", halt: true, at: nowSec }); queue = []; skipIdx = idx; blockMode = null; break;
                        }
                    } else {
                        evStartTarget = closeUnix - (ev.duration || 0) - evArrBufSecs;
                    }
                } else {
                    evStartTarget = evStart - evArrBufSecs;
                    evStartTarget = Math.min(evStartTarget, closeUnix - (ev.duration || 0) - evArrBufSecs);
                    evStartTarget = Math.max(evStartTarget, openUnix);
                    isNormalStrict = true;
                    ev.isDropin = false; 
                }
            }

            if (evDeadline <= state.time || csvHasOccurrence(skippedEvents, evId) || hasExactOverride(evId, "skip")) { skipIdx = i + 1; continue; }
            
            let routeToEv = calcMode(state.loc, evCoords, evStartStr, evText, evId);
            if (routeToEv.isForced) isBypassed = true;

            let arrivalSkipRadius = routeToEv.isForced ? 50 : 200;

            if (!ev.isDropin && (distToEventDirect < arrivalSkipRadius || (isMeetingLatched && distToEventDirect < 1000)) && (evStart - state.time) < 10800 && state.time < evDeadline) {
                let currentIgnoredPref = getLatenessMode(evId, ignoredLateness);
                if (currentIgnoredPref === "fixed") state.time = Math.max(state.time, evEnd) + evDepBufSecs;
                else state.time = Math.max(state.time, evStartTarget) + evArrBufSecs + (evEnd - evStart) + evDepBufSecs;
                state.loc = evCoords; 
                simAtBase = false;
                skipIdx = i + 1; continue;
            }

            if (!blockMode) blockMode = routeToEv.mode;

            let estTravelSecs = 0; let recWalkSecs = 0; let actualDriveDist = routeToEv.dist; 
            let originLeg = state.loc; let legWalkDist = 0;

            let carDist = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]));

            if (routeToEv.mode === "DRIVE" && carDist > 200) {
                let recMode4 = getRecoveryMode(state.loc, state.carLoc, carDist);
                recWalkSecs = getCachedTime(state.loc, state.carLoc, recMode4, state.time) || Math.round(carDist / getSpeed(recMode4));
                estTravelSecs += recWalkSecs;
                actualDriveDist = getDist(parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]), parseFloat(evCoords.split(",")[0]), parseFloat(evCoords.split(",")[1]));
                originLeg = state.carLoc;
                if (recMode4 === "WALK") legWalkDist += carDist;
            } else if (routeToEv.mode === "WALK") { legWalkDist += routeToEv.dist; }

            let preGap = 0;
            if (ev.isDropin && isAttachedDropin) {
                preGap = (openUnix > state.time) ? (openUnix - state.time) : 0;
            } else {
                preGap = evStartTarget - state.time;
            }

            let activeBase = getBase(state.time);
            let pitstopState = "false"; 
            let distToBaseCheck = activeBase.coords !== "0,0" ? getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1])) : 99999;
            
            if (preGap > 0 && activeBase.coords !== "0,0" && distToBaseCheck > 300 && !(csvHasOccurrence(getOvr('Skipped_Pitstops'), evId) || hasExactOverride(evId, "pitstop", "skipped"))) {
                let routeToBase = calcMode(state.loc, activeBase.coords, evStartStr, "", evId); let recTimeBase = 0;
                
                let carDistToBasePit = getDist(parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]), parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1]));
                if (carDistToBasePit > 300) routeToBase.mode = "DRIVE";

                if (routeToBase.mode === "DRIVE" && carDist > 200) {
                    let cRecMode = getRecoveryMode(state.loc, state.carLoc, carDist);
                    recTimeBase = getCachedTime(state.loc, state.carLoc, cRecMode, state.time) || Math.round(carDist / getSpeed(cRecMode));
                }
                let timeToBase = getCachedTime(state.carLoc, activeBase.coords, routeToBase.mode, (state.time + recTimeBase)) || Math.round(routeToBase.dist / getSpeed(routeToBase.mode));
                
                let tempCarLoc = (routeToBase.mode === "DRIVE") ? activeBase.coords : state.carLoc;
                let tempCarDist = getDist(parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1]), parseFloat(tempCarLoc.split(",")[0]), parseFloat(tempCarLoc.split(",")[1]));
                
                let routeBaseToEv = calcMode(activeBase.coords, evCoords, evStartStr, evText, evId); let recTimeEv = 0;
                let estPitLeave = state.time + recTimeBase + timeToBase + 1800;
                if (routeBaseToEv.mode === "DRIVE" && tempCarDist > 200) {
                     let cRecMode2 = getRecoveryMode(activeBase.coords, tempCarLoc, tempCarDist);
                     recTimeEv = getCachedTime(activeBase.coords, tempCarLoc, cRecMode2, estPitLeave) || Math.round(tempCarDist / getSpeed(cRecMode2));
                }
                let timeBaseToEv = getCachedTime(tempCarLoc, evCoords, routeBaseToEv.mode, (estPitLeave + recTimeEv)) || Math.round(routeBaseToEv.dist / getSpeed(routeBaseToEv.mode));
                
                let totalDetour = recTimeBase + timeToBase + 1800 + recTimeEv + timeBaseToEv;
                let isForcedPitstop = (csvHasOccurrence(getOvr('Forced_Pitstops'), evId) || hasExactOverride(evId, "pitstop", "forced"));
                let isLongGap       = (preGap >= 10800); 

                if (isForcedPitstop || isLongGap) {
                    if ((state.time + totalDetour) > evStartTarget) { 
                        let dayTag = getDayPrefix(evStart, nowSec);
                        let safeEvTitle = evTitle.replace(/[~|,]/g, "");
                        let pitMenu = {
                            title: "⚠️ [" + dayTag + "] Pitstop Conflict: " + activeBase.name,
                            labels: ["Skip Pitstop & go straight to " + safeEvTitle, "Force Pitstop (Arrive " + Math.ceil((state.time + totalDetour - evStartTarget)/60) + "m late)"],
                            s: ["SKIP_PITSTOP|" + evId, "FORCE_PITSTOP|" + evId]
                        };
                        stepConflict = JSON.stringify({ config: { notify: true, notifyTitle: "Pitstop Decision Required", notifyText: "Detour to " + activeBase.name + " causes lateness." }, menu: pitMenu });
                        stageReducerCommand('OBSERVE_LATENESS_HALT', { generationId: global('TDS_Active_Generation') || "gen:0:0000", halt: true, at: nowSec }); break; 
                    }
                    
                    let simArr = state.time + recTimeBase + timeToBase;
                    let simDep = evStartTarget - timeBaseToEv;
                    let stayDuration = simDep - simArr;

                    if (i === idx && distToBaseCheck < 300) {
                        stayDuration = simDep - baseArrivalUnix;
                    }

                    let isOvernight = (stayDuration >= 18000); 

                    let stopType     = isOvernight ? "EOD_RETURN" : "PITSTOP";
                    let stopIdPrefix = isOvernight ? "EOD_" : "PIT_";
                    let compositeId  = stopIdPrefix + evId; 
                    let stopDesc     = isOvernight ? "End of Day Return" : "Pitstop Break";
                    let pitFlag      = isOvernight ? "end_of_day" : "forced";

                    if (!blockMode) blockMode = routeToBase.mode;
                    if (routeToBase.mode === "DRIVE" && carDist > 200) {
                        let recMode3 = getRecoveryMode(state.loc, state.carLoc, carDist);
                        enqueueTypedRow({ rowType: "RECOVERY", title: "Car", coords: state.carLoc, mode: recMode3, displayTime: state.time, departTime: (state.time + recTimeBase), pitstopState: "false", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: "REC_PIT_" + evId, evLoc: state.carLoc, engineLateMins: 0, currentLegStable: false, dropinStatusFlag: "none", safeDesc: "Vehicle Retrieval", adHoc: [], departurePolicy: "ASAP" });
                        state.time += recTimeBase; state.loc = state.carLoc;
                    }
                    
                    let currentLegStable = (i === idx) ? state.isStableOrigin.toString() : "true";
                    let stopPolicy = (stopType === "EOD_RETURN" || pitFlag === "forced" || pitstopState === "handled" || pitstopState === "forced") ? "ASAP" : "JIT";
                    enqueueTypedRow({ rowType: stopType, title: activeBase.name, coords: activeBase.coords, mode: routeToBase.mode, displayTime: evStart, departTime: (state.time + timeToBase), pitstopState: pitFlag, apiTimeType: "DEPART", apiTimeUnix: state.time, evId: compositeId, evLoc: activeBase.name, engineLateMins: 0, currentLegStable: currentLegStable, dropinStatusFlag: "none", safeDesc: stopDesc, adHoc: [], departurePolicy: stopPolicy });
                    state.loc = activeBase.coords; 
                    state.time += timeToBase + (isOvernight ? 0 : 1800); 
                    if (routeToBase.mode === "DRIVE") state.carLoc = activeBase.coords;
                    pitstopState = "handled"; 
                    carDist = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]));
                    
                    simAtBase = true;
                    skipIdx = i; break; 
                } else if (preGap >= totalDetour) pitstopState = "possible";
            }

            // [ID-2] Strict occurrence-ID parsing (inlined copy; canonical: ID_Parser.js).
            // Reject malformed/out-of-range IDs; rejected events are skipped.
            const parsedId = parseOccurrenceId(evId, "Sandbox");
            if (!parsedId.ok) continue;
            const coreId = parsedId.coreId;
            let routeSig = originLeg + "^" + evCoords;
            let routineKey = coreId + "^" + routeSig; 
            let routeDefaults = getPrefs('Route_Defaults');

            if ((hasExactPref(coreId, routeSig, "IGNORELATENESS~fixed") || csvHasOccurrence(routeDefaults, routineKey + "^IGNORELATENESS~fixed")) && !csvHasOccurrence(ignoredLateness, evId) && !hasExactOverride(evId, "ignoreLateness")) {
                ignoredLateness += (ignoredLateness ? "," : "") + evId + "~fixed";
                notifQueue.push("Auto-Applied: " + evTitle + "|Routinely fixing end time based on history.|TDS_CLEAR_DEFAULT|" + routineKey + "^IGNORELATENESS~fixed|" + coreId);
            } else if ((hasExactPref(coreId, routeSig, "IGNORELATENESS~shifted") || csvHasOccurrence(routeDefaults, routineKey + "^IGNORELATENESS~shifted")) && !csvHasOccurrence(ignoredLateness, evId) && !hasExactOverride(evId, "ignoreLateness")) {
                ignoredLateness += (ignoredLateness ? "," : "") + evId + "~shifted";
                notifQueue.push("Auto-Applied: " + evTitle + "|Routinely accepting lateness based on history.|TDS_CLEAR_DEFAULT|" + routineKey + "^IGNORELATENESS~shifted|" + coreId);
            }
            if ((hasExactPref(coreId, routeSig, "IGNOREWALK") || csvHasOccurrence(routeDefaults, routineKey + "^IGNOREWALK")) && !csvHasOccurrence(ignoredWalks, evId) && !hasExactOverride(evId, "ignoreWalk")) {
                ignoredWalks += (ignoredWalks ? "," : "") + evId;
                notifQueue.push("Auto-Applied: " + evTitle + "|Routinely ignoring walk limits based on history.|TDS_CLEAR_DEFAULT|" + routineKey + "^IGNOREWALK|" + coreId);
            }
            
            let routeTimeSecs = getCachedTime(originLeg, evCoords, routeToEv.mode, (state.time + recWalkSecs)) || Math.round(actualDriveDist / getSpeed(routeToEv.mode));
            estTravelSecs += routeTimeSecs;
            dailyWalkDist += legWalkDist;

            let adHocObj = getRemainingStops(evId, evDesc, completedStopsRaw);
            estTravelSecs += adHocObj.secs;
            
            if (dailyWalkDist > maxWalk && !csvHasOccurrence(ignoredWalks, evId) && !hasExactOverride(evId, "ignoreWalk") && legWalkDist > 0) { 
                let dayTag = getDayPrefix(evStart, nowSec);
                let walkMenu = {
                    title: "🚶 [" + dayTag + "] Walk Limit Exceeded (" + Math.round(dailyWalkDist) + "m)",
                    labels: ["Convert leg to Lift", "Ignore limit for today"],
                    s: ["LIFT|" + evId, "IGNORE_WALK|" + evId]
                };
                stepConflict = JSON.stringify({ config: { notify: true, notifyTitle: "Walk Limit Reached", notifyText: "Daily walking threshold breached." }, menu: walkMenu });
                stageReducerCommand('OBSERVE_LATENESS_HALT', { generationId: global('TDS_Active_Generation') || "gen:0:0000", halt: true, at: nowSec }); break; 
            }

            let testTargetTime = state.time + estTravelSecs;
            let currentLegStable = (i === idx) ? state.isStableOrigin.toString() : "true";
            
            if (currentLegStable === "false" && i === idx) isBypassed = true;

            let trueDepartureTime;
            if (ev.isDropin && isAttachedDropin) {
                // Stop padding must appear exactly once: estTravelSecs already
                // carries adHocObj.secs into testTargetTime (and actualArrival),
                // so it is NOT re-added to the departure gap (AGENTS.md:
                // stopPadSecs may not be added to both leg duration and the
                // forward-propagation gap).
                if (isPrevBase && evStartTarget > testTargetTime) {
                    let actualArrival = Math.max(testTargetTime, Math.max(openUnix, evStartTarget));
                    trueDepartureTime = actualArrival + (ev.duration || 0) + evDepBufSecs;
                } else {
                    let actualArrival = Math.max(testTargetTime, openUnix);
                    trueDepartureTime = actualArrival + (ev.duration || 0) + evDepBufSecs;
                }
            } else {
                let finalIgnoredPref = getLatenessMode(evId, ignoredLateness);
                if (finalIgnoredPref === "fixed") {
                    trueDepartureTime = Math.max(testTargetTime, evEnd) + evDepBufSecs;
                } else {
                    trueDepartureTime = Math.max(testTargetTime, evStartTarget) + evArrBufSecs + (evEnd - evStart) + evDepBufSecs;
                }
            }

            let lookAheadLate = 0;
            if (ev.isDropin && isAttachedDropin && !isBypassed) {
                let simTime = trueDepartureTime; 
                let simLoc = evCoords;
                for (let k = i + 1; k <= master.length; k++) {
                    let nEv = master[k-1];
                    if (nEv.isDropin || csvHasOccurrence(skippedEvents, getSafeId(nEv)) || hasExactOverride(getSafeId(nEv), "skip") || /(#late)\b/i.test(nEv.desc)) continue; 
                    
                    let nDist = getDist(parseFloat(simLoc.split(",")[0]), parseFloat(simLoc.split(",")[1]), parseFloat(nEv.coords.split(",")[0]), parseFloat(nEv.coords.split(",")[1]));
                    let nTravel = Math.round(nDist / 13.0); 
                    simTime += nTravel;
                    
                    let nTarget = forceSeconds(nEv.start) - (defArrMins * 60);
                    if (simTime > nTarget) {
                        lookAheadLate = Math.ceil((simTime - nTarget) / 60);
                    }
                    break; 
                }
            }

            let doorTarget = isDepart ? (evStart + estTravelSecs) : evStartTarget;
            let rawDeltaMins = Math.ceil((testTargetTime - doorTarget) / 60);
            let timeGapFromNow = evStart - nowSec;
            let engineLateMins = (timeGapFromNow <= RELEVANCE_WINDOW_SECS && Math.abs(rawDeltaMins) <= RAW_DELTA_BOUND_MINS) ? Math.max(0, rawDeltaMins) : 0;
            
            if (lookAheadLate > engineLateMins) engineLateMins = lookAheadLate;

            if ((testTargetTime > doorTarget || lookAheadLate > 0) && engineLateMins > 0 && !isBypassed) { 
                let dayTag = getDayPrefix(evStart, nowSec);
                let safeUIEvTitle = evTitle.replace(/[~|,]/g, "");
                
                let latenessStr = "";
                if (lookAheadLate > 0 && rawDeltaMins <= 0) {
                    latenessStr = "Projected +" + lookAheadLate + "m late for NEXT strict event";
                } else {
                    let actualLateMins = Math.ceil((testTargetTime - doorTarget) / 60);
                    let remBufferMins = Math.floor((doorTarget - testTargetTime) / 60);
                    latenessStr = (remBufferMins > 0) ? ("Buffer: " + remBufferMins + "m") : ("No buffer, " + Math.max(0, actualLateMins) + "m late");
                }
                
                let lateHeaderStr = "⚠️ [" + dayTag + "] " + safeUIEvTitle + " (" + latenessStr + ")";
                
                let defMode = "";
                if (hasExactPref(coreId, routeSig, "LIFT") || csvHasOccurrence(routeDefaults, routineKey + "^LIFT")) defMode = "LIFT";
                else if (hasExactPref(coreId, routeSig, "WALK") || csvHasOccurrence(routeDefaults, routineKey + "^WALK")) defMode = "WALK";
                else if (hasExactPref(coreId, routeSig, "DRIVE") || csvHasOccurrence(routeDefaults, routineKey + "^DRIVE")) defMode = "DRIVE";
                else if (hasExactPref(coreId, routeSig, "TRANSIT") || csvHasOccurrence(routeDefaults, routineKey + "^TRANSIT")) defMode = "TRANSIT";
                
                if (defMode !== "") {
                    let notifText = "Auto-selected " + defMode + " based on your routine history.";
                    let clrAction = "TDS_CLEAR_DEFAULT|" + routineKey + "^" + defMode;
                    notifQueue.push("Auto-Routed: " + safeUIEvTitle + "|" + notifText + "|" + clrAction + "|" + coreId);
                    
                    let ovrObj = {}; ovrObj[i] = { mode: defMode };
                    let simDef = simulateScenario(i, ovrObj);
                    
                    if (defMode === "DRIVE") enqueueTypedRow({ rowType: "FORCED_DRIVE", title: evTitle, coords: evCoords, mode: "DRIVE", displayTime: evStart, departTime: evStart, pitstopState: "false", apiTimeType: "DEPART", apiTimeUnix: evStart, evId: evId, evLoc: evLoc, engineLateMins: 0, currentLegStable: false, dropinStatusFlag: "none", safeDesc: safeUIEvTitle, adHoc: [], departurePolicy: "ASAP", planningDay: chainPlanningDay });
                    isBypassed = true;
                }
                
                if (!isBypassed) {
                    let rawOptions = [];
                    let tailId = getSafeId(master[master.length - 1]);
                    
                    let bountyQueue = [];
                    function getFlag(modeName) {
                        let isCached = getCachedTime(originLeg, evCoords, modeName, state.time) !== null;
                        if (!isCached) {
                            bountyQueue.push(originLeg + "~" + evCoords + "~" + modeName);
                            return " (No Data)";
                        }
                        return "";
                    }
                    
                    let currentStateObj = { time: state.time, loc: state.loc, carLoc: state.carLoc };
                    let tArr = simulateChainArrival(i, i, currentStateObj, "TRANSIT", null); let tLate = Math.max(0, Math.ceil((tArr - doorTarget) / 60));
                    if (routeToEv.mode === "DRIVE") {
                        rawOptions.push({ label: "Park & take Transit" + getFlag("TRANSIT"), payload: "TRANSIT|" + evId + "|" + routeSig, late: tLate });
                        let wArr = simulateChainArrival(i, i, currentStateObj, "WALK", null); let wLate = Math.max(0, Math.ceil((wArr - doorTarget) / 60));
                        rawOptions.push({ label: "Park & Walk from here" + getFlag("WALK"), payload: "WALK|" + evId + "|" + routeSig, late: wLate });
                    } else {
                        rawOptions.push({ label: "Take Transit instead" + getFlag("TRANSIT"), payload: "TRANSIT|" + evId + "|" + routeSig, late: tLate });
                        let lArr = simulateChainArrival(i, i, currentStateObj, "LIFT", null); let lLate = Math.max(0, Math.ceil((lArr - doorTarget) / 60));
                        rawOptions.push({ label: "Take Lift instead" + getFlag("LIFT"), payload: "LIFT|" + evId + "|" + routeSig, late: lLate });
                        let dArr = simulateChainArrival(i, i, currentStateObj, "DRIVE", null); let dLate = Math.max(0, Math.ceil((dArr - doorTarget) / 60));
                        rawOptions.push({ label: "Get Car now & Drive" + getFlag("DRIVE"), payload: "DRIVE_CHAIN|" + evId + "~" + tailId + "|" + routeSig, late: dLate });
                    }

                    let spamTracker = global('API_Spam_Tracker') || "";
                    let newTracker = []; let bMap = {};
                    if (spamTracker) {
                        let stP = spamTracker.split(",");
                        for(let x=0; x<stP.length; x++) { if(stP[x]) { let hp = stP[x].split("="); bMap[hp[0]] = parseInt(hp[1]); } }
                    }
                    
                    let triggerFetch = [];
                    for(let b=0; b<bountyQueue.length; b++) {
                        let key = bountyQueue[b];
                        bMap[key] = (bMap[key] || 0) + 1;
                        if (bMap[key] >= 3) triggerFetch.push(key);
                    }
                    
                    for (let key in bMap) newTracker.push(key + "=" + bMap[key]);
                    setGlobal('API_Spam_Tracker', newTracker.join(","));
                    if (triggerFetch.length > 0) setLocal('api_bounty_queue', triggerFetch.join("|"));

                    let deltaThreshold = 5;

                    for (let k = i - 1; k >= idx; k--) {
                        let pEv = master[k - 1]; let pId = getSafeId(pEv); 
                        let pTitle = (pEv.title || "step").replace(/^(Start:|End:)\s*/i, "").replace(/[~|,]/g, "");
                        let pIsEssential = pEv.isEssential || /(#essential)/i.test((pEv.title || "") + " " + (pEv.desc || ""));
                        
                        if (routeToEv.mode !== "DRIVE") {
                            let cArrD = simulateChainArrival(k, i, currentStateObj, "DRIVE", null); let cLateD = Math.max(0, Math.ceil((cArrD - doorTarget) / 60));
                            rawOptions.push({ label: "Get Car before " + pTitle + " & Drive", payload: "DRIVE_CHAIN|" + pId + "~" + tailId, late: cLateD });
                        }
                        
                        if (!(pIsEssential && !isEssential)) {
                            let simSkip = simulateScenario(i, { [k]: { skip: true } });
                            if (simSkip.target && simSkip.target.late < engineLateMins) {
                                let globalLateReduction = engineLateMins - Math.max(simSkip.target.late, simSkip.maxSpill);
                                if (simSkip.target.late === 0 || globalLateReduction >= deltaThreshold) {
                                    rawOptions.push({ label: "Skip '" + pTitle + "' entirely", payload: "SKIP_EVENT|" + pId, late: simSkip.target.late });
                                }
                            }
                        }
                        
                        let pEnd = getTrimmedEnd(pId, forceSeconds(pEv.end), forceSeconds(pEv.start), trimmedEventsRaw);
                        let evalStart = forceSeconds(pEv.start);
                        if (pId.indexOf("_OUT") !== -1) evalStart = Math.min(nowSec, forceSeconds(pEv.start) - 14400); 

                        let deadDrop = pEnd - ((engineLateMins - Math.max(0, Math.ceil((simulateChainArrival(k, i, currentStateObj, routeToEv.mode, pId) - doorTarget) / 60))) * 60);

                        if (deadDrop < pEnd && deadDrop > evalStart) {
                            let simTrim = simulateScenario(i, { [k]: { trimEnd: deadDrop } });
                            if (simTrim.target && simTrim.target.late < engineLateMins) {
                                let globalLateReduction = engineLateMins - Math.max(simTrim.target.late, simTrim.maxSpill);
                                if (simTrim.target.late === 0 || globalLateReduction >= deltaThreshold) {
                                    let dObj = new Date(deadDrop * 1000);
                                    let timeStr = ("0" + dObj.getHours()).slice(-2) + ":" + ("0" + dObj.getMinutes()).slice(-2);
                                    rawOptions.push({ label: "Leave '" + pTitle + "' early at " + timeStr, payload: "TRIM_EVENT|" + pId + "~" + deadDrop, late: simTrim.target.late });
                                }
                            }
                        }
                    }
                    
                    let uniqueOptsMap = {}; let validOptions = [];
                    for(let optIdx = 0; optIdx < rawOptions.length; optIdx++) {
                        let opt = rawOptions[optIdx];
                        if (opt.late < engineLateMins) {
                            if (!uniqueOptsMap[opt.payload] || uniqueOptsMap[opt.payload].late > opt.late) uniqueOptsMap[opt.payload] = opt;
                        }
                    }
                    for (let key in uniqueOptsMap) validOptions.push(uniqueOptsMap[key]);
                    validOptions.sort(function(a, b) { return a.late - b.late; });

                    let rootMenu = { title: lateHeaderStr, labels: [], s: [] };
                    
                    if (validOptions.length > 0) {
                        let best = validOptions[0];
                        rootMenu.labels.push("[★ BEST FIX] " + best.label + " (" + (best.late === 0 ? "On Time" : "+" + best.late + "m") + ")");
                        rootMenu.s.push(best.payload);
                    }
                    if (validOptions.length > 1) {
                        let runner = validOptions[1];
                        rootMenu.labels.push("[RUNNER UP] " + runner.label + " (" + (runner.late === 0 ? "On Time" : "+" + runner.late + "m") + ")");
                        rootMenu.s.push(runner.payload);
                    }
                    if (validOptions.length > 2) {
                        let subOpts = { title: "Alternative Options", labels: [], s: [] };
                        for (let j = 2; j < validOptions.length; j++) {
                            subOpts.labels.push(validOptions[j].label + " (" + (validOptions[j].late === 0 ? "On Time" : "+" + validOptions[j].late + "m") + ")");
                            subOpts.s.push(validOptions[j].payload);
                        }
                        rootMenu.labels.push("📂 Browse " + (validOptions.length - 2) + " other options...");
                        rootMenu.s.push(buildSubEnvelope("Alternative Options", subOpts.labels, subOpts.s));
                    }

                    let acceptSubLabels = ["Keep End Time Fixed (Shorter Event)", "Push End Time Later (Maintain Duration)"];
                    let acceptSubPayloads = ["IGNORELATENESS|" + evId + "~fixed|" + routeSig, "IGNORELATENESS|" + evId + "~shifted|" + routeSig];
                    
                    rootMenu.labels.push("Accept Lateness (" + latenessStr + ")");
                    rootMenu.s.push(buildSubEnvelope("Lateness Resolution", acceptSubLabels, acceptSubPayloads));
                    rootMenu.labels.push("Cancel '" + safeUIEvTitle + "'");
                    rootMenu.s.push("SKIP_EVENT|" + evId);
                    rootMenu.labels.push("🛑 Halt Engine (Manual Calendar Fix)");
                    rootMenu.s.push("HALT_ENGINE");

                    stepConflict = JSON.stringify({ config: { notify: true, notifyTitle: "⚠️ Late: " + safeUIEvTitle, notifyText: "Projected: " + latenessStr }, menu: rootMenu });
                    stageReducerCommand('OBSERVE_LATENESS_HALT', { generationId: global('TDS_Active_Generation') || "gen:0:0000", halt: true, at: nowSec }); queue = []; skipIdx = idx; blockMode = null; break; 
                } 
            }

            if (routeToEv.mode !== blockMode && queue.length > 0 && pitstopState !== "handled" && routeToEv.dist > 50) break;

            if (routeToEv.mode === "DRIVE" && carDist > 200) {
                let recMode5 = getRecoveryMode(state.loc, state.carLoc, carDist);
                let rTime = getCachedTime(state.loc, state.carLoc, recMode5, state.time) || Math.round(carDist / getSpeed(recMode5));
                enqueueTypedRow({ rowType: "RECOVERY", title: "Car", coords: state.carLoc, mode: recMode5, displayTime: state.time, departTime: (state.time + rTime), pitstopState: "false", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: "REC_EV_" + evId, evLoc: state.carLoc, engineLateMins: 0, currentLegStable: false, dropinStatusFlag: "none", safeDesc: "Vehicle Retrieval", adHoc: [], departurePolicy: "ASAP" });
                state.time += rTime; state.loc = state.carLoc; 
            }

            let apiTimeType = "DEPART"; 
            let apiTimeUnix = state.time;
            
            if (isPrevBase) {
                if (isDepart) {
                    apiTimeUnix = Math.max(state.time, evStart);
                } else if (ev.isDropin && isAttachedDropin) {
                    apiTimeUnix = Math.max(state.time, Math.max(openUnix, evStartTarget) - estTravelSecs);
                } else {
                    apiTimeUnix = Math.max(state.time, evStartTarget - estTravelSecs);
                }
            } else {
                apiTimeUnix = state.time;
            }
            
            let isWithinTravelWindow = false;
            let windowStartLimit = (isDepart ? evStart : evStartTarget) - 600;
            let windowEndLimit = evEnd;
            if (nowSec >= windowStartLimit && nowSec <= windowEndLimit) isWithinTravelWindow = true;

            if (i === 1 && idx === 1 && isWithinTravelWindow && (resolvedStatus.indexOf("Driving") !== -1 || resolvedStatus.indexOf("Walking") !== -1 || resolvedStatus.indexOf("Public Transport") !== -1 || resolvedStatus.indexOf("Lift") !== -1)) {
                apiTimeType = "ACTIVE_TRAVEL";
            }

            let holdUntil = parseInt(global('TDS_Hold_Until'), 10) || 0;
            if (i === idx && holdUntil > nowSec) {
                trueDepartureTime = Math.max(trueDepartureTime, holdUntil);
            }

            let displayTime = (ev.isDropin && isAttachedDropin) ? Math.max(state.time, openUnix) : evStart;
            let safeDesc = encodeURIComponent(evDesc);
            let dropinStatusFlag = (ev.isDropin && isAttachedDropin) ? "attached_dropin" : (isNormalStrict ? "detached_strict" : "none");
            
            const legPolicy = (() => {
                if (pitstopState === "end_of_day") return "ASAP";
                if (apiTimeType === "ACTIVE_TRAVEL" || activeInProgress || trueDepartureTime <= nowSec) return "ASAP";
                if (!isPrevBase) return "ASAP";
                if (dropinStatusFlag === "attached_dropin") return "ASAP";
                if (currentLegStable === "false" || pitstopState === "forced") return "ASAP";
                return "JIT";
            })();

            // INV-0.7 (C2): the EVENT row carries the leg's route metrics in
            // columns 17 (durationSecs) / 18 (distanceMiles) so the Compiler
            // can consume positive Sandbox metrics before any local estimate.
            // Only positive metrics are exported: a route duration that cannot
            // be established stays empty (never "0") so the Compiler's fallback
            // tiers or zero-duration rejection handle it.
            let routeDistMiles = parseFloat((actualDriveDist * METERS_TO_MILES).toFixed(1));
            let legDurCol = (routeTimeSecs > 0) ? String(routeTimeSecs) : "";
            let legDistCol = (routeDistMiles > 0) ? String(routeDistMiles) : "";
            enqueueTypedRow({ rowType: "EVENT", title: evTitle, coords: evCoords, mode: routeToEv.mode, displayTime: displayTime, departTime: trueDepartureTime, pitstopState: pitstopState, apiTimeType: apiTimeType, apiTimeUnix: apiTimeUnix, evId: evId, evLoc: evLoc, engineLateMins: engineLateMins, currentLegStable: currentLegStable, dropinStatusFlag: dropinStatusFlag, safeDesc: safeDesc, adHoc: adHocObj.arr, routeDurationSecs: legDurCol, routeDistanceMiles: legDistCol, departurePolicy: legPolicy });
            plannedEventSeen = true;

            if (i === idx) state.isStableOrigin = false;
            state.loc = evCoords; state.time = trueDepartureTime;
            if (routeToEv.mode === "DRIVE") state.carLoc = evCoords;
            simAtBase = false;
            skipIdx = i + 1; 
        }

        if (skipIdx > master.length && stepConflict === "") {
            if (!plannedEventSeen) {
                // Slice B (REQ-INV0_4-1): unplanned empty-day movement must
                // not create a return. No planned travel was enqueued this
                // pass, so a tail EOD return would be synthetic.
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: global('TDS_Active_Generation') || null,
                    component: "Sandbox",
                    severity: "INFO",
                    code: "SYNTHETIC_RETURN_SUPPRESSED",
                    tripId: null,
                    details: { reason: "observation-only day; no planned travel", queueRows: queue.length }
                }));
            } else {
            let eodBase = getBase(state.time);
            let distToEndBase = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(eodBase.coords.split(",")[0]), parseFloat(eodBase.coords.split(",")[1]));
            
            if (distToEndBase > 200) {
                let eodMode = calcMode(state.loc, eodBase.coords, "", "", "").mode;
                let finalAnchorId = "EOD_FINAL_" + (master.length > 0 ? getSafeId(master[master.length - 1]) : "DEFAULT");

                let carDistToBase = getDist(parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]), parseFloat(eodBase.coords.split(",")[0]), parseFloat(eodBase.coords.split(",")[1]));
                if (carDistToBase > 300) eodMode = "DRIVE";

                let carDistEOD = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]));
                if (eodMode === "DRIVE" && carDistEOD > 200) {
                    let recModeEOD = getRecoveryMode(state.loc, state.carLoc, carDistEOD);
                    let rTimeEOD = getCachedTime(state.loc, state.carLoc, recModeEOD, state.time) || Math.round(carDistEOD / getSpeed(recModeEOD));
                    enqueueTypedRow({ rowType: "RECOVERY", title: "Car", coords: state.carLoc, mode: recModeEOD, displayTime: state.time, departTime: (state.time + rTimeEOD), pitstopState: "false", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: "REC_EOD_FINAL", evLoc: state.carLoc, engineLateMins: 0, currentLegStable: false, dropinStatusFlag: "none", safeDesc: "Vehicle Retrieval", adHoc: [], departurePolicy: "ASAP" });
                    state.time += rTimeEOD; 
                    state.loc = state.carLoc;
                }

                enqueueTypedRow({ rowType: "EOD_RETURN", title: eodBase.name, coords: eodBase.coords, mode: eodMode, displayTime: state.time, departTime: (state.time + 3600), pitstopState: "end_of_day", apiTimeType: "DEPART", apiTimeUnix: state.time, evId: finalAnchorId, evLoc: eodBase.name, engineLateMins: 0, currentLegStable: true, dropinStatusFlag: "none", safeDesc: "Return Journey", adHoc: [], departurePolicy: "ASAP" });
                simAtBase = true;
            }
            }
        }

        // FU1 (REQ-6FU-1): one REDUCER_BATCH envelope per pass. In the serial
        // Tasker model only the final par1/par2 reaches TDS_State_Command, so
        // every observation staged this pass (arrival/leave, COMPLETE_TRIP,
        // OBSERVE_STATUS, lateness resets) is delivered as one ordered batch.
        // The harness shim already applied them synchronously, so the envelope
        // is staged WITHOUT a reducer call (never double-apply).
        if (stagedReducerCommands.length > 0) {
            setLocal('par1', 'REDUCER_BATCH');
            setLocal('par2', JSON.stringify({
                generationId: global('TDS_Active_Generation') || null,
                commands: stagedReducerCommands
            }));
        }
        stagedReducerCommands = [];

        // REQ-5QUEUE-1: the typed queue envelope — rows, EOF flag and the
        // skip/conflict/notification controls travel as one JSON document.
        // Tasker Variable Split never processes it; the Compiler parses it.
        setLocal('block_queue', JSON.stringify({
            schemaVersion: 1,
            rows: queue,
            eof: false,
            skipIdxUntil: skipIdx,
            stepConflict: (stepConflict === "") ? null : stepConflict,
            notifications: notifQueue
        }));
        setLocal('is_drive_block', (blockMode === "DRIVE") ? "true" : "false");
    }
} catch(e) { flash("Sandbox Crash: " + e.message); }
