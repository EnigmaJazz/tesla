// ==========================================
// V36 ENGINE SANDBOX (v16.5)
// - Drop-in Gravity: Evaluates Drop-ins against logical A-to-B trip windows on the fly.
// - ASAP Dispatch: Engine routes immediately and pads wait time at destination.
// - Ironclad Latch: Survives GPS drift while in meetings.
// [V16.5] Chronological simAtBase tracking & Temporal Ghost Trip Attachment.
// ==========================================

let GLOBAL_MASTER_ARR = [];

let ovrRaw = "";
try { ovrRaw = readFile("Tasker/Tesla/Data/TDS_Overrides.json") || "{}"; } catch(e) {}
let OVR = {};
try { OVR = JSON.parse(ovrRaw); } catch(e) {}
function getOvr(key) { return OVR[key] || ""; }

let trimmedEventsRaw = getOvr('Trimmed_Events');
let completedStopsRaw = getOvr('Completed_Stops');
let skippedEvents = getOvr('Skipped_Events'); 

function getSafeId(eventObj) {
    if (!eventObj) return "DEFAULT";
    return eventObj.id || "DEFAULT"; 
}

function getTrimmedEnd(evId, rawEnd, start, trimRaw) {
    let e = rawEnd || (start + 3600);
    if (trimRaw && trimRaw.indexOf(evId) !== -1) {
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

function getBase(targetTimeSecs) {
    let baseCoords = global('Home_Coords') || "0,0"; 
    let baseName = "Home"; 
    let baseData = readFile("Tasker/Tesla/Data/TDS_Base_Geocodes.txt") || "none";
    
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

    let baseGeos = readFile("Tasker/Tesla/Data/TDS_Base_Geocodes.txt") || "";
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
        if (getOvr('Forced_Lifts').indexOf(safeId) !== -1) { mode = "LIFT"; forced = true; }
        if (getOvr('Forced_Transit').indexOf(safeId) !== -1) { mode = "TRANSIT"; forced = true; }
        if (getOvr('Forced_Walks').indexOf(safeId) !== -1) { mode = "WALK"; forced = true; }
        if (getOvr('Forced_Drives').indexOf(safeId) !== -1) { mode = "DRIVE"; forced = true; }
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

function getIgnoredPref(evId, ignoredLatenessStr) {
    if (!ignoredLatenessStr || ignoredLatenessStr.indexOf(evId) === -1) return "shifted"; 
    let rows = ignoredLatenessStr.split(",");
    for (let r = 0; r < rows.length; r++) {
        let p = rows[r].split("~");
        if (p[0] === evId && p.length > 1) return p[1].trim().toLowerCase();
    }
    return "shifted";
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

try {
    setGlobal('TDS_Lateness_Halt', 'false');

    let idx = parseInt(local('idx'), 10) || 1; 
    let rawMaster = readFile("Tasker/Tesla/Data/TDS_Master.json") || "[]";
    if (rawMaster.indexOf("%") === 0) rawMaster = "[]";
    let master = JSON.parse(rawMaster);
    GLOBAL_MASTER_ARR = master;

    if (idx > master.length) { 
        setLocal('block_queue', "EOF"); setLocal('skip_idx_until', (master.length + 99).toString());
        setLocal('step_conflict', ""); setLocal('notif_queue', ""); setLocal('is_drive_block', "false");
    } else {
        let nowSec = Math.floor(Date.now() / 1000);
        let incomingStatus = global('Current_Status') || "Idle";
        let hObj = new Date(nowSec * 1000); hObj.setDate(hObj.getDate() + 7); hObj.setHours(23, 59, 59, 999);
        const sevenDayHorizonSec = Math.floor(hObj.getTime() / 1000);

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

                let baseData = readFile("Tasker/Tesla/Data/TDS_Base_Geocodes.txt") || "";
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
                if (currentlyAtBase && !prevAtBase) {
                    setGlobal('User_At_Base', "true"); setGlobal('Base_Arrival_Unix', nowSec.toString());
                } else if (!currentlyAtBase && prevAtBase) {
                    setGlobal('User_At_Base', "false");
                }

                let pitStr = ""; 
                let oldItinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
                if (oldItinRaw.indexOf("%") === 0) oldItinRaw = "[]";
                let oldItin = []; try { oldItin = JSON.parse(oldItinRaw); } catch(e){}
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
                    } else resolvedStatus = "Idle";
                }
                setGlobal('Current_Status', resolvedStatus);
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
        let stateHistory = {}; 
        
        let skippedPitstops = getOvr('Skipped_Pitstops'); 
        let ignoredLateness = getOvr('Ignored_Lateness'); let ignoredWalks = getOvr('Ignored_Walks');

        let maxWalk = parseInt(global('Max_Walk_Meters'), 10) || 8046; 
        let dailyWalkDist = parseInt(global('Daily_Walk_Meters'), 10) || 0;
        let liveThreshold = parseInt(global('Live_Traffic_Threshold'), 10) || 7200;

        let defArrMins = parseInt(global('Arrival_Buffer_Mins'), 10) || 5; 
        let defDepMins = parseInt(global('Departure_Buffer_Mins'), 10) || 5; 

        let ramTier = []; let tempCacheRaw = "";
        try { tempCacheRaw = readFile("Tasker/Tesla/Data/Temp_Route_Cache.txt") || ""; } catch(e) {}
        if (tempCacheRaw.length > 5) {
            let tRows = tempCacheRaw.split("|");
            for (let r = 0; r < tRows.length; r++) {
                if (!tRows[r]) continue; let tp = tRows[r].split("~");
                if (tp.length < 7) continue; 
                ramTier.push({ o: tp[0].trim(), d: tp[1].trim(), m: tp[2].trim(), dur: parseInt(tp[3], 10), dist: parseInt(tp[4], 10), pulledSec: parseInt(tp[5], 10) });
            }
        }
        
        let ssdTier = []; let diskCacheRaw = readFile("Tasker/Tesla/Data/RouteCache.txt") || "";
        if (diskCacheRaw.length > 5) {
            let dRows = diskCacheRaw.split("|");
            for (let s = 0; s < dRows.length; s++) {
                if (!dRows[s]) continue; let sp = dRows[s].split("~");
                if (sp.length < 10) continue; 
                ssdTier.push({ o: sp[0].trim(), d: sp[1].trim(), m: sp[2].trim(), meanDur: parseInt(sp[3], 10), updatedSec: parseInt(sp[5], 10), tod: parseInt(sp[7], 10), dayType: parseInt(sp[8], 10) });
            }
        }

        let simAtBase = false;
        let oldItinRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
        if (oldItinRaw.indexOf("%") === 0) oldItinRaw = "[]";
        let oldItin = []; try { oldItin = JSON.parse(oldItinRaw); } catch(e){}

        const liveAtBase = (global('User_At_Base') === "true");
        const currentStatus = (global('Current_Status') || "").trim();
        const activeInProgress = /^(Driving|Walking|Public Transport|Lift)/i.test(currentStatus);

        if (oldItin.length > 0) {
            let aLeg = oldItin[oldItin.length - 1];
            const priorLegAtBase = (aLeg.mode === "EOD_RETURN" || aLeg.pitstopState === "end_of_day" || (aLeg.targetEventId || "").indexOf("_IN") !== -1) ? "true" : "false";
            if (activeInProgress) {
                simAtBase = false;
            } else if (liveAtBase) {
                if (priorLegAtBase === "false") {
                    flash(JSON.stringify({
                        timestamp: nowSec,
                        generationId: null,
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
                let sIgnoredPref = getIgnoredPref(sEvId, ignoredLateness);
                
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

                if (ov.skip || skippedEvents.indexOf(sId) !== -1) continue;
                
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

                let sIgnoredPref = getIgnoredPref(sId, ignoredLateness);
                
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

            if (evId.indexOf("_OUT") !== -1 && (distToEventDirect < 300 || isMeetingLatched)) {
                let sDepMatch = evDesc.match(/(?:#dep:|#leave:)(\d+)/i);
                let evDepBufSecs = (sDepMatch ? parseInt(sDepMatch[1], 10) : defDepMins) * 60;
                state.time = Math.max(state.time, evEnd) + evDepBufSecs;
                state.loc = evCoords;
                if (evId.indexOf("_IN") !== -1) simAtBase = true; else simAtBase = false;
                skipIdx = i + 1;
                continue;
            }

            if (evStart > sevenDayHorizonSec) {
                let activeBase = getBase(state.time);
                let distToBase = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1]));

                if (distToBase > 300) {
                    let distToNextEv = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(evCoords.split(",")[0]), parseFloat(evCoords.split(",")[1]));
                    let timeGapSecs  = evStart - state.time;

                    if (distToNextEv > 500 || timeGapSecs > 64800) {
                        let eodMode = calcMode(state.loc, activeBase.coords, "", "", "").mode;
                        let tailInheritedId = "EOD_EARLY_" + (master[i - 2] ? getSafeId(master[i - 2]) : "DEFAULT");

                        let carDistToBase = getDist(parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]), parseFloat(activeBase.coords.split(",")[0]), parseFloat(activeBase.coords.split(",")[1]));
                        if (carDistToBase > 300) eodMode = "DRIVE";

                        let carDistEOD = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]));
                        if (eodMode === "DRIVE" && carDistEOD > 200) {
                            let recModeEOD = getRecoveryMode(state.loc, state.carLoc, carDistEOD);
                            let rTimeEOD = getCachedTime(state.loc, state.carLoc, recModeEOD, state.time) || Math.round(carDistEOD / getSpeed(recModeEOD));
                            
                            queue.push("RECOVERY|Car|" + state.carLoc + "|" + recModeEOD + "|" + state.time + "|" + (state.time + rTimeEOD) + "|false|DEPART|" + state.time + "|REC_" + tailInheritedId + "|" + state.carLoc + "|0|false|none|Vehicle Retrieval|");
                            state.time += rTimeEOD; 
                            state.loc = state.carLoc;
                        }

                        queue.push("EOD_RETURN|" + activeBase.name + "|" + activeBase.coords + "|" + eodMode + "|" + state.time + "|" + (state.time + 3600) + "|end_of_day|DEPART|" + state.time + "|" + tailInheritedId + "|" + activeBase.name + "|0|true|none|Return Journey|");
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

            let isBypassed = (ignoredLateness.indexOf(evId) !== -1 || /(#late)\b/i.test(evText));
            
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
                            setGlobal('TDS_Lateness_Halt', 'true'); queue = []; skipIdx = idx; blockMode = null; break;
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

            if (evDeadline <= state.time || skippedEvents.indexOf(evId) !== -1) { skipIdx = i + 1; continue; }
            
            let routeToEv = calcMode(state.loc, evCoords, evStartStr, evText, evId);
            if (routeToEv.isForced) isBypassed = true;

            let arrivalSkipRadius = routeToEv.isForced ? 50 : 200;

            if (!ev.isDropin && (distToEventDirect < arrivalSkipRadius || (isMeetingLatched && distToEventDirect < 1000)) && (evStart - state.time) < 10800 && state.time < evDeadline) {
                let currentIgnoredPref = getIgnoredPref(evId, ignoredLateness);
                if (currentIgnoredPref === "fixed") state.time = Math.max(state.time, evEnd) + evDepBufSecs;
                else state.time = Math.max(state.time, evStartTarget) + evArrBufSecs + (evEnd - evStart) + evDepBufSecs;
                state.loc = evCoords; 
                if (evId.indexOf("_IN") !== -1) simAtBase = true; else simAtBase = false;
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
            
            if (preGap > 0 && activeBase.coords !== "0,0" && distToBaseCheck > 300 && getOvr('Skipped_Pitstops').indexOf(evId) === -1) {
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
                let isForcedPitstop = getOvr('Forced_Pitstops').indexOf(evId) !== -1;
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
                        setGlobal('TDS_Lateness_Halt', 'true'); break; 
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
                        queue.push("RECOVERY|Car|" + state.carLoc + "|" + recMode3 + "|" + state.time + "|" + (state.time + recTimeBase) + "|false|DEPART|" + state.time + "|REC_PIT_" + evId + "|" + state.carLoc + "|0|false|none|Vehicle Retrieval|");
                        state.time += recTimeBase; state.loc = state.carLoc;
                    }
                    
                    let currentLegStable = (i === idx) ? state.isStableOrigin.toString() : "true";
                    queue.push(stopType + "|" + activeBase.name + "|" + activeBase.coords + "|" + routeToBase.mode + "|" + evStart + "|" + (state.time + timeToBase) + "|" + pitFlag + "|DEPART|" + state.time + "|" + compositeId + "|" + activeBase.name + "|0|" + currentLegStable + "|none|" + stopDesc + "|");
                    state.loc = activeBase.coords; 
                    state.time += timeToBase + (isOvernight ? 0 : 1800); 
                    if (routeToBase.mode === "DRIVE") state.carLoc = activeBase.coords;
                    pitstopState = "handled"; 
                    carDist = getDist(parseFloat(state.loc.split(",")[0]), parseFloat(state.loc.split(",")[1]), parseFloat(state.carLoc.split(",")[0]), parseFloat(state.carLoc.split(",")[1]));
                    
                    simAtBase = true;
                    skipIdx = i; break; 
                } else if (preGap >= totalDetour) pitstopState = "possible";
            }

            let coreId = evId.split("_")[0]; 
            let routeSig = originLeg + "^" + evCoords;
            let routineKey = coreId + "^" + routeSig; 
            let routeDefaults = getOvr('Route_Defaults');

            if (routeDefaults.indexOf(routineKey + "^IGNORELATENESS~fixed") !== -1 && ignoredLateness.indexOf(evId) === -1) {
                ignoredLateness += (ignoredLateness ? "," : "") + evId + "~fixed";
                notifQueue.push("Auto-Applied: " + evTitle + "|Routinely fixing end time based on history.|TDS_CLEAR_DEFAULT|" + routineKey + "^IGNORELATENESS~fixed|" + coreId);
            } else if (routeDefaults.indexOf(routineKey + "^IGNORELATENESS~shifted") !== -1 && ignoredLateness.indexOf(evId) === -1) {
                ignoredLateness += (ignoredLateness ? "," : "") + evId + "~shifted";
                notifQueue.push("Auto-Applied: " + evTitle + "|Routinely accepting lateness based on history.|TDS_CLEAR_DEFAULT|" + routineKey + "^IGNORELATENESS~shifted|" + coreId);
            }
            if (routeDefaults.indexOf(routineKey + "^IGNOREWALK") !== -1 && ignoredWalks.indexOf(evId) === -1) {
                ignoredWalks += (ignoredWalks ? "," : "") + evId;
                notifQueue.push("Auto-Applied: " + evTitle + "|Routinely ignoring walk limits based on history.|TDS_CLEAR_DEFAULT|" + routineKey + "^IGNOREWALK|" + coreId);
            }
            
            let routeTimeSecs = getCachedTime(originLeg, evCoords, routeToEv.mode, (state.time + recWalkSecs)) || Math.round(actualDriveDist / getSpeed(routeToEv.mode));
            estTravelSecs += routeTimeSecs;
            dailyWalkDist += legWalkDist;

            let adHocObj = getRemainingStops(evId, evDesc, completedStopsRaw);
            estTravelSecs += adHocObj.secs;
            
            if (dailyWalkDist > maxWalk && ignoredWalks.indexOf(evId) === -1 && legWalkDist > 0) { 
                let dayTag = getDayPrefix(evStart, nowSec);
                let walkMenu = {
                    title: "🚶 [" + dayTag + "] Walk Limit Exceeded (" + Math.round(dailyWalkDist) + "m)",
                    labels: ["Convert leg to Lift", "Ignore limit for today"],
                    s: ["LIFT|" + evId, "IGNORE_WALK|" + evId]
                };
                stepConflict = JSON.stringify({ config: { notify: true, notifyTitle: "Walk Limit Reached", notifyText: "Daily walking threshold breached." }, menu: walkMenu });
                setGlobal('TDS_Lateness_Halt', 'true'); break; 
            }

            let testTargetTime = state.time + estTravelSecs;
            let currentLegStable = (i === idx) ? state.isStableOrigin.toString() : "true";
            
            if (currentLegStable === "false" && i === idx) isBypassed = true;

            let trueDepartureTime;
            if (ev.isDropin && isAttachedDropin) {
                if (isPrevBase && evStartTarget > testTargetTime) {
                    let actualArrival = Math.max(testTargetTime, Math.max(openUnix, evStartTarget));
                    trueDepartureTime = actualArrival + (ev.duration || 0) + adHocObj.secs + evDepBufSecs;
                } else {
                    let actualArrival = Math.max(testTargetTime, openUnix);
                    trueDepartureTime = actualArrival + (ev.duration || 0) + adHocObj.secs + evDepBufSecs;
                }
            } else {
                let finalIgnoredPref = getIgnoredPref(evId, ignoredLateness);
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
                    if (nEv.isDropin || skippedEvents.indexOf(getSafeId(nEv)) !== -1 || /(#late)\b/i.test(nEv.desc)) continue; 
                    
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
            let engineLateMins = (timeGapFromNow <= 64800 && Math.abs(rawDeltaMins) <= 360) ? Math.max(0, rawDeltaMins) : 0;
            
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
                if (routeDefaults.indexOf(routineKey + "^LIFT") !== -1) defMode = "LIFT";
                else if (routeDefaults.indexOf(routineKey + "^WALK") !== -1) defMode = "WALK";
                else if (routeDefaults.indexOf(routineKey + "^DRIVE") !== -1) defMode = "DRIVE";
                else if (routeDefaults.indexOf(routineKey + "^TRANSIT") !== -1) defMode = "TRANSIT";
                
                if (defMode !== "") {
                    let notifText = "Auto-selected " + defMode + " based on your routine history.";
                    let clrAction = "TDS_CLEAR_DEFAULT|" + routineKey + "^" + defMode;
                    notifQueue.push("Auto-Routed: " + safeUIEvTitle + "|" + notifText + "|" + clrAction + "|" + coreId);
                    
                    let ovrObj = {}; ovrObj[i] = { mode: defMode };
                    let simDef = simulateScenario(i, ovrObj);
                    
                    if (defMode === "DRIVE") queue.push("FORCED_DRIVE|" + evId); 
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
                    setGlobal('TDS_Lateness_Halt', 'true'); queue = []; skipIdx = idx; blockMode = null; break; 
                } 
            }

            if (routeToEv.mode !== blockMode && queue.length > 0 && pitstopState !== "handled" && routeToEv.dist > 50) break;

            if (routeToEv.mode === "DRIVE" && carDist > 200) {
                let recMode5 = getRecoveryMode(state.loc, state.carLoc, carDist);
                let rTime = getCachedTime(state.loc, state.carLoc, recMode5, state.time) || Math.round(carDist / getSpeed(recMode5));
                queue.push("RECOVERY|Car|" + state.carLoc + "|" + recMode5 + "|" + state.time + "|" + (state.time + rTime) + "|false|DEPART|" + state.time + "|REC_EV_" + evId + "|" + state.carLoc + "|0|false|none|Vehicle Retrieval|||ASAP");
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

            queue.push("EVENT|" + evTitle + "|" + evCoords + "|" + routeToEv.mode + "|" + displayTime + "|" + trueDepartureTime + "|" + pitstopState + "|" + apiTimeType + "|" + apiTimeUnix + "|" + evId + "|" + evLoc + "|" + engineLateMins + "|" + currentLegStable + "|" + dropinStatusFlag + "|" + safeDesc + "|" + adHocObj.arr.join(",") + "|||" + legPolicy);

            if (i === idx) {
                setLocal('block_step19', legPolicy);
            }
            
            state.loc = evCoords; state.time = trueDepartureTime;
            if (routeToEv.mode === "DRIVE") state.carLoc = evCoords;
            if (evId.indexOf("_IN") !== -1) simAtBase = true; else simAtBase = false;
            skipIdx = i + 1; 
        }

        if (skipIdx > master.length && stepConflict === "") {
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
                    queue.push("RECOVERY|Car|" + state.carLoc + "|" + recModeEOD + "|" + state.time + "|" + (state.time + rTimeEOD) + "|false|DEPART|" + state.time + "|REC_EOD_FINAL|" + state.carLoc + "|0|false|none|Vehicle Retrieval|||ASAP");
                    state.time += rTimeEOD; 
                    state.loc = state.carLoc;
                }

                queue.push("EOD_RETURN|" + eodBase.name + "|" + eodBase.coords + "|" + eodMode + "|" + state.time + "|" + (state.time + 3600) + "|end_of_day|DEPART|" + state.time + "|" + finalAnchorId + "|" + eodBase.name + "|0|true|none|Return Journey|||ASAP");
                simAtBase = true;
            }
        }

        setLocal('block_queue', queue.join("~"));
        setLocal('skip_idx_until', skipIdx.toString());
        setLocal('step_conflict', stepConflict);
        setLocal('notif_queue', notifQueue.join("^^"));
        setLocal('is_drive_block', (blockMode === "DRIVE") ? "true" : "false");
    }
} catch(e) { flash("Sandbox Crash: " + e.message); }
