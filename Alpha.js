// ==========================================
// SCRIPT 1: MONOLITHIC ALPHA ENGINE V18.2
// [V18.2] Repaired Holiday/Leave regex to prevent `#leave` tag conflicts.
// ==========================================

let rawAutoBase = parseFloat(global('Auto_Base_Hours'));
let AUTO_BASE_MIN_HOURS = (!isNaN(rawAutoBase) && rawAutoBase > 0) ? rawAutoBase : 3;

function forceMs(val) {
    let n = parseFloat(val); 
    if (isNaN(n) || n <= 0) return 0;
    return (n < 20000000000) ? Math.floor(n * 1000) : Math.floor(n);
}

function getTodayStr() {
    let d = new Date();
    let mm = (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1);
    let dd = (d.getDate() < 10 ? '0' : '') + d.getDate();
    return d.getFullYear() + "-" + mm + "-" + dd;
}

function getSafeId(idStr, startSecInt) {
    let rawStart = !isNaN(startSecInt) ? Math.floor(startSecInt).toString(36) : "";
    return idStr ? (idStr + "_" + rawStart) : rawStart;
}

function getDist(lat1, lon1, lat2, lon2) {
    let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
    let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
    let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isClose(cStrA, cStrB) {
    if (!cStrA || !cStrB || cStrA === "0,0" || cStrB === "0,0") return false;
    let pA = cStrA.split(","), pB = cStrB.split(",");
    if (pA.length !== 2 || pB.length !== 2) return false;
    return getDist(parseFloat(pA[0]), parseFloat(pA[1]), parseFloat(pB[0]), parseFloat(pB[1])) <= 200;
}

try {
    try { writeFile("Tasker/Tesla/Data/TDS_Optimize_Queue.json", "[]", false); } catch(e){}

    let nowSec       = Math.floor(Date.now() / 1000);
    let fetchStartMs = forceMs(global('TIMEMS')); 
    let cutoffMs     = fetchStartMs + 691200000;  

    let filePath = "Tasker/Tesla/Data/TDS_Overrides.json";
    let ovrRaw = readFile(filePath) || "{}";
    let mem = {};
    try { mem = JSON.parse(ovrRaw); } catch(e) {}
    let trimmedEventsRaw = mem['Trimmed_Events'] || "";

    let tempRaw = "";
    try { tempRaw = readFile("Tasker/Tesla/Data/Temp_Route_Cache.txt") || ""; } catch(e){}
    if (tempRaw.indexOf("%") === 0) tempRaw = "";
    
    if (tempRaw.length > 5) {
        let tempArr = tempRaw.split("|");
        let latestApiCallMap = {}; 
        let keepTemp = [];

        for (let t = 0; t < tempArr.length; t++) {
            if (!tempArr[t]) continue;
            let tp = tempArr[t].split("~");
            if (tp.length < 7) continue; 

            let o = tp[0] ? tp[0].trim() : "";
            let d = tp[1] ? tp[1].trim() : "";
            let m = tp[2] ? tp[2].trim() : "";
            
            if (!o || !d || o === "0,0" || d === "0,0") continue;

            let durSec    = parseInt(tp[3], 10);
            let distM     = parseInt(tp[4], 10);
            let apiUnix   = parseInt(tp[5], 10);
            let targetSec = parseInt(tp[6], 10); 

            if (isNaN(durSec) || isNaN(distM) || isNaN(apiUnix) || isNaN(targetSec)) continue;
            if (distM > 3000000 || distM > 10000000) continue; 

            let key = o + "~~" + d + "~~" + m;

            if (nowSec >= targetSec) {
                if (!latestApiCallMap[key] || latestApiCallMap[key].apiUnix < apiUnix) {
                    latestApiCallMap[key] = { 
                        o: o, d: d, m: m, dur: durSec, dist: distM, 
                        apiUnix: apiUnix, eventUnix: targetSec 
                    };
                }
            } else {
                keepTemp.push(tempArr[t]);
            }
        }
        writeFile("Tasker/Tesla/Data/Temp_Route_Cache.txt", keepTemp.join("|"), false);

        let tripsToCommit = Object.keys(latestApiCallMap).map(function(k) { return latestApiCallMap[k]; });
        
        if (tripsToCommit.length > 0) {
            let rCacheRaw = "";
            try { rCacheRaw = readFile("Tasker/Tesla/Data/RouteCache.txt") || ""; } catch(e){}
            let routes = rCacheRaw.split("|");

            for (let c = 0; c < tripsToCommit.length; c++) {
                let trip = tripsToCommit[c];
                let to = trip.o, td = trip.d, tm = trip.m, finalDur = trip.dur, tUnix = trip.eventUnix;

                let tDate   = new Date(tUnix * 1000);
                let tod     = tDate.getHours() * 60 + tDate.getMinutes();
                let dayType = (tDate.getDay() === 0 || tDate.getDay() === 6) ? 1 : 0;

                let matchFound = false; let isOutlier = false; let updatedRoutes = [];
                let zombieTracker = {}; 

                for (let r = 0; r < routes.length; r++) {
                    if (!routes[r] || routes[r].indexOf("~") === -1) continue;
                    let p = routes[r].split("~");
                    if (p.length < 10) continue; 

                    let isSpatialMatch = (p[2] === tm && isClose(p[0], to) && isClose(p[1], td));

                    if (isSpatialMatch && tm !== "WALK") {
                        let cTod     = parseInt(p[7], 10);
                        let cDayType = parseInt(p[8], 10);
                        let diff     = Math.abs(tod - cTod);
                        if (diff > 720) diff = 1440 - diff;

                        if (diff <= 60 && cTod !== -999 && cDayType === dayType) {
                            let zKey = tm + "_" + cTod + "_" + cDayType;
                            if (zombieTracker[zKey]) continue; 

                            zombieTracker[zKey] = true;
                            matchFound = true;

                            let anchorOrig = p[0]; 
                            let anchorDest = p[1]; 

                            let oldMean = parseFloat(p[3]); 
                            let oldDist = parseInt(p[4], 10) || 0; 
                            let oldM2   = parseFloat(p[6]); 
                            let n       = parseInt(p[9], 10);
                            if (isNaN(n) || n < 1) n = 1;
                            
                            let sd = (n > 2) ? Math.sqrt(oldM2 / (n - 1)) : Math.max(120, oldMean * 0.15);
                            
                            if (n >= 3) {
                                let zScore = Math.abs(finalDur - oldMean) / sd;
                                isOutlier = (zScore > 2.0 && Math.abs(finalDur - oldMean) > 300);
                            } else {
                                isOutlier = (finalDur > oldMean * 3.0 || finalDur < oldMean * 0.33);
                            }

                            if (!isOutlier) {
                                let newN = Math.min(n + 1, 20);
                                let delta = finalDur - oldMean; 
                                let newMean = oldMean + (delta / newN);
                                let delta2 = finalDur - newMean; 
                                let newM2 = oldM2 + (delta * delta2);
                                
                                updatedRoutes.push(anchorOrig + "~" + anchorDest + "~" + tm + "~" + Math.round(newMean) + "~" + oldDist + "~" + nowSec + "~" + Math.round(newM2) + "~" + tod + "~" + dayType + "~" + newN);
                            } else {
                                let shockedN = Math.max(1, Math.floor(n / 2));
                                updatedRoutes.push(anchorOrig + "~" + anchorDest + "~" + tm + "~" + Math.round(oldMean) + "~" + oldDist + "~" + nowSec + "~" + Math.round(oldM2) + "~" + tod + "~" + dayType + "~" + shockedN);
                            }
                            continue;
                        }
                    }
                    if (!isSpatialMatch || p[2] === "WALK") {
                        updatedRoutes.push(p.slice(0, 10).join("~"));
                    }
                }
                
                if (!matchFound && !isOutlier) {
                    updatedRoutes.push(to + "~" + td + "~" + tm + "~" + finalDur + "~" + (trip.dist || 0) + "~" + nowSec + "~0~" + tod + "~" + dayType + "~1");
                }
                routes = updatedRoutes; 
            }
            writeFile("Tasker/Tesla/Data/RouteCache.txt", routes.join("|"), false);
        }
    } 

    let todayStr     = getTodayStr();
    let lastSyncDate = (global('Tesla_Last_Sync') || "").trim();
    if (lastSyncDate !== todayStr) {
        setGlobal('Tesla_Last_Sync', todayStr);
        setGlobal('Daily_Walk_Meters', "0");
    }

    let diskRaw   = readFile("Tasker/Tesla/Data/Geocode_Cache.json");
    let diskLower = {};
    if (diskRaw && diskRaw.indexOf("%") === -1) {
        try {
            let rawJson = JSON.parse(diskRaw);
            for (let dKey in rawJson) if (rawJson.hasOwnProperty(dKey)) diskLower[dKey.trim().toLowerCase()] = rawJson[dKey];
        } catch(e) {}
    }

    let leavePeriods = []; let l = 1;
    while (local('ce_title' + l)) {
        let lt = local('ce_title' + l) || ""; let ld = local('ce_description' + l) || "";
        // [SURGICAL UPGRADE: Holiday vs #leave conflict fix]
        // Strip #leave and #depart before evaluating, and use strict word boundaries
        let holidayTestStr = (lt + " " + ld).replace(/#leave|#depart/gi, "");
        if (/\b(leave|holiday|vacation|oof|out of office)\b/i.test(holidayTestStr)) {
            leavePeriods.push({ start: forceMs(local('ce_start_time' + l)), end: forceMs(local('ce_end_time' + l)) });
        }
        l++;
    }

    let validEvents    = []; let baseStr        = "";
    let missingLocs    = {}; let orphanedTravel = [];
    let whitelistMap   = {}; let i              = 1;

    let autoBaseMinMs  = AUTO_BASE_MIN_HOURS * 3600000;

    while (local('ce_title' + i)) {
        let title   = local('ce_title' + i) || "Untitled"; let rawId      = local('ce_event_id' + i);
        let desc    = local('ce_description' + i) || "";   let startMs = forceMs(local('ce_start_time' + i));
        let endMs   = forceMs(local('ce_end_time' + i));   let rawLoc  = local('ce_location' + i) || "";
        let cal     = local('ce_calendar' + i) || "";

        if (!rawId || startMs === 0 || startMs > cutoffMs) { i++; continue; }

        let startSecInt = Math.floor(startMs / 1000);
        let id          = getSafeId(rawId.trim(), startSecInt); 

        title = title.replace(/[~|]/g, "").trim();
        desc = desc.replace(/[~|]/g, "").trim();
        let loc = rawLoc.replace(/[~|]/g, "").trim();

        if (/tesla.*departures/i.test(cal)) {
            orphanedTravel.push(rawId); 
            i++; continue;
        }

        let fullText = (title + " " + desc).toLowerCase();
        let isDropin = /(#dropin)/i.test(fullText);
        let isPriority = /(#essential)/i.test(fullText);
        
        let expireSec = 0;

        if (isDropin) {
            let closeMatch = fullText.match(/#close:(\d{1,2}):?(\d{2})/i);
            if (closeMatch) {
                let closeD = new Date(startMs);
                closeD.setHours(parseInt(closeMatch[1], 10), parseInt(closeMatch[2], 10), 0, 0);
                expireSec = Math.floor(closeD.getTime() / 1000);
            } else {
                let midnightD = new Date(startMs);
                midnightD.setHours(23, 59, 59, 999);
                expireSec = Math.floor(midnightD.getTime() / 1000);
            }
            if (nowSec >= expireSec) { i++; continue; }
        } else {
            if (endMs <= fetchStartMs) { i++; continue; }
        }

        let rawAd    = local('ce_allday' + i) || "";
        let isAllDay = (rawAd.toString().toLowerCase() === "true" || rawAd.toString() === "1") ? "true" : "false";
        let isBlank  = (!loc || loc.indexOf('%') === 0 || loc.toLowerCase() === "none" || loc.toLowerCase() === "no location");

        let bEndSec = Math.floor(endMs / 1000);
        if (trimmedEventsRaw.length > 5) {
            let tRows = trimmedEventsRaw.split(",");
            for (let t = 0; t < tRows.length; t++) {
                let tp = tRows[t].split("~");
                if ((tp[0] === id || tp[0] === (id + "_OUT")) && !isNaN(parseInt(tp[1], 10))) {
                    bEndSec = Math.min(bEndSec, parseInt(tp[1], 10));
                }
            }
        }

        let durationMs = (bEndSec * 1000) - startMs; 
        let isManualBase = /(#base|#stay|hotel|airbnb)/i.test(fullText);
        let isAutoBase = (durationMs >= autoBaseMinMs && isAllDay !== "true"); 

        if (isManualBase || isAutoBase) {
            let hasCharge = /(#charge|charging)/i.test(fullText) ? "true" : "false";
            if (!isBlank) {
                let cleanKey = loc.toLowerCase();
                let resolvedCoords = diskLower[cleanKey] || "0,0";
                if (resolvedCoords === "0,0") missingLocs[cleanKey] = loc;
                
                baseStr += (baseStr.length > 0 ? "|" : "") + startSecInt + "~" + bEndSec + "~" + resolvedCoords + "~" + hasCharge + "~" + title + "~" + loc + "~" + id;
                
                if (isAllDay !== "true") {
                    whitelistMap[id + "_IN"] = true;
                    whitelistMap[id + "_OUT"] = true;
                    
                    validEvents.push({
                        "id": id + "_IN", "desc": desc, "title": "Start: " + title,
                        "start": startSecInt, "end": startSecInt + 60,     
                        "loc": loc, "coords": resolvedCoords,
                        "deadline": bEndSec,
                        "isEssential": isPriority 
                    });
                    
                    if (bEndSec <= cutoffMs) {
                        validEvents.push({
                            "id": id + "_OUT", "desc": desc, "title": "End: " + title,
                            "start": bEndSec - 60, "end": bEndSec,     
                            "loc": loc, "coords": resolvedCoords,
                            "deadline": bEndSec,
                            "isEssential": isPriority 
                        });
                    }
                }
            }
            i++; continue; 
        }

        if (isAllDay === "true" || isBlank) { i++; continue; }

        let skipWork = false;
        if (/Work/i.test(cal)) {
            for (let p=0; p<leavePeriods.length; p++) if (startMs >= leavePeriods[p].start && startMs < leavePeriods[p].end) { skipWork = true; break; }
        }
        if (skipWork) { i++; continue; }

        let cleanKey       = loc.toLowerCase();
        let resolvedCoords = diskLower[cleanKey] || "0,0";
        if (resolvedCoords === "0,0") missingLocs[cleanKey] = loc; 

        whitelistMap[id] = true; 

        let evObj = {
            "id": id, "desc": desc, "title": title,
            "start": startSecInt, "end": bEndSec,     
            "loc": loc, "coords": resolvedCoords,
            "isEssential": isPriority 
        };

        if (isDropin) {
            evObj.isDropin = true;
            evObj.duration = bEndSec - startSecInt;
            evObj.deadline = expireSec;
            
            let openMatch = fullText.match(/#open:(\d{1,2}):?(\d{2})/i);
            if (openMatch) evObj.open = openMatch[1] + ":" + openMatch[2];
            
            let closeMatch = fullText.match(/#close:(\d{1,2}):?(\d{2})/i);
            if (closeMatch) evObj.close = closeMatch[1] + ":" + closeMatch[2];
            
            let orderMatch = fullText.match(/#dropin:(\d+)/i);
            if (orderMatch) evObj.dropinOrder = parseInt(orderMatch[1], 10);
        }

        validEvents.push(evObj);
        i++;
    }

    validEvents.sort(function(a, b) { return a.start - b.start; });

    let fetchList = [];
    for (let mKey in missingLocs) if (missingLocs.hasOwnProperty(mKey)) fetchList.push(missingLocs[mKey]);

    let adHocRaw = global('AdHoc_Base') || "";
    if (adHocRaw.indexOf("%") !== 0 && adHocRaw.trim() !== "") baseStr = adHocRaw + (baseStr.length > 0 ? "|" + baseStr : "");

    let arraysToPrune = [ 
        "Skipped_Pitstops", "Skipped_Events", "Ignored_Lateness", "Forced_Pitstops", 
        "Forced_Lifts", "Forced_Transit", "Forced_Walks", "Forced_Drives",
        "Forced_Lift_Chains", "Forced_Drive_Chains", "Trimmed_Events", "Depart_Memory", "Ignored_Walks",
        "Completed_Dropins", "Arrival_Memory" 
    ];

    for (let a = 0; a < arraysToPrune.length; a++) {
        let arrName = arraysToPrune[a]; 
        let rawData = mem[arrName] || "";
        if (rawData.length < 2) continue;

        let items = rawData.split(","); let keptItems = [];
        for (let k = 0; k < items.length; k++) {
            let item = items[k]; if (!item || item.trim() === "") continue;
            let parts = item.split("~");
            let baseKey = parts[0].trim();
            
            if (arrName === "Depart_Memory") {
                let depUnix = parseInt(parts[1], 10);
                if (!isNaN(depUnix) && depUnix > (nowSec - 14400)) keptItems.push(item);
                continue;
            }

            if (whitelistMap[baseKey]) { keptItems.push(item); continue; }

            let idParts = baseKey.split("_");
            let eventStartUnix = 0;
            
            for (let p = idParts.length - 1; p >= 0; p--) {
                let parsed = parseInt(idParts[p], 36);
                if (!isNaN(parsed) && parsed > 1000000000 && parsed < 2500000000) {
                    eventStartUnix = parsed;
                    break;
                }
            }
            
            if (eventStartUnix > 0) {
                let isFuture = eventStartUnix > (nowSec + 43200); 
                let isPastActionArray = (arrName === "Completed_Dropins" || arrName === "Arrival_Memory");
                
                if (isFuture && isPastActionArray) continue; 
                
                if (eventStartUnix > (nowSec - 86400)) keptItems.push(item);
                continue;
            }
        }
        mem[arrName] = keptItems.join(",");
    }
    
    writeFile(filePath, JSON.stringify(mem), false);

    setLocal('tds_temp_json', JSON.stringify(validEvents));
    setLocal('raw_base_data', baseStr);
    setLocal('locs_to_fetch', fetchList.join("^^"));
    setLocal('orphaned_travel_ids', orphanedTravel.join("|"));

    setGlobal('TDS_Count', validEvents.length.toString());
    writeFile("Tasker/Tesla/Data/TDS_Master.json", "[]", false);
    writeFile("Tasker/Tesla/Data/Itin_Master.json", "[]", false);

} catch(e) { 
    flash("Monolithic Alpha Engine Crash:\n" + e.message); 
}
