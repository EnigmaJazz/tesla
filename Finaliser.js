// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";
// Normalize: a dataRoot without a trailing slash would silently concatenate into
// invalid paths (R4-WARNING on the extraction refactor).
if (DATA_ROOT.charAt(DATA_ROOT.length - 1) !== "/") { DATA_ROOT += "/"; }

// ==========================================
// SCRIPT 3: ENGINE FINALISER (v25.1)
// 12-Hour Geofence Limit: Only monitors locations starting within 12 hours.
// Geofence Limit: Stops generating geofences after the first strict event.
// Applies Sequence & Temporal Breaking to isolate Multi-Dropin Clustering.
// [V25.1] Time-Gap collision fix, Strict Event Purge Protection. Gravity threshold moved to Sandbox.
// ==========================================

function getDist(lat1, lon1, lat2, lon2) {
    let R = EARTH_RADIUS_M; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Named windows/radii (AGENTS.md: route radii, grace periods, and lookahead
// windows must be named, never bare literals).
const GEOFENCE_RADIUS_M = 200;          // arrival/departure geofence radius
const ARRIVAL_ACCURACY_M = 150;         // observed-arrival accuracy
const DEPARTURE_LEAD_SECS = 7200;       // eligibility pre-start window (2h)
const ELIGIBILITY_GRACE_SECS = 14400;   // post-end grace window (4h)
const GEOFENCE_LOOKAHEAD_SECS = 43200;  // 12h geofence generation limit

// INV-0.2: DST-safe LOCAL day-boundary comparison. The device timezone IS the
// configured timezone (no TZ config exists; Gatekeeper already derives its tod
// buckets from local getHours()). JS Date local getters resolve the local day
// exactly — a 23/24/25-hour day still has one unambiguous local midnight — so
// (y, m, d) equality is DST-safe by construction (unlike fixed-second math).
function isSameLocalDay(unixSecA, unixSecB) {
    const dA = new Date(unixSecA * 1000);
    const dB = new Date(unixSecB * 1000);
    return dA.getFullYear() === dB.getFullYear()
        && dA.getMonth() === dB.getMonth()
        && dA.getDate() === dB.getDate();
}

// Named sentinels/windows (AGENTS.md: no magic numbers, no bare literals).
const UNUSABLE_COORDS = "0,0";        // sentinel: no usable coordinates
const EARTH_RADIUS_M = 6371e3;         // haversine earth radius (getDist)
const MIN_BASE_STR_LEN = 3;            // raw_base_data entry length floor
const MIN_ADHOC_STR_LEN = 5;           // AdHoc_Base entry length floor

// Phase 2 reader cutover: discover the committed generation through the
// manifest. Canonical resolver (algorithm source of truth: TDS_Helper.js
// readActiveGeneration), inlined per repo convention; the legacy
// TDS_Master.json / Itin_Master.json files remain a fallback only while the
// migration is in flight. Finaliser publishes events + master + the carried
// itinerary, so the itinerary MUST come from the active generation — the
// legacy Itin_Master.json is no longer written since Phase 2 and reading it
// regressed the published itinerary on every pass.
function readJson(path) {
    const raw = readFile(path) || "";
    if (!raw || raw.indexOf("%") === 0) return null;
    try { return JSON.parse(raw); } catch (e) {
        // A present-but-corrupt file must be observable — silently turning it
        // into a miss hides stale/empty publishes (CACHE_ENTRY_REJECTED class).
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Finaliser", severity: "warn", code: "FILE_PARSE_FAILED", tripId: null,
            details: { path: path, reason: String(e && e.message || e) } }));
        return null;
    }
}
function pathFor(g, kind) {
    return DATA_ROOT + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + String(g).replace(/:/g, "_") + ".json";
}
function readActiveGeneration(kind) {
    const m = readJson(DATA_ROOT + "TDS_Run_Manifest.json");
    const key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
    if (m && m.state === "committed" && m.activeGeneration) {
        const p = m[key] || pathFor(m.activeGeneration, kind);
        const data = readJson(p);
        if (data !== null) return data;
        // A committed generation whose file is missing or corrupt must be
        // observable — the fallback chain (previous → legacy → []) would
        // otherwise mask a stale/empty publish with zero log trail.
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Finaliser", severity: "warn", code: "ACTIVE_GENERATION_READ_FAILED", tripId: null,
            details: { kind: kind, path: p, reason: "missing_or_corrupt" } }));
    }
    if (m && m.previousGeneration) {
        const data = readJson(pathFor(m.previousGeneration, kind));
        if (data !== null) return data;
    }
    const legacy = readJson(DATA_ROOT + (kind === "events" || kind === "master" ? "TDS_Master.json" : "Itin_Master.json"));
    if (legacy !== null) return legacy;
    return [];
}

// REQ-6F2-1/2: the serial Tasker model delivers only the LAST staged
// par1/par2 per pass, so reducer observations accumulate here and the
// Generation_Publisher merges them into the post-publish REDUCER_BATCH
// (mirrors the FU1 Sandbox stageReducerCommand / end-of-pass flush).
// var (not let) per the shared harness vm context convention below.
var observedReducerCommands = [];
// Byte-exact copy of TDS_State_Command.js STATE_CMD_GEN_REGEX: the fallback
// "gen:0:0000" must never reach the envelope pre-check (REQ-6F2-2). Copied
// constants use var (not const/let) because the shared harness vm context
// rejects const/let re-declaration (TDS_State_Command.js:24-25 precedent).
var STATE_CMD_GEN_REGEX = /^gen:\d{10}:[0-9a-f]{4}$/;

// Phase 2 hand-off: the Finaliser no longer writes the live TDS_Master.json.
// It stages a complete generation candidate and delegates the commit to the
// Generation_Publisher. In Tasker the next action reads local('par1') and
// runs the publisher; in the test harness a sandbox.publish callback is
// available, so use it when present.
function publishCandidate(candidate) {
    setLocal('par1', JSON.stringify(candidate));
    if (typeof publish === 'function') {
        return publish(candidate);
    }
    return null;
}

// Phase 3 PR-B / REQ-6F2-1: stage an OBSERVE_ARRIVAL reducer command. The Trip
// State Reducer is the sole writer of TDS_Trip_State.json; arrival
// observations now flow through it. Serial model: the pass accumulates into
// observedReducerCommands (published as one REDUCER_BATCH by the Generation
// Publisher); a reducer shim (test harness) is shim-delivered synchronously.
// An observation whose generationId fails the envelope pre-check is
// flush-skipped and logged, never staged (REQ-6F2-2, SCN-6F2-3).
function observeArrival(payload) {
    if (!STATE_CMD_GEN_REGEX.test(payload.generationId)) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: payload.generationId || null,
            component: "Finaliser", severity: "warn", code: "OBS_BATCH_FLUSH_SKIPPED", tripId: payload.tripId || null,
            details: { command: "OBSERVE_ARRIVAL", reason: "invalid generationId" } }));
        return null;
    }
    observedReducerCommands.push({ command: "OBSERVE_ARRIVAL", payload: payload });
    if (typeof reducer === 'function') {
        return reducer('OBSERVE_ARRIVAL', payload);
    }
    return null;
}

try {
    let tempRaw = local('tds_temp_json') || "[]";
    if (tempRaw.indexOf("%") === 0) tempRaw = "[]";
    let validEvents = JSON.parse(tempRaw);

    let diskRaw = readFile(DATA_ROOT + "Geocode_Cache.json");
    let diskLower = {};
    if (diskRaw && diskRaw.indexOf("%") === -1) {
        try {
            let rawJson = JSON.parse(diskRaw);
            for (let dKey in rawJson) {
                if (rawJson.hasOwnProperty(dKey)) diskLower[dKey.trim().toLowerCase()] = rawJson[dKey];
            }
        } catch(e) {
            flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
                component: "Finaliser", severity: "warn", code: "GEOCODE_CACHE_READ_FAILED", tripId: null, details: { reason: String(e && e.message || e) } }));
        }
    }

    let nowSec = Math.floor(Date.now() / 1000);

    for (let i = 0; i < validEvents.length; i++) {
        let cleanLoc = (validEvents[i].loc || "").trim().toLowerCase();
        if (diskLower[cleanLoc]) validEvents[i].coords = diskLower[cleanLoc];
    }

    // ==========================================
    // SPATIAL DEPARTURE & ARRIVAL TRACKING 
    // ==========================================
    let pLocRaw = global('TDS_Previous_Loc') || UNUSABLE_COORDS;
    let cLocRaw = global('User_Loc') || UNUSABLE_COORDS;
    let pLat = parseFloat(pLocRaw.split(",")[0]); let pLon = parseFloat(pLocRaw.split(",")[1]);
    let cLat = parseFloat(cLocRaw.split(",")[0]); let cLon = parseFloat(cLocRaw.split(",")[1]);
    
    // Phase 6 (REQ-6STATE-1): Completed_Dropins / Arrival_Memory are
    // trip-state-only. Purge protection and the arrival latch read
    // state.completedDropins and state.trips[].observedArrivalUnix — the
    // legacy globals are no longer read or written here.
    let completed = [];
    let arrivalMem = {}; // exact-key arrival dedup (never substring)
    let stateTrips = null;
    try {
        const stRaw = readFile(DATA_ROOT + "TDS_Trip_State.json") || "";
        if (stRaw) {
            const parsedState = JSON.parse(stRaw);
            const dropinMap = parsedState.completedDropins || {};
            for (let dk in dropinMap) {
                if (dropinMap.hasOwnProperty(dk)) completed.push(dk);
            }
            stateTrips = parsedState.trips || null;
            if (stateTrips) {
                for (let tk in stateTrips) {
                    if (stateTrips.hasOwnProperty(tk) && typeof stateTrips[tk].observedArrivalUnix === "number") {
                        arrivalMem[tk] = true;
                    }
                }
            }
        }
    } catch (e) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Finaliser", severity: "warn", code: "TRIP_STATE_READ_FAILED", tripId: null, details: { reason: String(e && e.message || e) } }));
    }
    let survivingEvents = [];
    
    for (let i = 0; i < validEvents.length; i++) {
        let ev = validEvents[i];
        
        let timeEligible = false;
        if (ev.isDropin) {
            // Bounded both sides (AGENTS.md: no unbounded time conditions):
            // a dropin starting today is eligible; otherwise only within
            // [start - lead, end + grace] — a future dropin stays ineligible
            // until its window opens.
            if (isSameLocalDay(ev.start, nowSec)) timeEligible = true;
            else if (nowSec >= (ev.start - DEPARTURE_LEAD_SECS) && nowSec <= (ev.end + ELIGIBILITY_GRACE_SECS)) timeEligible = true;
        } else {
            timeEligible = (nowSec >= (ev.start - DEPARTURE_LEAD_SECS) && nowSec <= (ev.end + ELIGIBILITY_GRACE_SECS));
        }
        
        if (ev.coords && ev.coords !== UNUSABLE_COORDS && timeEligible) {
            let eLat = parseFloat(ev.coords.split(",")[0]); let eLon = parseFloat(ev.coords.split(",")[1]);
            let dPrev = getDist(pLat, pLon, eLat, eLon);
            let dCurr = getDist(cLat, cLon, eLat, eLon);
            
            if (!isNaN(dPrev) && !isNaN(dCurr) && dPrev <= GEOFENCE_RADIUS_M && dCurr > GEOFENCE_RADIUS_M) {
                // [SURGICAL UPGRADE: Strict Event Purge Protection]
                if (ev.isDropin || nowSec > ev.end) {
                    if (completed.indexOf(ev.id) === -1) {
                        completed.push(ev.id);
                        // Phase 3 PR-C / REQ-6F2-1: stage COMPLETE_DROPIN for the Trip
                        // State Reducer through the observation accumulator — the serial
                        // last-wins par1/par2 would clobber the first observation. The
                        // completion record lands in reducer state
                        // (state.completedDropins); an invalid generationId is
                        // flush-skipped and logged, never staged (REQ-6F2-2, SCN-6F2-3).
                        const dropinPayload = {
                            generationId: global("TDS_Active_Generation") || "gen:0:0000",
                            dropinId: ev.id,
                            tripId: ev.id,
                            at: nowSec
                        };
                        if (STATE_CMD_GEN_REGEX.test(dropinPayload.generationId)) {
                            observedReducerCommands.push({ command: "COMPLETE_DROPIN", payload: dropinPayload });
                            if (typeof reducer === "function") {
                                let r = reducer("COMPLETE_DROPIN", dropinPayload);
                                if (typeof r === "string" && r.indexOf("OK") !== 0) {
                                    flash(JSON.stringify({ timestamp: nowSec, generationId: dropinPayload.generationId,
                                        component: "Finaliser", severity: "ERROR", code: "COMPLETE_DROPIN_REJECTED", tripId: ev.id, details: { reason: r } }));
                                }
                            }
                        } else {
                            flash(JSON.stringify({ timestamp: nowSec, generationId: dropinPayload.generationId,
                                component: "Finaliser", severity: "warn", code: "OBS_BATCH_FLUSH_SKIPPED", tripId: ev.id,
                                details: { command: "COMPLETE_DROPIN", reason: "invalid generationId" } }));
                        }
                    }
                }
            }

            if (!isNaN(dCurr) && dCurr <= GEOFENCE_RADIUS_M) {
                // Exact-key arrival dedup (AGENTS.md hard rule: no substring
                // membership checks). The map is seeded from reducer state
                // (observedArrivalUnix) and grows in-pass; a suffix-colliding id
                // can never suppress a legitimate arrival observation.
                if (!arrivalMem[ev.id]) {
                    arrivalMem[ev.id] = true;
                    // Phase 3 PR-B: record arrival observation in reducer-managed state.
                    // The legacy Arrival_Memory override remains as a read-side fallback
                    // for components that have not yet been migrated to state.trips[].
                    observeArrival({
                        generationId: global('TDS_Active_Generation') || "gen:0:0000",
                        tripId: ev.id,
                        at: nowSec,
                        accuracyM: ARRIVAL_ACCURACY_M
                    });
                }
            }
        }
        
        if (completed.indexOf(ev.id) === -1) survivingEvents.push(ev);
    }
    
    validEvents = survivingEvents;

    // REQ-6F2-1/2: stage the pass's valid observations into the dedicated
    // accumulator local (mirrors the tds_release_par1/par2 release-staging
    // precedent) for the Generation Publisher serial branch to merge into the
    // post-publish REDUCER_BATCH. publishCandidate below never touches these
    // locals, so par1 stays the publish candidate (primary-last).
    if (observedReducerCommands.length > 0) {
        setLocal('tds_obs_batch_par1', 'OBSERVATION_BATCH');
        setLocal('tds_obs_batch_par2', JSON.stringify(observedReducerCommands));
    }

    let nextGeoCoords = "NONE";
    let nextGeoTitle  = "NONE";
    let foundStrict = false;
    let geofences = [];

    for (let i = 0; i < validEvents.length; i++) {
        let ev = validEvents[i];
        if (ev.coords && ev.coords !== UNUSABLE_COORDS && !foundStrict) {
            let safeTitle = (ev.title || "").replace(/[^a-zA-Z0-9 ]/g, "").trim();
            
            if (nextGeoCoords === "NONE" && ev.end > nowSec && !ev.isDropin) {
                nextGeoCoords = ev.coords.replace(",", "~");
                nextGeoTitle  = safeTitle;
            }

            if ((ev.start - nowSec) < GEOFENCE_LOOKAHEAD_SECS) {
                geofences.push("TDS_" + safeTitle + "~" + ev.coords);
            }
            if (!ev.isDropin) foundStrict = true; 
        }
    }

    let baseStr = local('raw_base_data') || "";
    let finalBaseStr = "";
    
    if (baseStr && baseStr.indexOf("%") === -1 && baseStr.length > MIN_BASE_STR_LEN) {
        let bases = baseStr.split("|");
        for (let b = 0; b < bases.length; b++) {
            let parts = bases[b].split("~");
            let bLocClean = (parts[5] || "").trim().toLowerCase();
            if (diskLower[bLocClean]) parts[2] = diskLower[bLocClean];
            finalBaseStr += (finalBaseStr.length > 0 ? "|" : "") + parts.join("~");
        }
    }

    let adHoc = global('AdHoc_Base') || "";
    if (adHoc.indexOf("%") !== 0 && adHoc.length > MIN_ADHOC_STR_LEN) finalBaseStr += (finalBaseStr.length > 0 ? "|" : "") + adHoc;

    // Phase 2 reader cutover: carry forward the ACTIVE generation's itinerary
    // (manifest-discovered, legacy fallback while migration is in flight). The
    // legacy Itin_Master.json is no longer written since Phase 2 — publishing
    // from it regressed the itinerary on every location-change pass.
    let currentItin = readActiveGeneration("itinerary");

    publishCandidate({ events: validEvents, master: validEvents, itinerary: currentItin });

    let baseFilePath = DATA_ROOT + "TDS_Base_Geocodes.txt";
    let oldBaseStr = "";
    try { oldBaseStr = readFile(baseFilePath) || ""; } catch(e) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Finaliser", severity: "warn", code: "BASE_GEOCODES_READ_FAILED", tripId: null, details: { reason: String(e && e.message || e) } }));
    }

    if (finalBaseStr !== oldBaseStr) writeFile(baseFilePath, finalBaseStr, false);

    setLocal('next_geo_coords', nextGeoCoords);
    setLocal('next_geo_title', nextGeoTitle);

    // ==========================================
    // MANUAL SESSION RELEASE (REQ-4ADAPTER-7)
    // ==========================================
    // Runs whenever an ACTIVE manual session exists — regardless of legacy
    // lock presence — so a session is released even when no lock was ever
    // written (the modern, session-authoritative path). The migration-only
    // lock is cleared solely by the Manual Action Handler. Finaliser
    // delivers typed commands through the serial router — COMPLETE_TRIP then
    // RELEASE when reducer completion is recorded, SESSION_CLOSE otherwise —
    // and never writes the lock or sessions itself. Mid-chain rule: the
    // staged par1 MUST stay the publish candidate, so the release chain is
    // staged into dedicated locals (tds_release_par1/par2) that the serial
    // router consumes AFTER the Publisher+Reducer run; the harness shims
    // deliver directly.
    let activeSession = null;
    try {
        let sRaw = readFile(DATA_ROOT + "TDS_Action_Sessions.json") || "";
        if (sRaw) {
            let sObj = JSON.parse(sRaw);
            if (sObj && sObj.sessions) {
                for (let sk in sObj.sessions) {
                    if (sObj.sessions.hasOwnProperty(sk) && sObj.sessions[sk].status === "ACTIVE") { activeSession = sObj.sessions[sk]; break; }
                }
            }
        }
    } catch(e) { activeSession = null; flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
        component: "Finaliser", severity: "warn", code: "SESSIONS_READ_FAILED", tripId: null, details: { reason: String(e && e.message || e) } })); }
    if (activeSession) {
        let completionSeen = false;
        try {
            let stRaw = readFile(DATA_ROOT + "TDS_Trip_State.json") || "";
            if (stRaw) completionSeen = (JSON.parse(stRaw).manualReturnCompleted === true);
        } catch(e) { flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Finaliser", severity: "warn", code: "MANUAL_RETURN_STATE_READ_FAILED", tripId: null, details: { reason: String(e && e.message || e) } })); }
        if (completionSeen) {
            // Mid-chain rule: save the staged publish candidate BEFORE
            // any shim delivery (reducer/stateCommand set %par1), then
            // restore it so %par1 is never clobbered.
            const savedPar1 = local('par1');
            const savedPar2 = local('par2');
            let completeTripPayload = { generationId: global('TDS_Active_Generation') || "gen:0:0000", tripId: activeSession.tripId, at: nowSec };
            if (typeof reducer === "function") {
                let r = reducer("COMPLETE_TRIP", completeTripPayload);
                if (typeof r === "string" && r.indexOf("OK") !== 0) {
                    flash(JSON.stringify({ timestamp: nowSec, generationId: global('TDS_Active_Generation') || null,
                        component: "Finaliser", severity: "ERROR", code: "COMPLETE_TRIP_REJECTED", tripId: activeSession.tripId, details: { reason: r } }));
                }
            }
            if (typeof stateCommand === "function") {
                let r = stateCommand("RELEASE", { actionId: activeSession.actionId, tripId: activeSession.tripId, at: nowSec });
                if (typeof r === "string" && r.indexOf("OK") !== 0) {
                    flash(JSON.stringify({ timestamp: nowSec, generationId: global('TDS_Active_Generation') || null,
                        component: "Finaliser", severity: "ERROR", code: "RELEASE_REJECTED", tripId: activeSession.tripId, details: { reason: r } }));
                }
            }
            setLocal('par1', savedPar1);
            setLocal('par2', savedPar2);
            // No-shim (real Tasker): stage the deferred release chain
            // without touching the publish candidate in par1.
            setLocal('tds_release_par1', 'RELEASE');
            setLocal('tds_release_par2', JSON.stringify({ actionId: activeSession.actionId, tripId: activeSession.tripId, at: nowSec }));
        } else {
            const savedPar1 = local('par1');
            const savedPar2 = local('par2');
            if (typeof stateCommand === "function") {
                let r = stateCommand("SESSION_CLOSE", { actionId: activeSession.actionId, at: nowSec });
                if (typeof r === "string" && r.indexOf("OK") !== 0) {
                    flash(JSON.stringify({ timestamp: nowSec, generationId: global('TDS_Active_Generation') || null,
                        component: "Finaliser", severity: "ERROR", code: "SESSION_CLOSE_REJECTED", tripId: activeSession.tripId, details: { reason: r } }));
                }
            }
            setLocal('par1', savedPar1);
            setLocal('par2', savedPar2);
            setLocal('tds_release_par1', 'SESSION_CLOSE');
            setLocal('tds_release_par2', JSON.stringify({ actionId: activeSession.actionId, at: nowSec }));
        }
    }

    // ==========================================
    // GEOFENCE BASE APPEND
    // ==========================================
    let activeBaseCoords = UNUSABLE_COORDS; let activeBaseName = "";
    if (finalBaseStr.length > MIN_ADHOC_STR_LEN) {
        let bList = finalBaseStr.split("|");
        for (let b=0; b<bList.length; b++) {
            if (!bList[b]) continue;
            let bp = bList[b].split("~");
            if (nowSec >= parseFloat(bp[0]) && nowSec <= parseFloat(bp[1])) {
                activeBaseCoords = bp[2]; activeBaseName = bp[4] || "Base"; break;
            }
        }
    }
    
    if (activeBaseCoords !== UNUSABLE_COORDS && activeBaseName.toLowerCase() !== "home") {
        let safeBase = activeBaseName.replace(/[^a-zA-Z0-9 ]/g, "").trim();
        geofences.push("TDS_Base_" + safeBase + "~" + activeBaseCoords);
    }
    
    setLocal('active_geofences', geofences.join("|"));

    setLocal('tds_temp_json', "");
    setLocal('raw_base_data', "");

} catch(err) {
    flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
        component: "Finaliser", severity: "ERROR", code: "FINALISER_CRASH", tripId: null, details: { message: String(err && err.message || err) } }));
}
