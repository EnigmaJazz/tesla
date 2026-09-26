// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";
// Normalize: a dataRoot without a trailing slash would silently concatenate into
// invalid paths (R4-WARNING on the extraction refactor).
if (DATA_ROOT.charAt(DATA_ROOT.length - 1) !== "/") { DATA_ROOT += "/"; }

// ==========================================
// UNIFIED PRE-FLIGHT DISPATCHER V15.1
// Breaks multi-waypoint payloads at overnight bounds to prevent day-bleeding.
// Implements 'Shrinking Tail' subset logic for Multi-Waypoint anti-spam.
// [V15.1] Flawed synthetic EOD removed. Relies strictly on Sandbox spatial EOD generation.
// ==========================================

const IDLE_SYNC_MINS = 60;  // INV-0.6 AC-10: idle sync default when no actionable trip.
const SOON_SYNC_MINS = 10;  // Bucket for actionable heads within 30 minutes (replaces the stale-leg 3-min loop).
const ACTIONABLE_LOOKAHEAD_SECS = 86400;  // First-slice default lookahead; per-leg relevanceDeadlineUnix is second slice.
const RELEVANCE_DEFAULT_SECS = 4 * 3600;  // INV-0.6: fallback relevance window (planned arrival + 4h).
const RELEVANCE_RECOVERY_SECS = 2 * 3600;  // INV-0.6: recovery leg relevance window (planned arrival + 2h).
const RELEVANCE_EOD_SECS = 24 * 3600;  // INV-0.6: EOD return remains actionable for the rest of the day.
const RELEVANCE_DROPIN_GRACE_SECS = 15 * 60;  // INV-0.6: drop-in explicit deadline; if absent, +15 min after planned arrival.
const LOCK_FRESH_SECS = 7200;  // Phase 4 Slice B: legacy lock freshness for the migration-only fallback.

// Named windows/radii (AGENTS.md: no magic numbers).
const EARTH_RADIUS_M = 6371e3;              // haversine earth radius (getDist)
const SCHEDULE_MIN_LEAD_SECS = 1200;        // schedule push lower lead bound
const SCHEDULE_CHANGE_TOLERANCE_SECS = 300; // schedule-change delta threshold
const HVAC_OPEN_START_SECS = -300;          // hvac/nav push window start
const HVAC_OPEN_END_SECS = 1200;            // hvac push window end
const HVAC_COOLDOWN_SECS = 1800;            // hvac push cooldown
const NAV_OPEN_END_SECS = 3600;             // nav push window end
const SHORT_STAY_MINS = 45;                 // short-stay clustering rule
const DURATION_FALLBACK_SECS = 1800;         // missing-duration fallback (30m)
const BOLT_REVERSED_STOPS = true;            // Bolt plugin navigates staged stops in reverse order → sequential-stop payload is emitted chronologically reversed
const UNUSABLE_COORDS = "0,0";               // unusable-coordinates sentinel
const COORD_FALLBACK = "0";                   // single-component coordinate fallback
const SYNC_INTERVAL_HIGH_MINS = 120;         // far-gap sync interval
const SYNC_INTERVAL_MED_MINS = 60;           // medium-gap sync interval
const SYNC_INTERVAL_LOW_MINS = 30;           // near-gap sync interval
const MS_PER_MINUTE = 60000;                  // ms-per-minute for sync math
const NAV_TAIL_MATCH_RADIUS_M = 50;         // nav tail-match / phone delta radius
const PHONE_OPEN_START_SECS = -60;          // phone window start
const PHONE_OPEN_END_SECS = 600;            // phone window end
const PHONE_DIST_UNKNOWN = 99999;           // no prior google-nav sentinel
const SYNC_GAP_HIGH_MINS = 180;             // sync bucket thresholds
const SYNC_GAP_MED_MINS = 60;
const SYNC_GAP_LOW_MINS = 30;
const BOLT_MINS_CAP = 1424;                 // getBoltMins cap (23:44)

// AC-5 (Slice B): local planning-day label for a unix timestamp. Mirrors
// Sandbox_Engine's localPlanningDay (reader-convergence: byte-identical
// local copy for Tasker standalone isolation).
function localPlanningDay(targetUnixSecs) {
    let d = new Date(targetUnixSecs * 1000);
    let y = d.getFullYear();
    let m = ("0" + (d.getMonth() + 1)).slice(-2);
    let day = ("0" + d.getDate()).slice(-2);
    return y + "-" + m + "-" + day;
}

function getDist(lat1, lon1, lat2, lon2) {
    var R = EARTH_RADIUS_M; var rLat1 = lat1 * Math.PI / 180; var rLat2 = lat2 * Math.PI / 180;
    var dLat = (lat2 - lat1) * Math.PI / 180; var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Phase 2 reader cutover: discover the committed generation through the manifest.
// Mirrors TDS_Helper.readActive; includes a legacy fallback while the migration
// is in flight.
function readJson(path) {
    var raw = "";
    try { raw = readFile(path) || ""; } catch(e) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher", severity: "warn", code: "FILE_READ_FAILED", tripId: null, details: { path: path, reason: String(e && e.message || e) } }));
    }
    if (!raw || raw.indexOf("%") === 0) return null;
    try { return JSON.parse(raw); } catch(e) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher", severity: "warn", code: "FILE_PARSE_FAILED", tripId: null, details: { path: path, reason: String(e && e.message || e) } }));
        return null;
    }
}
// R1/R4: three-state read. readJson collapses "missing" and "unreadable" into
// null; this reader keeps them distinct so a read/parse failure is never
// mistaken for an absent generation. readJson is unchanged for its callers.
function readJsonState(path) {
    var raw = "";
    try { raw = readFile(path); } catch (e) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher", severity: "error", code: "FILE_READ_FAILED", tripId: null, details: { path: path, reason: String(e && e.message || e) } }));
        return { state: "unreadable" };
    }
    if (!raw) return { state: "missing" };
    if (raw.indexOf("%") === 0) return { state: "unreadable" };
    try { return { state: "ok", value: JSON.parse(raw) }; } catch (e) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher", severity: "warn", code: "FILE_PARSE_FAILED", tripId: null, details: { path: path, reason: String(e && e.message || e) } }));
        return { state: "unreadable" };
    }
}
function pathFor(g, kind) {
    return DATA_ROOT + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + String(g).replace(/:/g, "_") + ".json";
}
// R4: records whether the most recent readActiveGeneration hit a read/parse
// FAILURE (vs. a genuinely absent/not-yet-committed generation), so callers
// can tell "unreadable" from "absent/building".
var lastGenerationReadFailed = false;
// Phase 3 PR-E: Local copy of readActiveGeneration. The canonical
// implementation lives in TDS_Helper.js. Kept local because Tasker
// scripts are standalone and cannot call functions from other scripts.
function readActiveGeneration(kind) {
    var readFailed = false;
    var manifestRead = readJsonState(DATA_ROOT + "TDS_Run_Manifest.json");
    if (manifestRead.state === "unreadable") readFailed = true;
    var m = manifestRead.state === "ok" ? manifestRead.value : null;
    var key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
    if (m && m.state === "committed" && m.activeGeneration) {
        var activeRead = readJsonState(m[key] || pathFor(m.activeGeneration, kind));
        if (activeRead.state === "unreadable") readFailed = true;
        if (activeRead.state === "ok" && activeRead.value !== null) { lastGenerationReadFailed = readFailed; return activeRead.value; }
    }
    if (m && m.previousGeneration) {
        var prevRead = readJsonState(pathFor(m.previousGeneration, kind));
        if (prevRead.state === "unreadable") readFailed = true;
        if (prevRead.state === "ok" && prevRead.value !== null) { lastGenerationReadFailed = readFailed; return prevRead.value; }
    }
    var legacyRead = readJsonState(DATA_ROOT + (kind === "events" || kind === "master" ? "TDS_Master.json" : "Itin_Master.json"));
    if (legacyRead.state === "unreadable") readFailed = true;
    if (legacyRead.state === "ok" && legacyRead.value !== null) { lastGenerationReadFailed = readFailed; return legacyRead.value; }
    // Nothing readable. null preserves the UNKNOWN signal for callers;
    // lastGenerationReadFailed distinguishes a read/parse failure from an
    // absent or not-yet-committed generation.
    lastGenerationReadFailed = readFailed;
    return null;
}

function getBoltMins(unixSecs) {
    var ms = parseInt(unixSecs) * 1000;
    if (isNaN(ms) || ms <= 0) return 0;
    var d = new Date(ms);
    var mins = (d.getHours() * 60) + d.getMinutes();
    return mins > BOLT_MINS_CAP ? BOLT_MINS_CAP : mins; 
}

/**
 * INV-0.6: compute the relevance deadline for a candidate leg.
 * Returns the explicit planner override if present, otherwise derives a
 * deadline from leg type / action type. The result is never before now;
 * a leg with no timing info is treated as fresh (now + default window).
 */
function relevanceDeadlineForLeg(trip, nowSec) {
    if (!trip) return nowSec + RELEVANCE_DEFAULT_SECS;

    var explicit = parseInt(trip.relevanceDeadlineUnix, 10) || 0;
    if (explicit > 0) return explicit;

    var arriveUnix = parseInt(trip.arriveUnix || trip.start || trip.departUnix || trip.time || 0, 10) || 0;
    var legType = (trip.legType || "").toUpperCase();
    var actionType = (trip.actionType || "").toUpperCase();

    if (legType === "DROPIN" || actionType === "DROPIN") {
        return (arriveUnix > 0 ? arriveUnix : nowSec) + RELEVANCE_DROPIN_GRACE_SECS;
    }
    if (legType === "EOD_RETURN" || actionType === "EOD_RETURN") {
        return nowSec + RELEVANCE_EOD_SECS;
    }
    if (legType === "RECOVERY" || actionType === "RECOVERY") {
        if (arriveUnix > 0) return arriveUnix + RELEVANCE_RECOVERY_SECS;
        return nowSec + RELEVANCE_DEFAULT_SECS;
    }
    if (arriveUnix > 0) return arriveUnix + RELEVANCE_DEFAULT_SECS;
    return nowSec + RELEVANCE_DEFAULT_SECS;
}

try {
    var nowSec = Math.floor(Date.now() / 1000);

    var lastSched = parseInt(global('Tesla_Last_Scheduled')) || 0;
    setLocal('itin_bolt_last', getBoltMins(lastSched).toString());

    var master = readActiveGeneration("itinerary");
    // R4: distinguish a read/parse FAILURE (never cancel or idle from it) from
    // a genuinely absent or not-yet-committed (building) generation, which is a
    // legitimate empty state and keeps the idle sync.
    var masterReadable = (master !== null);
    var masterReadFailed = lastGenerationReadFailed;
    if (master === null) master = [];

    // Completion exclusion (user-directed 2026-08-10): the Dispatcher never
    // consulted completion state, so a completed trip still in the committed
    // itinerary (between arrival and the next planning pass) could be
    // re-routed as overdue-within-window. Read the reducer state and exclude
    // legs whose tripId is completed (observedArrivalUnix) or whose target
    // event is in the completed stops/dropins maps — explicit state, never
    // inferred.
    // R3: a genuinely ABSENT/empty state file is a legitimate "nothing recorded
    // yet" (bootstrap §5 mandates the file; a migrated legacy system may have a
    // master but no state file) -> known-empty, the overdue class proceeds, and
    // TRIP_STATE_ABSENT makes it diagnosable. An UNREADABLE state file (read
    // threw / parse failed / %-unexpanded) cannot prove a leg is not completed
    // -> the overdue class is withheld (P1-3).
    var completedTripIds = {};
    var completedEventIds = {};
    var tripStateReadable = false;
    var tripStateRead = readJsonState(DATA_ROOT + "TDS_Trip_State.json");
    if (tripStateRead.state === "ok") {
        tripStateReadable = true;
        let st = tripStateRead.value;
        let trips = (st && st.trips) || {};
        for (let tk in trips) {
            if (trips.hasOwnProperty(tk) && typeof trips[tk].observedArrivalUnix === "number") {
                completedTripIds[tk] = true;
            }
        }
        let stopMap = (st && st.completedStops) || {};
        for (let sk in stopMap) if (stopMap.hasOwnProperty(sk)) completedEventIds[sk] = true;
        let dropinMap = (st && st.completedDropins) || {};
        for (let dk in dropinMap) if (dropinMap.hasOwnProperty(dk)) completedEventIds[dk] = true;
    } else if (tripStateRead.state === "missing") {
        tripStateReadable = true;
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher", severity: "warn", code: "TRIP_STATE_ABSENT", tripId: null, details: { path: DATA_ROOT + "TDS_Trip_State.json" } }));
    } else {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher", severity: "warn", code: "TRIP_STATE_READ_FAILED", tripId: null, details: { path: DATA_ROOT + "TDS_Trip_State.json", reason: "unreadable" } }));
    }

    let targetDrive = undefined;
    let driveIdx = -1;
    let bestFuture = null;
    let bestFutureIdx = -1;
    let bestOverdue = null;
    let bestOverdueIdx = -1;

    // INV-0.6: rank future > overdue-within-window; truly stale (past relevance) is rejected with STALE_TRIP_REJECTED.
    for (let i = 0; i < master.length; i++) {
        const trip = master[i];
        if (!trip) continue;

        // A completed trip is never re-routed: explicit reducer state, not
        // inference (the leg may still sit in the committed itinerary between
        // arrival and the next planning pass).
        const tripId = trip.tripId || null;
        if ((tripId && completedTripIds[tripId]) || (trip.targetEventId && completedEventIds[trip.targetEventId])) {
            flash(JSON.stringify({
                timestamp: nowSec,
                generationId: global('TDS_Active_Generation') || null,
                component: "Dispatcher",
                    severity: "info",
                    code: "COMPLETED_TRIP_SKIPPED",
                tripId: tripId,
                details: { depUnix: parseInt(trip.departUnix || trip.time || 0, 10) || 0 }
            }));
            continue;
        }

        const tripMode = (trip.mode || "").toUpperCase();
        const depUnix = parseInt(trip.departUnix || trip.time || 0, 10) || 0;

        if (tripMode === "DRIVE" || tripMode === "EOD_RETURN" || tripMode === "WALK" || tripMode === "TRANSIT" || tripMode === "LIFT") {
            // AC-5 (Slice B): a leg on a FUTURE local planning day is never
            // actionable today. Compare day labels lexicographically (YYYY-
            // MM-DD sorts correctly); prior-day legs fall through to the
            // stale/relevance logic below rather than being mislabelled.
            const tripDay = (trip.planningDay || "").trim();
            const todayDay = localPlanningDay(nowSec);
            if (tripDay !== "" && tripDay > todayDay) {
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: global('TDS_Active_Generation') || null,
                    component: "Dispatcher",
                severity: "info",
                code: "FUTURE_TRIP_NOT_DUE",
                    tripId: trip.tripId || null,
                    details: { planningDay: tripDay, depUnix: depUnix, nowSec: nowSec }
                }));
                continue;
            }

            const relDeadline = relevanceDeadlineForLeg(trip, nowSec);
            if (nowSec >= relDeadline) {
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: global('TDS_Active_Generation') || null,
                    component: "Dispatcher",
                    severity: "warn",
                    code: "STALE_TRIP_REJECTED",
                    tripId: trip.tripId || null,
                    details: { depUnix: depUnix, nowSec: nowSec, relevanceDeadline: relDeadline }
                }));
                continue;
            }

            if (depUnix >= nowSec) {
                if (bestFuture === null) {
                    bestFuture = trip;
                    bestFutureIdx = i;
                }
            } else {
                if (bestOverdue === null) {
                    bestOverdue = trip;
                    bestOverdueIdx = i;
                }
            }
        }
    }

    if (bestFuture !== null) {
        targetDrive = bestFuture;
        driveIdx = bestFutureIdx;
    } else if (bestOverdue !== null) {
        // P1-3: an UNKNOWN trip state cannot prove a leg is not already
        // completed; withhold the overdue class rather than risk re-routing a
        // completed stop. Future/PLANNED selection is unaffected.
        if (tripStateReadable) {
            targetDrive = bestOverdue;
            driveIdx = bestOverdueIdx;
        } else {
            flash(JSON.stringify({
                timestamp: nowSec,
                generationId: global('TDS_Active_Generation') || null,
                component: "Dispatcher",
                severity: "warn",
                code: "OVERDUE_SUPPRESSED_STATE_UNKNOWN",
                tripId: bestOverdue.tripId || bestOverdue.targetEventId || null,
                details: { depUnix: parseInt(bestOverdue.departUnix || bestOverdue.time || 0, 10) || 0 }
            }));
        }
    }

    if (targetDrive) {
        var dTime    = parseInt(targetDrive.departUnix || targetDrive.time || 0);
        var title    = targetDrive.targetTitle || targetDrive.loc || "Destination";
        var coords   = targetDrive.targetCoords || targetDrive.coords || UNUSABLE_COORDS;
        var coordArr = coords.split(',');
        var startVal = parseInt(targetDrive.arriveUnix || targetDrive.start || dTime);
        var evalMode = targetDrive.mode || "WALK";

        var timeToDepart = dTime - nowSec;

        var lastCommittedSched = parseInt(global('Tesla_Last_Scheduled')) || 0;
        var timeDeltaSecs      = Math.abs(dTime - lastCommittedSched);
        
        var grantSchedulePush  = (timeToDepart > SCHEDULE_MIN_LEAD_SECS && timeToDepart <= ACTIONABLE_LOOKAHEAD_SECS && (lastCommittedSched === 0 || timeDeltaSecs > SCHEDULE_CHANGE_TOLERANCE_SECS));
        
        var lastHvacPush = parseInt(global('Tesla_Last_HVAC_Unix')) || 0;
        var grantHvacPush = (timeToDepart >= HVAC_OPEN_START_SECS && timeToDepart <= HVAC_OPEN_END_SECS && (nowSec - lastHvacPush > HVAC_COOLDOWN_SECS));

        var isNavWindowOpen = (timeToDepart >= HVAC_OPEN_START_SECS && timeToDepart <= NAV_OPEN_END_SECS);
        
        var navPayloadStr = coords; 
        if (evalMode === "DRIVE" && driveIdx !== -1) {
            var multiCoords = [coords];
            // Chain gate is DWELL LENGTH only (user-directed 2026-08-10): a
            // stop sequences into the payload only when the dwell before it is
            // short (<= SHORT_STAY_MINS). Dropins get NO dwell carve-out — a
            // dropin with a long dwell is its own trip, never sequenced with
            // the next stop (e.g. the trip home hours after work never joins
            // the work payload). Negative gaps break too.
            var lastArrive = parseInt(targetDrive.arriveUnix || (dTime + (targetDrive.durationSecs || DURATION_FALLBACK_SECS)));

            for (let j = driveIdx + 1; j < master.length; j++) {
                let nextT = master[j];
                let nextDep = parseInt(nextT.departUnix || nextT.time || 0, 10);

                if (!isFinite(nextDep) || !isFinite(lastArrive)) {
                    flash(JSON.stringify({
                        timestamp: Math.floor(Date.now() / 1000),
                        generationId: global('TDS_Active_Generation') || null,
                        component: "Dispatcher",
                        severity: "warn",
                        code: "CHAIN_BREAK_INVALID_DEPART",
                        tripId: nextT.tripId || nextT.targetEventId || null,
                        details: { departUnix: nextT.departUnix, time: nextT.time, lastArrive: lastArrive }
                    }));
                    break;
                }
                
                // The Tesla nav payload is DRIVE-only: a non-DRIVE next stop
                // (WALK/TRANSIT) is a separate navigation mode and never
                // sequences into it, regardless of dwell.
                if ((nextT.mode || "").toUpperCase() !== "DRIVE") break;
                
                // A COMPLETED stop is never routed — the exclusion applies to
                // chain stops too, not just target selection (a completed
                // stop's successor is also stale, so break).
                let nextTid = nextT.tripId || null;
                if ((nextTid && completedTripIds[nextTid]) || (nextT.targetEventId && completedEventIds[nextT.targetEventId])) break;
                
                let stayMins = (nextDep - lastArrive) / 60;
                if (stayMins < 0 || stayMins > SHORT_STAY_MINS) break; // long dwell or negative gap never chains
                
                let nc = nextT.targetCoords || nextT.coords || UNUSABLE_COORDS;
                if (nc === UNUSABLE_COORDS) break; // a coord-less stop cannot navigate
                multiCoords.push(nc);
                lastArrive = parseInt(nextT.arriveUnix || (nextDep + (nextT.durationSecs || DURATION_FALLBACK_SECS)));
            }
            // BOLT_REVERSED_STOPS: the Bolt nav plugin hands the stop list to
            // the car in reverse navigation order, so the sequential-stop
            // payload is emitted chronologically REVERSED (last stop first,
            // destination last) to land in the correct driving sequence. A
            // single destination is unaffected (reverse of [A] is [A]).
            if (BOLT_REVERSED_STOPS) multiCoords.reverse();
            navPayloadStr = multiCoords.join("~");
        }

        var grantNavPush = false;
        var lastCommittedNav = (global('Tesla_Last_Nav') || "").trim();
        if (lastCommittedNav.indexOf("%") === 0) lastCommittedNav = ""; 

        if (isNavWindowOpen && coords !== UNUSABLE_COORDS) {
            if (lastCommittedNav === "") {
                grantNavPush = true;
            } else {
                var oldNavP = lastCommittedNav.split("~");
                var newNavP = navPayloadStr.split("~");
                
                // Nav re-push dedup: with BOLT_REVERSED_STOPS the payload is
                // chronologically reversed, so a suffix comparison would
                // suppress the re-push when a chain SHRINKS (a cancelled tail
                // stop makes the new payload a suffix of the committed one and
                // the car would keep driving the stale stop). Only an
                // EQUAL payload (same stops, same order, coordinate jitter
                // within NAV_TAIL_MATCH_RADIUS_M) suppresses the push; any
                // structural change re-stages the list.
                var isSamePayload = true;
                if (newNavP.length !== oldNavP.length) {
                    isSamePayload = false;
                } else {
                    for (var n = 0; n < newNavP.length; n++) {
                        var oC = oldNavP[n].split(",");
                        var nC = newNavP[n].split(",");
                        var oLat = parseFloat(oC[0]), oLon = parseFloat(oC[1]);
                        var nLat = parseFloat(nC[0]), nLon = parseFloat(nC[1]);
                        // Non-finite coords in a committed payload are never
                        // "equal" — re-push rather than risk suppressing a
                        // needed re-stage on malformed legacy data.
                        if (!isFinite(oLat) || !isFinite(oLon) || !isFinite(nLat) || !isFinite(nLon)
                            || getDist(oLat, oLon, nLat, nLon) > NAV_TAIL_MATCH_RADIUS_M) {
                            isSamePayload = false;
                            break;
                        }
                    }
                }
                if (!isSamePayload) grantNavPush = true;
            }
        }

        var lastCommittedGoogle = (global('Google_Last_Nav') || "").trim();
        if (lastCommittedGoogle.indexOf("%") === 0) lastCommittedGoogle = "";

        var isPhoneWindowOpen = (timeToDepart >= PHONE_OPEN_START_SECS && timeToDepart <= PHONE_OPEN_END_SECS);
        var phoneDistDelta = PHONE_DIST_UNKNOWN;

        if (lastCommittedGoogle !== "" && lastCommittedGoogle.indexOf(",") !== -1) {
            var oldGNavP = lastCommittedGoogle.split(",");
            phoneDistDelta = getDist(parseFloat(oldGNavP[0]), parseFloat(oldGNavP[1]), parseFloat(coordArr[0]), parseFloat(coordArr[1]));
        }
        var grantGooglePush = (isPhoneWindowOpen && (lastCommittedGoogle === "" || phoneDistDelta > NAV_TAIL_MATCH_RADIUS_M) && coords !== UNUSABLE_COORDS);

        setLocal('itin_time1', dTime.toString());
        setLocal('itin_mode1', evalMode);
        setLocal('itin_loc1', title);
        setLocal('itin_start1', startVal.toString());
        setLocal('itin_lat1', coordArr[0] || COORD_FALLBACK);
        setLocal('itin_lng1', coordArr[1] || COORD_FALLBACK);
        setLocal('itin_bolt_time', getBoltMins(dTime).toString());

        setLocal('do_tesla_schedule', (grantSchedulePush && evalMode === "DRIVE") ? "true" : "false");
        setLocal('do_tesla_hvac', (grantHvacPush && evalMode === "DRIVE") ? "true" : "false");
        setLocal('do_tesla_nav', (grantNavPush && evalMode === "DRIVE") ? "true" : "false");
        setLocal('do_tesla_cancel', 'false');

        setLocal('tds_next_mode', evalMode);
        setLocal('tds_next_coords', navPayloadStr); 
        setLocal('tds_next_title', title);

        if (evalMode !== "DRIVE" && evalMode !== "EOD_RETURN") {
            if (grantGooglePush) {
                setLocal('do_google_nav', "true");
                var gMode = "w"; 
                if (evalMode === "TRANSIT") gMode = "r";
                else if (evalMode === "LIFT") gMode = "d";
                setLocal('gmaps_mode', gMode);
            } else { setLocal('do_google_nav', "false"); }
        } else { setLocal('do_google_nav', "false"); }

    } else {
        var cancelSchedule = "false";
        // Cancelling a real scheduled departure requires a READABLE
        // generation: a transient read failure (masterReadable false) must
        // never look like an empty day and cancel the schedule.
        if (masterReadable && lastSched > 0 && lastSched > nowSec) {
            cancelSchedule = "true";
        }
        
        setLocal('itin_mode1', 'NONE');
        setLocal('itin_time1', '0');
        setLocal('itin_bolt_time', '0');
        setLocal('do_tesla_schedule', 'false');
        setLocal('do_tesla_hvac', 'false');
        setLocal('do_tesla_nav', 'false');
        setLocal('do_google_nav', 'false');
        setLocal('do_tesla_cancel', cancelSchedule);
    }

    var currentStatus = global('Current_Status') || "";
    var isDriving = (currentStatus.indexOf("Driving") !== -1);
    var isAdHoc = (global('User_At_AdHoc') === "true");

    var isActionLocked = false;
    // Phase 4 Slice B (REQ-4SESSION-2): sessions are authoritative. An active
    // session locks the heartbeat; the legacy lock is honoured only when the
    // session store is absent/unreadable; a readable empty session map means
    // unlocked.
    var sessionStoreReadable = false;
    try {
        var sessionsRaw = readFile(DATA_ROOT + "TDS_Action_Sessions.json");
        if (sessionsRaw && sessionsRaw.indexOf("%") === -1) {
            var sessionsData = JSON.parse(sessionsRaw);
            if (sessionsData && sessionsData.sessions && typeof sessionsData.sessions === "object") {
                sessionStoreReadable = true;
                var sKeys = Object.keys(sessionsData.sessions);
                for (var si = 0; si < sKeys.length; si++) {
                    var sess = sessionsData.sessions[sKeys[si]];
                    if (sess && sess.status === "ACTIVE" && nowSec <= parseInt(sess.expiresAt, 10)) {
                        isActionLocked = true;
                        break;
                    }
                }
            }
        }
    } catch(e) {
        flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher", severity: "warn", code: "SESSIONS_READ_FAILED", tripId: null, details: { reason: String(e && e.message || e) } }));
        sessionStoreReadable = false;
    }

    if (!sessionStoreReadable) {
        try {
            var lockRaw = readFile(DATA_ROOT + "TDS_Action_Lock.json");
            if (lockRaw && lockRaw.indexOf("%") === -1 && lockRaw !== "{}") {
                var lockData = JSON.parse(lockRaw);
                if (nowSec - parseInt(lockData.timestamp || 0) < LOCK_FRESH_SECS) {
                    isActionLocked = true;
                }
            }
        } catch(e) {
            flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
                component: "Dispatcher", severity: "warn", code: "ACTION_LOCK_READ_FAILED", tripId: null, details: { reason: String(e && e.message || e) } }));
        }
    }

    if (isDriving) {
        isActionLocked = true;
    } else if (isAdHoc) {
        isActionLocked = false;
    }

    var syncIntervalMins = SYNC_INTERVAL_HIGH_MINS;
    if (isActionLocked) {
        syncIntervalMins = SYNC_INTERVAL_HIGH_MINS;
    } else if (targetDrive === undefined) {
        if (masterReadFailed) {
            // R4: a master read/parse FAILURE must not idle 60 min; a real
            // departure 10-50 min out would otherwise fall outside the nav window.
            syncIntervalMins = SOON_SYNC_MINS;
            flash(JSON.stringify({
                timestamp: nowSec,
                generationId: global('TDS_Active_Generation') || null,
                component: "Dispatcher",
                severity: "warn",
                code: "GENERATION_READ_UNKNOWN_SYNC",
                tripId: null,
                details: { syncIntervalMins: SOON_SYNC_MINS, reason: "master_unreadable" }
            }));
        } else {
            // R4: an absent or not-yet-committed (building) master is the normal
            // no-actionable-trip case → idle sync (INV-0.6 AC-10).
            syncIntervalMins = IDLE_SYNC_MINS;
            flash(JSON.stringify({
                timestamp: nowSec,
                generationId: global('TDS_Active_Generation') || null,
                component: "Dispatcher",
                severity: "info",
                code: "IDLE_SYNC_ENGAGED",
                tripId: null,
                details: { syncIntervalMins: IDLE_SYNC_MINS }
            }));
        }
    } else {
        var gapMins = Math.floor((targetDrive.departUnix - nowSec) / 60);
        if (gapMins > SYNC_GAP_HIGH_MINS) syncIntervalMins = SYNC_INTERVAL_HIGH_MINS;
        else if (gapMins > SYNC_GAP_MED_MINS) syncIntervalMins = SYNC_INTERVAL_MED_MINS;
        else if (gapMins > SYNC_GAP_LOW_MINS) syncIntervalMins = SYNC_INTERVAL_LOW_MINS;
        // If targetDrive is overdue, gapMins is negative → SOON_SYNC_MINS; IDLE_SYNC_ENGAGED is reserved for the empty-master / all-truly-stale case.
        else syncIntervalMins = SOON_SYNC_MINS;
    }

    var nextSyncMs = Date.now() + (syncIntervalMins * MS_PER_MINUTE);
    var syncDate   = new Date(nextSyncMs);
    setGlobal('Next_Sync', (syncDate.getHours()<10?'0':'')+syncDate.getHours() + "." + (syncDate.getMinutes()<10?'0':'')+syncDate.getMinutes());

} catch(err) {
    flash(JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), generationId: global('TDS_Active_Generation') || null,
        component: "Dispatcher", severity: "error", code: "DISPATCHER_FAULT", tripId: null, details: { message: String(err && err.message || err) } }));
}
