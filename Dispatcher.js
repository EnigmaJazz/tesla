// ==========================================
// UNIFIED PRE-FLIGHT DISPATCHER V15.1
// Breaks multi-waypoint payloads at overnight bounds to prevent day-bleeding.
// Implements 'Shrinking Tail' subset logic for Multi-Waypoint anti-spam.
// [V15.1] Flawed synthetic EOD removed. Relies strictly on Sandbox spatial EOD generation.
// ==========================================

const IDLE_SYNC_MINS = 60;  // INV-0.6 AC-10: idle sync default when no actionable trip.
const SOON_SYNC_MINS = 10;  // Bucket for actionable heads within 30 minutes (replaces the stale-leg 3-min loop).
const ACTIONABLE_LOOKAHEAD_SECS = 86400;  // First-slice default lookahead; per-leg relevanceDeadlineUnix is second slice.

function getDist(lat1, lon1, lat2, lon2) {
    var R = 6371e3; var rLat1 = lat1 * Math.PI / 180; var rLat2 = lat2 * Math.PI / 180;
    var dLat = (lat2 - lat1) * Math.PI / 180; var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getBoltMins(unixSecs) {
    var ms = parseInt(unixSecs) * 1000;
    if (isNaN(ms) || ms <= 0) return 0;
    var d = new Date(ms);
    var mins = (d.getHours() * 60) + d.getMinutes();
    return mins > 1424 ? 1424 : mins; 
}

try {
    var nowSec = Math.floor(Date.now() / 1000);

    var lastSched = parseInt(global('Tesla_Last_Scheduled')) || 0;
    setLocal('itin_bolt_last', getBoltMins(lastSched).toString());

    var masterRaw = "";
    try { masterRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]"; } catch(e) { masterRaw = "[]"; }
    
    if (masterRaw.indexOf("%") === 0 || masterRaw.trim() === "" || masterRaw === "undefined") {
        masterRaw = "[]";
    }
    var master = JSON.parse(masterRaw);

    let relevanceDeadlineUnix = nowSec + ACTIONABLE_LOOKAHEAD_SECS;

    var targetDrive = undefined;
    var driveIdx = -1;
    let skippedStale = 0;

    for (var i = 0; i < master.length; i++) {
        var trip = master[i];
        if (!trip) continue;
        
        var tripMode = (trip.mode || "").toUpperCase();
        var depUnix  = parseInt(trip.departUnix || trip.time || 0);

        // Locates the next valid active routing block within a 24-hour window
        if (tripMode === "DRIVE" || tripMode === "EOD_RETURN" || tripMode === "WALK" || tripMode === "TRANSIT" || tripMode === "LIFT") {
            if (depUnix < nowSec) {
                // INV-0.6 AC-9: stale past departure; skip and continue to the next actionable leg.
                skippedStale++;
                flash(JSON.stringify({
                    timestamp: nowSec,
                    generationId: null,
                    component: "Dispatcher",
                    severity: "WARN",
                    code: "STALE_TRIP_REJECTED",
                    tripId: trip.tripId || null,
                    details: { depUnix: depUnix, nowSec: nowSec }
                }));
                continue;
            }
            if (depUnix <= relevanceDeadlineUnix) {
                targetDrive = trip;
                driveIdx = i;
                break;
            }
        }
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
                
                let d1 = new Date(lastArrive * 1000).getDate();
                let d2 = new Date(nextDep * 1000).getDate();
                if (d1 !== d2) break; // Break clustering at overnight boundaries
                
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
    } else if (targetDrive === undefined || targetDrive.departUnix < nowSec) {
        // INV-0.6 AC-10: no actionable trip → idle sync. The 3-min bucket is no longer reached from a negative gap.
        syncIntervalMins = IDLE_SYNC_MINS;
        flash(JSON.stringify({
            timestamp: nowSec,
            generationId: null,
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
        else syncIntervalMins = SOON_SYNC_MINS;  // bucket for legitimately-soon heads; was 3 and burned CPU on stale legs
    }

    var nextSyncMs = Date.now() + (syncIntervalMins * 60000);
    var syncDate   = new Date(nextSyncMs);
    setGlobal('Next_Sync', (syncDate.getHours()<10?'0':'')+syncDate.getHours() + "." + (syncDate.getMinutes()<10?'0':'')+syncDate.getMinutes());

} catch(err) { flash("Dispatcher Fault: " + err.message); }
