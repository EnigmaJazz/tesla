// ==========================================
// UNIFIED PRE-FLIGHT DISPATCHER V14.4
// Implements Imminent HVAC window vs Future Scheduling.
// Handles Google Maps idempotency locally.
// ==========================================

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

    var targetDrive = null;

    for (var i = 0; i < master.length; i++) {
        var trip = master[i];
        if (!trip) continue;
        
        var tripMode = (trip.mode || "").toUpperCase();
        var depUnix  = parseInt(trip.departUnix || trip.time || 0);

        if ((tripMode === "DRIVE" || tripMode === "EOD_RETURN" || tripMode === "WALK" || tripMode === "TRANSIT" || tripMode === "LIFT") && (depUnix - nowSec) <= 86400) {
            targetDrive = trip;
            break;
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

        // [SURGICAL UPGRADE: HVAC Window Splitting]
        var lastCommittedSched = parseInt(global('Tesla_Last_Scheduled')) || 0;
        var timeDeltaSecs      = Math.abs(dTime - lastCommittedSched);
        
        // 1. Future Scheduling: Only allow if > 20 mins away (1200s)
        var grantSchedulePush  = (timeToDepart > 1200 && timeToDepart <= 86400 && (lastCommittedSched === 0 || timeDeltaSecs > 300));
        
        // 2. Imminent HVAC: Activate if <= 20 mins away (and up to 5 mins past due)
        var lastHvacPush = parseInt(global('Tesla_Last_HVAC_Unix')) || 0;
        var grantHvacPush = (timeToDepart >= -300 && timeToDepart <= 1200 && (nowSec - lastHvacPush > 1800));

        var lastCommittedNav = (global('Tesla_Last_Nav') || "").trim();
        if (lastCommittedNav.indexOf("%") === 0) lastCommittedNav = ""; 

        var isNavWindowOpen = (timeToDepart >= -300 && timeToDepart <= 3600);
        var navDistDelta    = 99999;

        if (lastCommittedNav !== "" && lastCommittedNav.indexOf(",") !== -1) {
            var oldNavP  = lastCommittedNav.split(",");
            navDistDelta = getDist(parseFloat(oldNavP[0]), parseFloat(oldNavP[1]), parseFloat(coordArr[0]), parseFloat(coordArr[1]));
        }

        var grantNavPush = (isNavWindowOpen && (lastCommittedNav === "" || navDistDelta > 50) && coords !== "0,0");

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

        // Output variables for Tasker actions
        setLocal('do_tesla_schedule', (grantSchedulePush && evalMode === "DRIVE") ? "true" : "false");
        setLocal('do_tesla_hvac', (grantHvacPush && evalMode === "DRIVE") ? "true" : "false");
        setLocal('do_tesla_nav', (grantNavPush && evalMode === "DRIVE") ? "true" : "false");

        setLocal('tds_next_mode', evalMode);
        setLocal('tds_next_coords', coordArr[0] + "," + coordArr[1]);
        setLocal('tds_next_title', title);

        if (evalMode !== "DRIVE" && evalMode !== "EOD_RETURN") {
            if (grantGooglePush) {
                setLocal('do_google_nav', "true");
                
                var gMode = "w"; 
                if (evalMode === "TRANSIT") gMode = "r";
                else if (evalMode === "LIFT") gMode = "d";
                setLocal('gmaps_mode', gMode);
                
            } else {
                setLocal('do_google_nav', "false");
            }
        } else {
            setLocal('do_google_nav', "false");
        }

    } else {
        setLocal('itin_mode1', 'NONE');
        setLocal('itin_time1', '0');
        setLocal('itin_bolt_time', '0');
        setLocal('do_tesla_schedule', 'false');
        setLocal('do_tesla_hvac', 'false');
        setLocal('do_tesla_nav', 'false');
        setLocal('do_google_nav', 'false');
    }

    // --- ACTION LOCK OVERRIDE ---
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
    } else if (master.length > 0) {
        var immediateHead = master[0]; 
        var headTimeSecs  = parseFloat(immediateHead.departUnix || immediateHead.time || immediateHead.start || 0);
        if (headTimeSecs > 0) {
            var gapMins = Math.floor((headTimeSecs - nowSec) / 60);
            if (gapMins > 180) syncIntervalMins = 120; 
            else if (gapMins > 60) syncIntervalMins = 60; 
            else if (gapMins > 30) syncIntervalMins = 30; 
            else syncIntervalMins = 3; 
        }
    }

    var nextSyncMs = Date.now() + (syncIntervalMins * 60000);
    var syncDate   = new Date(nextSyncMs);
    setGlobal('Next_Sync', (syncDate.getHours()<10?'0':'')+syncDate.getHours() + "." + (syncDate.getMinutes()<10?'0':'')+syncDate.getMinutes());

} catch(err) { flash("Dispatcher Fault: " + err.message); }
