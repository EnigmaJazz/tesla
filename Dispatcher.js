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

const SECONDS_PER_DAY = 86400;

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
    var R = 6371e3; var rLat1 = lat1 * Math.PI / 180; var rLat2 = lat2 * Math.PI / 180;
    var dLat = (lat2 - lat1) * Math.PI / 180; var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Phase 2 reader cutover: discover the committed generation through the manifest.
// Mirrors TDS_Helper.readActive; includes a legacy fallback while the migration
// is in flight.
function readJson(path) {
    var raw = "";
    try { raw = readFile(path) || ""; } catch(e) {}
    if (!raw || raw.indexOf("%") === 0) return null;
    try { return JSON.parse(raw); } catch(e) { return null; }
}
function pathFor(g, kind) {
    return "Tasker/Tesla/Data/" + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + String(g).replace(/:/g, "_") + ".json";
}
// Phase 3 PR-E: Local copy of readActiveGeneration. The canonical
// implementation lives in TDS_Helper.js. Kept local because Tasker
// scripts are standalone and cannot call functions from other scripts.
function readActiveGeneration(kind) {
    var m = readJson("Tasker/Tesla/Data/TDS_Run_Manifest.json");
    var key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
    if (m && m.state === "committed" && m.activeGeneration) {
        var data = readJson(m[key] || pathFor(m.activeGeneration, kind));
        if (data !== null) return data;
    }
    if (m && m.previousGeneration) {
        var prev = readJson(pathFor(m.previousGeneration, kind));
        if (prev !== null) return prev;
    }
    if (kind === "events" || kind === "master") {
        var legacy = readJson("Tasker/Tesla/Data/TDS_Master.json");
        if (legacy !== null) return legacy;
    }
    if (kind === "itinerary") {
        var legacyItin = readJson("Tasker/Tesla/Data/Itin_Master.json");
        if (legacyItin !== null) return legacyItin;
    }
    return [];
}

function getBoltMins(unixSecs) {
    var ms = parseInt(unixSecs) * 1000;
    if (isNaN(ms) || ms <= 0) return 0;
    var d = new Date(ms);
    var mins = (d.getHours() * 60) + d.getMinutes();
    return mins > 1424 ? 1424 : mins; 
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

    let targetDrive = undefined;
    let driveIdx = -1;
    let skippedStale = 0;
    let bestFuture = null;
    let bestFutureIdx = -1;
    let bestOverdue = null;
    let bestOverdueIdx = -1;

    // INV-0.6: rank future > overdue-within-window; truly stale (past relevance) is rejected with STALE_TRIP_REJECTED.
    for (let i = 0; i < master.length; i++) {
        const trip = master[i];
        if (!trip) continue;

        const tripMode = (trip.mode || "").toUpperCase();
        const depUnix = parseInt(trip.departUnix || trip.time || 0, 10) || 0;

        if (tripMode === "DRIVE" || tripMode === "EOD_RETURN" || tripMode === "WALK" || tripMode === "TRANSIT" || tripMode === "LIFT") {
            // AC-5 (Slice B): a leg on a future local planning day is never
            // actionable today. Reject it explicitly instead of selecting it
            // as bestFuture and letting the vehicle act on tomorrow's trip.
            const tripDay = (trip.planningDay || "").trim();
            const todayDay = localPlanningDay(nowSec);
            if (tripDay !== "" && tripDay !== todayDay) {
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: global('TDS_Active_Generation') || null,
                    component: "Dispatcher",
                    severity: "INFO",
                    code: "FUTURE_TRIP_NOT_DUE",
                    tripId: trip.tripId || null,
                    details: { planningDay: tripDay, depUnix: depUnix, nowSec: nowSec }
                }));
                continue;
            }

            const relDeadline = relevanceDeadlineForLeg(trip, nowSec);
            if (nowSec >= relDeadline) {
                skippedStale++;
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: global('TDS_Active_Generation') || null,
                    component: "Dispatcher",
                    severity: "WARN",
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
        targetDrive = bestOverdue;
        driveIdx = bestOverdueIdx;
    }

    if (targetDrive) {
        var dTime    = parseInt(targetDrive.departUnix || targetDrive.time || 0);
        var title    = targetDrive.targetTitle || targetDrive.loc || "Destination";
        var coords   = targetDrive.targetCoords || targetDrive.coords || "0,0";
        var coordArr = coords.split(',');
        var startVal = parseInt(targetDrive.arriveUnix || targetDrive.start || dTime);
        var evalMode = targetDrive.mode || "WALK";

        var timeToDepart = dTime - nowSec;

        var lastCommittedSched = parseInt(global('Tesla_Last_Scheduled')) || 0;
        var timeDeltaSecs      = Math.abs(dTime - lastCommittedSched);
        
        var grantSchedulePush  = (timeToDepart > 1200 && timeToDepart <= 86400 && (lastCommittedSched === 0 || timeDeltaSecs > 300));
        
        var lastHvacPush = parseInt(global('Tesla_Last_HVAC_Unix')) || 0;
        var grantHvacPush = (timeToDepart >= -300 && timeToDepart <= 1200 && (nowSec - lastHvacPush > 1800));

        var isNavWindowOpen = (timeToDepart >= -300 && timeToDepart <= 3600);
        
        var navPayloadStr = coords; 
        if (evalMode === "DRIVE" && driveIdx !== -1) {
            var multiCoords = [coords];
            var lastArrive = parseInt(targetDrive.arriveUnix || (dTime + (targetDrive.durationSecs || 1800)));
            var currentIsDropin = targetDrive.targetDesc && /(#dropin)/i.test(targetDrive.targetDesc);

            for (let j = driveIdx + 1; j < master.length; j++) {
                let nextT = master[j];
                let nextDep = parseInt(nextT.departUnix || nextT.time || 0);
                
                if (!isSameUTCDay(lastArrive, nextDep)) break; // Break clustering at overnight boundaries
                
                let stayMins = (nextDep - lastArrive) / 60;
                let isShortStay = stayMins >= 0 && stayMins <= 45; 
                
                if (currentIsDropin || isShortStay) {
                    let nc = nextT.targetCoords || nextT.coords || "0,0";
                    multiCoords.push(nc);
                    lastArrive = parseInt(nextT.arriveUnix || (nextDep + (nextT.durationSecs || 1800)));
                    currentIsDropin = nextT.targetDesc && /(#dropin)/i.test(nextT.targetDesc);
                } else {
                    break; 
                }
            }
            navPayloadStr = multiCoords.join("~");
        }

        var grantNavPush = false;
        var lastCommittedNav = (global('Tesla_Last_Nav') || "").trim();
        if (lastCommittedNav.indexOf("%") === 0) lastCommittedNav = ""; 

        if (isNavWindowOpen && coords !== "0,0") {
            if (lastCommittedNav === "") {
                grantNavPush = true;
            } else {
                var oldNavP = lastCommittedNav.split("~");
                var newNavP = navPayloadStr.split("~");
                
                var isTailMatch = true;
                if (newNavP.length > oldNavP.length) {
                    isTailMatch = false; 
                } else {
                    var offset = oldNavP.length - newNavP.length;
                    for (var n = 0; n < newNavP.length; n++) {
                        var oC = oldNavP[offset + n].split(",");
                        var nC = newNavP[n].split(",");
                        if (getDist(parseFloat(oC[0]), parseFloat(oC[1]), parseFloat(nC[0]), parseFloat(nC[1])) > 50) {
                            isTailMatch = false;
                            break;
                        }
                    }
                }
                if (!isTailMatch) grantNavPush = true;
            }
        }

        var lastCommittedGoogle = (global('Google_Last_Nav') || "").trim();
        if (lastCommittedGoogle.indexOf("%") === 0) lastCommittedGoogle = "";

        var isPhoneWindowOpen = (timeToDepart >= -60 && timeToDepart <= 600);
        var phoneDistDelta = 99999;

        if (lastCommittedGoogle !== "" && lastCommittedGoogle.indexOf(",") !== -1) {
            var oldGNavP = lastCommittedGoogle.split(",");
            phoneDistDelta = getDist(parseFloat(oldGNavP[0]), parseFloat(oldGNavP[1]), parseFloat(coordArr[0]), parseFloat(coordArr[1]));
        }
        var grantGooglePush = (isPhoneWindowOpen && (lastCommittedGoogle === "" || phoneDistDelta > 50) && coords !== "0,0");

        setLocal('itin_time1', dTime.toString());
        setLocal('itin_mode1', evalMode);
        setLocal('itin_loc1', title);
        setLocal('itin_start1', startVal.toString());
        setLocal('itin_lat1', coordArr[0] || "0");
        setLocal('itin_lng1', coordArr[1] || "0");
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
        if (lastSched > 0 && lastSched > nowSec) {
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
    try {
        var lockRaw = readFile("Tasker/Tesla/Data/TDS_Action_Lock.json");
        if (lockRaw && lockRaw.indexOf("%") === -1) {
            var lockData = JSON.parse(lockRaw);
            if (nowSec - parseInt(lockData.timestamp || 0) < 7200) {
                isActionLocked = true;
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
    } else if (targetDrive === undefined) {
        // INV-0.6 AC-10: no actionable trip → idle sync.
        syncIntervalMins = IDLE_SYNC_MINS;
        flash(JSON.stringify({
            timestamp: nowSec,
            generationId: global('TDS_Active_Generation') || null,
            component: "Dispatcher",
            severity: "INFO",
            code: "IDLE_SYNC_ENGAGED",
            tripId: null,
            details: { syncIntervalMins: IDLE_SYNC_MINS }
        }));
    } else {
        var gapMins = Math.floor((targetDrive.departUnix - nowSec) / 60);
        if (gapMins > 180) syncIntervalMins = 120;
        else if (gapMins > 60) syncIntervalMins = 60;
        else if (gapMins > 30) syncIntervalMins = 30;
        // If targetDrive is overdue, gapMins is negative → SOON_SYNC_MINS; IDLE_SYNC_ENGAGED is reserved for the empty-master / all-truly-stale case.
        else syncIntervalMins = SOON_SYNC_MINS;
    }

    var nextSyncMs = Date.now() + (syncIntervalMins * 60000);
    var syncDate   = new Date(nextSyncMs);
    setGlobal('Next_Sync', (syncDate.getHours()<10?'0':'')+syncDate.getHours() + "." + (syncDate.getMinutes()<10?'0':'')+syncDate.getMinutes());

} catch(err) { flash("Dispatcher Fault: " + err.message); }
