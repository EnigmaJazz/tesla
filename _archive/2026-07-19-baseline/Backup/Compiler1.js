// ==========================================
// SCRIPT 4: UNIFIED COMPILER (v24.4)
// Translates multiple #stop:XX delays into physical Calendar travel blocks.
// Exports pending stops into Itin_Master for Tasker UI integration.
// [V24.4] Contextual ASAP Base math, Active Base Caps, & #leave unification.
// ==========================================

function getDist(lat1, lon1, lat2, lon2) {
    const R = 6371e3; const rLat1 = lat1 * Math.PI / 180; const rLat2 = lat2 * Math.PI / 180;
    const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSpeed(mode) {
    const map = { "WALK": 1.4, "TRANSIT": 8.0, "LIFT": 10.0, "DRIVE": 13.0 };
    return map[mode] || 1.4;
}

try {
    const mode        = (local('block_step4') || "WALK").toUpperCase().trim(); 
    const apiType     = (local('block_step8') || "DEPART").trim(); 
    const dest        = (local('block_step3') || "0,0").trim();
    const vTime       = parseInt(local('virtual_time'), 10) || Math.floor(Date.now() / 1000); 
    const evId        = (local('block_step10') || "").trim(); 
    const apiUnix     = parseInt(local('block_step9'), 10) || vTime; 
    const actionType  = (local('block_step1') || "").trim(); 
    const destName    = (local('block_step2') || "Destination").trim();
    const targetDesc  = decodeURIComponent(local('block_step15') || "");
    const pendingStopsRaw = (local('block_step16') || "").trim();

    let duration = parseInt(local('api_duration_secs'), 10);
    let distMiles = parseFloat(local('api_distance_miles')) || 0;

    if (isNaN(duration) || duration <= 0 || isNaN(distMiles) || distMiles <= 0) {
        if (apiType === "ACTIVE_TRAVEL") {
            const orig = (global('User_Loc') || "0,0").trim(); 
            const oP = orig.split(","); const dP = dest.split(",");
            const distM = getDist(parseFloat(oP[0]), parseFloat(oP[1]), parseFloat(dP[0]), parseFloat(dP[1]));
            duration = Math.round(distM / getSpeed(mode));
            distMiles = parseFloat((distM * 0.000621371).toFixed(1));
            setLocal('api_duration_secs', duration.toString());
            setLocal('api_distance_miles', distMiles.toString());
        } else {
            duration = duration > 0 ? duration : 0; 
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
        duration += stopPadSecs;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let actualDeparture = (apiType === "ACTIVE_TRAVEL") ? nowSec : Math.max(vTime, (apiType === "ARRIVE" ? apiUnix - duration : apiUnix));
    let actualArrival   = actualDeparture + duration;

    let ovrRaw = "{}";
    try { ovrRaw = readFile("Tasker/Tesla/Data/TDS_Overrides.json") || "{}"; } catch(e) {}
    let OVR = {};
    try { OVR = JSON.parse(ovrRaw); } catch(e) {}

    const depMemRaw = OVR['Depart_Memory'] || "";
    let depMem = []; let oldDepart = null; let foundDep = false;

    if (depMemRaw.length > 2) {
        const parts = depMemRaw.split(",");
        for (let k = 0; k < parts.length; k++) {
            if (!parts[k]) continue;
            const dp = parts[k].split("~");
            if (dp[0] === evId) { oldDepart = parseInt(dp[1], 10); foundDep = true; depMem.push(evId + "~" + actualDeparture); } 
            else if (dp[0]) depMem.push(parts[k]);
        }
    }
    if (!foundDep) depMem.push(evId + "~" + actualDeparture);
    
    OVR['Depart_Memory'] = depMem.join(",");
    try { writeFile("Tasker/Tesla/Data/TDS_Overrides.json", JSON.stringify(OVR), false); } catch(e){}
    
    let departChanged = "false"; let departDiffMins = 0;
    let liveLateMins = parseInt(local('block_step12'), 10) || 0;
    let apiConflictStr = "";

    const timeGapFromNow = apiUnix - nowSec;
    if (timeGapFromNow <= 64800) {
        if (oldDepart !== null && !isNaN(oldDepart) && oldDepart !== actualDeparture) {
            let diffDays = Math.round((new Date(apiUnix*1000).setHours(0,0,0,0) - new Date(nowSec*1000).setHours(0,0,0,0)) / 86400000);
            if (diffDays === 1 && actionType !== "EOD_RETURN" && actionType !== "EOD") {
                departChanged = "true"; departDiffMins = Math.round((actualDeparture - oldDepart) / 60); 
            }
        }
        const ignored = OVR['Ignored_Lateness'] || "";
        if (liveLateMins > 0 && ignored.indexOf(evId) === -1 && actionType === "EVENT" && apiType !== "ACTIVE_TRAVEL") {
            apiConflictStr = "AUTO_REPLAN|" + evId;
        }
    } else liveLateMins = 0;

    setLocal('depart_changed', departChanged); setLocal('depart_diff_mins', departDiffMins.toString());
    setLocal('api_conflict', apiConflictStr); setLocal('live_late_mins', liveLateMins.toString());

    let steps = local('api_transit_steps') || "";
    if (apiType === "ACTIVE_TRAVEL") steps = "🚗 Route securely managed by vehicle onboard navigation";

    let masterRaw = readFile("Tasker/Tesla/Data/TDS_Master.json") || "[]";
    if (masterRaw.indexOf("%") === 0) masterRaw = "[]";
    let masterArr = [];
    try { masterArr = JSON.parse(masterRaw); } catch(e){}

    let itineraryRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
    if (itineraryRaw.indexOf("%") === 0) itineraryRaw = "[]";
    let itinerary = [];
    try { itinerary = JSON.parse(itineraryRaw); } catch(e){}

    let actualBuffer = 0;
    let actualLate = 0;
    let activeHold = 0;

    for (let m = 0; m < masterArr.length; m++) {
        let e = masterArr[m];
        let safeId = e.id || "DEFAULT";
        
        if (safeId === evId) {
            let evStartSecs = parseInt(e.start, 10);
            
            if (apiType === "DEPART" && mode !== "TRANSIT") {
                let arrMatch = targetDesc.match(/#arr:(\d+)/i);
                let defArrMins = parseInt(global('Arrival_Buffer_Mins'), 10) || 5;
                let isDepart = /(#leave|#depart)\b/i.test((destName || "") + " " + targetDesc);
                let targetBufferSecs = isDepart ? 0 : (arrMatch ? parseInt(arrMatch[1], 10) : defArrMins) * 60;
                
                let idealDeparture;
                let targetArrival;
                
                if (isDepart) {
                    idealDeparture = evStartSecs;
                    targetArrival = idealDeparture + duration;
                } else {
                    targetArrival = evStartSecs - targetBufferSecs;
                    idealDeparture = targetArrival - duration;
                }
                
                let hardFloor = nowSec; 
                let foundPrev = false;

                if (itinerary.length > 0) {
                    let prevLeg = itinerary[itinerary.length - 1];
                    let prevArr = parseInt(prevLeg.arriveUnix, 10);
                    hardFloor = prevArr + 60; 
                    
                    for (let p = 0; p < masterArr.length; p++) {
                        let pId = masterArr[p].id || "DEFAULT";
                        if (pId === prevLeg.targetEventId) {
                            let pDesc = masterArr[p].desc || "";
                            let isPrevDropin = /(#dropin)/i.test((masterArr[p].title || "") + " " + pDesc) || masterArr[p].isDropin;
                            
                            if (isPrevDropin) {
                                hardFloor = prevArr;
                            } else {
                                let prevEnd = parseInt(masterArr[p].end, 10);
                                if (pId.indexOf("_IN") !== -1 && masterArr[p].deadline) {
                                    prevEnd = parseInt(masterArr[p].deadline, 10);
                                } else {
                                    let trimmedRaw = OVR['Trimmed_Events'] || "";
                                    if (trimmedRaw.indexOf(pId) !== -1) {
                                        let tRows = trimmedRaw.split(",");
                                        for (let t = 0; t < tRows.length; t++) {
                                            let tp = tRows[t].split("~");
                                            if (tp[0] === pId && !isNaN(parseInt(tp[1], 10))) prevEnd = Math.min(prevEnd, parseInt(tp[1], 10));
                                        }
                                    }
                                }
                                
                                let depM = pDesc.match(/(?:#dep:|#leave:)(\d+)/i);
                                let defDepMins = parseInt(global('Departure_Buffer_Mins'), 10) || 5;
                                let isPDep = /(#leave|#depart)\b/i.test((masterArr[p].title || "") + " " + pDesc);
                                let prevDepBuf = isPDep ? 0 : (depM ? parseInt(depM[1], 10) : defDepMins) * 60;
                                
                                hardFloor = prevEnd + prevDepBuf;
                            }
                            foundPrev = true; break;
                        }
                    }
                    
                    if (!foundPrev) {
                        if (prevLeg.pitstopState === "forced" || prevLeg.pitstopState === "handled") hardFloor = prevArr + 1800; 
                        else if (prevLeg.mode === "EOD_RETURN" || prevLeg.pitstopState === "end_of_day") hardFloor = nowSec; 
                    }
                }
                
                hardFloor = Math.max(nowSec, hardFloor);

                let holdUntil = parseInt(global('TDS_Hold_Until'), 10) || 0;
                if (itinerary.length === 0 && holdUntil > nowSec) {
                    activeHold = holdUntil;
                    hardFloor = Math.max(hardFloor, activeHold);
                }

                // [SURGICAL UPGRADE: Active Base Caps & Contextual ASAP]
                let isDropin = /(#dropin)/i.test(targetDesc);
                let leaveASAP = false;
                let isPrevBase = false;
                
                if (itinerary.length > 0) {
                    let prevLeg = itinerary[itinerary.length - 1];
                    if (prevLeg.mode === "EOD_RETURN" || prevLeg.pitstopState === "end_of_day" || prevLeg.pitstopState === "forced" || prevLeg.pitstopState === "handled") {
                        isPrevBase = true;
                    } else if ((prevLeg.targetEventId || "").indexOf("_IN") !== -1) {
                        isPrevBase = true;
                    }
                } else {
                    if (global('User_At_Base') === "true") isPrevBase = true;
                }

                let activeBaseEnd = 2000000000;
                if (isPrevBase) {
                    let bData = readFile("Tasker/Tesla/Data/TDS_Base_Geocodes.txt") || "";
                    if (bData.length > 3) {
                        let bases = bData.split("|");
                        for (let b = 0; b < bases.length; b++) {
                            if (!bases[b]) continue;
                            let bp = bases[b].split("~");
                            if (hardFloor >= parseFloat(bp[0]) && hardFloor <= parseFloat(bp[1])) {
                                activeBaseEnd = parseFloat(bp[1]); break;
                            }
                        }
                    }
                }

                if (isDropin) leaveASAP = true;
                else if (!isPrevBase) leaveASAP = true; 

                if (leaveASAP) {
                    actualDeparture = hardFloor;
                } else {
                    actualDeparture = Math.min(activeBaseEnd, Math.max(hardFloor, idealDeparture));
                }

                actualArrival = actualDeparture + duration;
            }

            let delta = evStartSecs - actualArrival; 
            if (delta >= 0) actualBuffer = Math.floor(delta / 60);
            else actualLate = Math.ceil(Math.abs(delta) / 60);
            
            break;
        }
    }

    if (apiType === "ACTIVE_TRAVEL" || duration <= 0) {
        setLocal('cal_title_out', "SKIP_CALENDAR");
        setLocal('cal_start_out', "");
        setLocal('cal_end_out', "");
    } else {
        let isDropin = /(#dropin)/i.test(targetDesc);
        let modeEmoji = "🚗"; 
        if (mode === "WALK") modeEmoji = "🚶";
        else if (mode === "TRANSIT") modeEmoji = "🚆";
        else if (mode === "LIFT") modeEmoji = "🚕";

        let finalTitle = isDropin ? ("🔄 Drop-in: " + destName) : (modeEmoji + " to " + destName);
        if (stopPadSecs > 0) finalTitle += " (+" + stopUiStr + " stop" + (pendingStopsRaw.indexOf(",") !== -1 ? "s" : "") + ")";

        setLocal('cal_title_out', String(finalTitle));
        setLocal('cal_start_out', String(actualDeparture * 1000));
        setLocal('cal_end_out', String(actualArrival * 1000));
    }

    setLocal('api_actual_depart', actualDeparture.toString());
    setLocal('api_actual_arrive', actualArrival.toString());

    if (duration > 0) {
        itinerary.push({
            targetEventId: evId, targetTitle: destName, targetDesc: targetDesc, targetCoords: dest, mode: mode,
            departUnix: actualDeparture, arriveUnix: actualArrival, durationSecs: duration || (actualArrival - actualDeparture),
            distanceMiles: distMiles, pitstopState: local('block_step7') || "false", 
            latenessMins: actualLate,
            bufferMins: actualBuffer,
            transitStepsRaw: steps,
            holdUntilUnix: activeHold,
            pendingStopsRaw: pendingStopsRaw 
        });
    }
    writeFile("Tasker/Tesla/Data/Itin_Master.json", JSON.stringify(itinerary), false);

} catch(e) { flash("Unified Engine Crash:\n" + e.message); }