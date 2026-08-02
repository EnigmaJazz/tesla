// ==========================================
// SCRIPT 3: ENGINE FINALISER (v25.1)
// 12-Hour Geofence Limit: Only monitors locations starting within 12 hours.
// Geofence Limit: Stops generating geofences after the first strict event.
// Applies Sequence & Temporal Breaking to isolate Multi-Dropin Clustering.
// [V25.1] Time-Gap collision fix, Strict Event Purge Protection. Gravity threshold moved to Sandbox.
// ==========================================

function getDist(lat1, lon1, lat2, lon2) {
    let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

// Phase 3 PR-B: stage an OBSERVE_ARRIVAL reducer command. The Trip State
// Reducer is the sole writer of TDS_Trip_State.json; arrival observations
// now flow through it. In Tasker the next action reads local('par1') and
// runs the reducer; in the test harness a sandbox.reducer callback is
// available, so use it when present.
function observeArrival(payload) {
    setLocal('par1', 'OBSERVE_ARRIVAL');
    setLocal('par2', JSON.stringify(payload));
    if (typeof reducer === 'function') {
        return reducer('OBSERVE_ARRIVAL', payload);
    }
    return null;
}

try {
    let tempRaw = local('tds_temp_json') || "[]";
    if (tempRaw.indexOf("%") === 0) tempRaw = "[]";
    let validEvents = JSON.parse(tempRaw);

    let diskRaw = readFile("Tasker/Tesla/Data/Geocode_Cache.json");
    let diskLower = {};
    if (diskRaw && diskRaw.indexOf("%") === -1) {
        try {
            let rawJson = JSON.parse(diskRaw);
            for (let dKey in rawJson) {
                if (rawJson.hasOwnProperty(dKey)) diskLower[dKey.trim().toLowerCase()] = rawJson[dKey];
            }
        } catch(e) {}
    }

    let nowSec = Math.floor(Date.now() / 1000);

    for (let i = 0; i < validEvents.length; i++) {
        let cleanLoc = (validEvents[i].loc || "").trim().toLowerCase();
        if (diskLower[cleanLoc]) validEvents[i].coords = diskLower[cleanLoc];
    }

    // ==========================================
    // SPATIAL DEPARTURE & ARRIVAL TRACKING 
    // ==========================================
    let pLocRaw = global('TDS_Previous_Loc') || "0,0";
    let cLocRaw = global('User_Loc') || "0,0";
    let pLat = parseFloat(pLocRaw.split(",")[0]); let pLon = parseFloat(pLocRaw.split(",")[1]);
    let cLat = parseFloat(cLocRaw.split(",")[0]); let cLon = parseFloat(cLocRaw.split(",")[1]);
    
    // E1 (RULE-8C): Completed_Dropins / Arrival_Memory are documented
    // transient global state, not OVR top-level arrays.
    let completedRaw = global('TDS_Completed_Dropins') || "";
    let completed = completedRaw ? completedRaw.split(",") : [];
    let arrivalMemRaw = global('TDS_Arrival_Memory') || "";
    
    let stateChanged = false;
    let survivingEvents = [];
    
    for (let i = 0; i < validEvents.length; i++) {
        let ev = validEvents[i];
        
        let timeEligible = false;
        if (ev.isDropin) {
            if (isSameUTCDay(ev.start, nowSec)) timeEligible = true;
            else if (nowSec <= (ev.end + 14400)) timeEligible = true;
        } else {
            timeEligible = (nowSec >= (ev.start - 7200) && nowSec <= (ev.end + 14400));
        }
        
        if (ev.coords && ev.coords !== "0,0" && timeEligible) {
            let eLat = parseFloat(ev.coords.split(",")[0]); let eLon = parseFloat(ev.coords.split(",")[1]);
            let dPrev = getDist(pLat, pLon, eLat, eLon);
            let dCurr = getDist(cLat, cLon, eLat, eLon);
            
            if (!isNaN(dPrev) && !isNaN(dCurr) && dPrev <= 200 && dCurr > 200) {
                // [SURGICAL UPGRADE: Strict Event Purge Protection]
                if (ev.isDropin || nowSec > ev.end) {
                    if (completed.indexOf(ev.id) === -1) {
                        completed.push(ev.id);
                        stateChanged = true;
                        // Phase 3 PR-C: stage COMPLETE_DROPIN for the Trip State Reducer.
                        // The legacy Completed_Dropins OVR write below remains as a
                        // read-side shim for components that have not yet been migrated
                        // to state.completedDropins.
                        setLocal("par1", "COMPLETE_DROPIN");
                        setLocal("par2", JSON.stringify({
                            generationId: global("TDS_Active_Generation") || "gen:0:0000",
                            dropinId: ev.id,
                            tripId: ev.id,
                            at: nowSec
                        }));
                        if (typeof reducer === "function") {
                            let r = reducer("COMPLETE_DROPIN", JSON.parse(local("par2")));
                            if (typeof r === "string" && r.indexOf("OK") !== 0) {
                                flash("Reducer rejected COMPLETE_DROPIN: " + r);
                            }
                        }
                    }
                }
            }

            if (!isNaN(dCurr) && dCurr <= 200) {
                if (arrivalMemRaw.indexOf(ev.id + "~") === -1) {
                    arrivalMemRaw += (arrivalMemRaw.length > 0 ? "," : "") + ev.id + "~" + nowSec;
                    stateChanged = true;
                    // Phase 3 PR-B: record arrival observation in reducer-managed state.
                    // The legacy Arrival_Memory override remains as a read-side fallback
                    // for components that have not yet been migrated to state.trips[].
                    observeArrival({
                        generationId: global('TDS_Active_Generation') || "gen:0:0000",
                        tripId: ev.id,
                        at: nowSec,
                        accuracyM: 150
                    });
                }
            }
        }
        
        if (completed.indexOf(ev.id) === -1) survivingEvents.push(ev);
    }
    
    validEvents = survivingEvents;
    
    if (stateChanged) {
        setGlobal('TDS_Completed_Dropins', completed.join(","));
        setGlobal('TDS_Arrival_Memory', arrivalMemRaw);
    }

    let nextGeoCoords = "NONE";
    let nextGeoTitle  = "NONE";
    let foundStrict = false;
    let geofences = [];

    for (let i = 0; i < validEvents.length; i++) {
        let ev = validEvents[i];
        if (ev.coords && ev.coords !== "0,0" && !foundStrict) {
            let safeTitle = (ev.title || "").replace(/[^a-zA-Z0-9 ]/g, "").trim();
            
            if (nextGeoCoords === "NONE" && ev.end > nowSec && !ev.isDropin) {
                nextGeoCoords = ev.coords.replace(",", "~");
                nextGeoTitle  = safeTitle;
            }

            if ((ev.start - nowSec) < 43200) {
                geofences.push("TDS_" + safeTitle + "~" + ev.coords);
            }
            if (!ev.isDropin) foundStrict = true; 
        }
    }

    let baseStr = local('raw_base_data') || "";
    let finalBaseStr = "";
    
    if (baseStr && baseStr.indexOf("%") === -1 && baseStr.length > 3) {
        let bases = baseStr.split("|");
        for (let b = 0; b < bases.length; b++) {
            let parts = bases[b].split("~");
            let bLocClean = (parts[5] || "").trim().toLowerCase();
            if (diskLower[bLocClean]) parts[2] = diskLower[bLocClean];
            finalBaseStr += (finalBaseStr.length > 0 ? "|" : "") + parts.join("~");
        }
    }

    let adHoc = global('AdHoc_Base') || "";
    if (adHoc.indexOf("%") !== 0 && adHoc.length > 5) finalBaseStr += (finalBaseStr.length > 0 ? "|" : "") + adHoc;

    let currentItinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
    let currentItin = [];
    try { currentItin = JSON.parse(currentItinRaw); } catch(e) {}

    publishCandidate({ events: validEvents, master: validEvents, itinerary: currentItin });

    let baseFilePath = "Tasker/Tesla/Data/TDS_Base_Geocodes.txt";
    let oldBaseStr = "";
    try { oldBaseStr = readFile(baseFilePath) || ""; } catch(e) {}

    if (finalBaseStr !== oldBaseStr) writeFile(baseFilePath, finalBaseStr, false);

    setLocal('next_geo_coords', nextGeoCoords);
    setLocal('next_geo_title', nextGeoTitle);
    
    // ==========================================
    // OVERRIDE PROTECTION MERGE
    // ==========================================
    let overrideFile = "Tasker/Tesla/Data/TDS_Action_Lock.json";
    let activeOverride = null;

    try {
        let ovRaw = readFile(overrideFile) || "{}";
        activeOverride = JSON.parse(ovRaw);
    } catch(e) { activeOverride = null; }

    if (activeOverride && activeOverride.type) {
        if (nowSec - activeOverride.timestamp < 7200) {
            let newItinStr = global('Engine_Output_Itinerary') || "[]"; 
            let newItin = JSON.parse(newItinStr);
            let currentMasterRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
            let currentMaster = JSON.parse(currentMasterRaw);
            
            if (currentMaster.length > 0 && currentMaster[0].targetEventId === activeOverride.eventId) {
                newItin.unshift(currentMaster[0]); 
                setGlobal('Engine_Output_Itinerary', JSON.stringify(newItin));
            }
        } else {
            writeFile(overrideFile, "{}", false);
        }
    }

    // ==========================================
    // GEOFENCE BASE APPEND
    // ==========================================
    let activeBaseCoords = "0,0"; let activeBaseName = "";
    if (finalBaseStr.length > 5) {
        let bList = finalBaseStr.split("|");
        for (let b=0; b<bList.length; b++) {
            if (!bList[b]) continue;
            let bp = bList[b].split("~");
            if (nowSec >= parseFloat(bp[0]) && nowSec <= parseFloat(bp[1])) {
                activeBaseCoords = bp[2]; activeBaseName = bp[4] || "Base"; break;
            }
        }
    }
    
    if (activeBaseCoords !== "0,0" && activeBaseName.toLowerCase() !== "home") {
        let safeBase = activeBaseName.replace(/[^a-zA-Z0-9 ]/g, "").trim();
        geofences.push("TDS_Base_" + safeBase + "~" + activeBaseCoords);
    }
    
    setLocal('active_geofences', geofences.join("|"));

    // ==========================================
    // MULTI-DROPIN CLUSTERING (SEQUENTIAL & TEMPORAL BOUNDARIES)
    // ==========================================
    let optimizeQueue = [];
    let currentCluster = [];
    let lastDropinTime = 0;
    
    for (let j = 0; j < validEvents.length; j++) {
        let ve = validEvents[j];
        
        let veEnd = (ve.isDropin && ve.deadline) ? ve.deadline : ve.end;
        if (veEnd <= nowSec) continue;

        if (ve.isDropin) {
            if (currentCluster.length > 0 && (ve.start - lastDropinTime > 14400)) {
                if (currentCluster.length > 1) {
                    // [SURGICAL UPGRADE: Time-Gap Anchor Fix]
                    optimizeQueue.push({ waypoints: currentCluster, destination: { coords: currentCluster[currentCluster.length-1].coords, id: "TIME_GAP_ANCHOR" } });
                }
                currentCluster = [];
            }
            currentCluster.push(ve);
            lastDropinTime = ve.start;
        } else {
            if (currentCluster.length > 1) { 
                optimizeQueue.push({ waypoints: currentCluster, destination: { coords: ve.coords, id: ve.id } });
            }
            currentCluster = [];
        }
    }

    if (currentCluster.length > 1) {
        let eAnchor = (global('Home_Coords') || "0,0");
        if (activeBaseCoords !== "0,0") eAnchor = activeBaseCoords;
        optimizeQueue.push({ waypoints: currentCluster, destination: { coords: eAnchor, id: "EOD_ANCHOR" } });
    }

    writeFile("Tasker/Tesla/Data/TDS_Optimize_Queue.json", JSON.stringify(optimizeQueue), false);

    setLocal('tds_temp_json', "");
    setLocal('raw_base_data', "");

} catch(err) { flash("Finalizer JS Crash: " + err.message); }
