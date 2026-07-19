// ==========================================
// SCRIPT 4: UNIFIED COMPILER (v24.18)
// Translates multiple #stop:XX delays into physical Calendar travel blocks.
// Exports pending stops into Itin_Master for Tasker UI integration.
// [V24.18] Merged V24.17 Tasker-safe dummy array injection ("IGNORE")
//          while preserving V24.16 conflict detection, Hold/Flush JIT,
//          active-travel fallback recalculation, and stop padding behaviour.
// ==========================================

function getDist(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const rLat1 = lat1 * Math.PI / 180; 
    const rLat2 = lat2 * Math.PI / 180;
    const dLat = (lat2 - lat1) * Math.PI / 180; 
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
              Math.cos(rLat1) * Math.cos(rLat2) * 
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
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
    const isAttachedDropin = (local('block_step14') === "attached_dropin");

    let duration = parseInt(local('api_duration_secs'), 10);
    let distMiles = parseFloat(local('api_distance_miles')) || 0;

    // Preserve V24.16 behaviour:
    // If either duration or distance is invalid, active travel gets a local haversine fallback.
    if (isNaN(duration) || duration <= 0 || isNaN(distMiles) || distMiles <= 0) {
        if (apiType === "ACTIVE_TRAVEL") {
            const orig = (global('User_Loc') || "0,0").trim(); 
            const oP = orig.split(","); 
            const dP = dest.split(",");

            const distM = getDist(
                parseFloat(oP[0]), 
                parseFloat(oP[1]), 
                parseFloat(dP[0]), 
                parseFloat(dP[1])
            );

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

        // stopPadSecs enters the next-leg gap at lines 241/308; durationSecs is route-only.
    }

    const nowSec = Math.floor(Date.now() / 1000);

    let masterRaw = readFile("Tasker/Tesla/Data/TDS_Master.json") || "[]";
    if (masterRaw.indexOf("%") === 0) masterRaw = "[]";

    let masterArr = [];
    try { 
        masterArr = JSON.parse(masterRaw); 
    } catch(e) {}

    let mEv = masterArr.find(e => (e.id || "DEFAULT") === evId);
    let evStartSecs = mEv ? parseInt(mEv.start, 10) : parseInt(local('block_step5'), 10) || nowSec;
    let dropinDur = mEv ? (parseInt(mEv.duration, 10) || 0) : 0;

    let isDepartEventLateCheck = /(#leave|#depart)\b/i.test((destName || "") + " " + targetDesc);

    let currentLeg = {
        targetEventId: evId,
        targetTitle: destName,
        targetDesc: targetDesc,
        targetCoords: dest,
        mode: mode,
        durationSecs: duration,
        distanceMiles: distMiles,
        pitstopState: local('block_step7') || "false",
        evStartSecs: evStartSecs,
        isDepart: isDepartEventLateCheck,
        transitStepsRaw: local('api_transit_steps') || "", 
        pendingStopsRaw: pendingStopsRaw,
        isAttachedDropin: isAttachedDropin,
        dropinDur: dropinDur, 
        stopPadSecs: stopPadSecs,
        stopUiStr: stopUiStr,
        apiType: apiType,
        actionType: actionType,
        apiUnix: apiUnix
    };

    let pendingCompilerRaw = readFile("Tasker/Tesla/Data/Pending_Compiler.json") || "[]";
    if (pendingCompilerRaw.indexOf("%") === 0) pendingCompilerRaw = "[]";

    let pendingChain = []; 
    try { 
        pendingChain = JSON.parse(pendingCompilerRaw); 
    } catch(e) {}

    if (actionType === "EVENT" && isAttachedDropin) {
        pendingChain.push(currentLeg);
        writeFile("Tasker/Tesla/Data/Pending_Compiler.json", JSON.stringify(pendingChain), false);

        setLocal('cal_title_out', "HOLD");

        // V24.17 update:
        // Use dummy values to stop Tasker Variable Split crashes on empty arrays.
        setLocal('cal_start_out', "IGNORE");
        setLocal('cal_end_out', "IGNORE");
    } 
    else {
        pendingChain.push(currentLeg);
        writeFile("Tasker/Tesla/Data/Pending_Compiler.json", "[]", false); 

        let itineraryRaw = readFile("Tasker/Tesla/Data/Itin_Master.json") || "[]";
        if (itineraryRaw.indexOf("%") === 0) itineraryRaw = "[]";

        let itinerary = [];
        try { 
            itinerary = JSON.parse(itineraryRaw); 
        } catch(e) {}

        let hardFloor = nowSec; 
        let isPrevBase = false;

        if (itinerary.length > 0) {
            let prevLeg = itinerary[itinerary.length - 1];
            let prevArr = parseInt(prevLeg.arriveUnix, 10);

            hardFloor = prevArr + 60; 
            
            if (
                prevLeg.mode === "EOD_RETURN" ||
                prevLeg.pitstopState === "end_of_day" ||
                prevLeg.pitstopState === "forced" ||
                prevLeg.pitstopState === "handled" ||
                (prevLeg.targetEventId || "").indexOf("_IN") !== -1
            ) {
                isPrevBase = true;
            }

            let pId = prevLeg.targetEventId;
            let pEv = masterArr.find(e => (e.id || "DEFAULT") === pId);

            if (pEv) {
                let isPrevDropin = /(#dropin)/i.test((pEv.title || "") + " " + (pEv.desc || "")) || pEv.isDropin;

                if (isPrevDropin) {
                    let pDropinDur = parseInt(pEv.duration, 10) || 0;
                    let adHocSecs = 0; 
                    let stopRegex = /#stop:(\d+)/gi; 
                    let adHocMatch;

                    while ((adHocMatch = stopRegex.exec(pEv.desc || "")) !== null) {
                        adHocSecs += (parseInt(adHocMatch[1], 10) * 60);
                    }

                    hardFloor = prevArr + pDropinDur + adHocSecs;
                } else {
                    let prevEnd = parseInt(pEv.end, 10);

                    if (pId.indexOf("_IN") !== -1 && pEv.deadline) {
                        prevEnd = parseInt(pEv.deadline, 10);
                    }

                    let depM = (pEv.desc || "").match(/(?:#dep:|#leave:)(\d+)/i);
                    let defDepMins = parseInt(global('Departure_Buffer_Mins'), 10) || 5;
                    let isPDep = /(#leave|#depart)\b/i.test((pEv.title || "") + " " + (pEv.desc || ""));

                    hardFloor = prevEnd + (isPDep ? 0 : (depM ? parseInt(depM[1], 10) : defDepMins) * 60);
                }
            } else if (prevLeg.pitstopState === "forced" || prevLeg.pitstopState === "handled") {
                hardFloor = prevArr + 1800; 
            } else if (prevLeg.mode === "EOD_RETURN" || prevLeg.pitstopState === "end_of_day") {
                hardFloor = prevArr;
            }
        } else {
            if (global('User_At_Base') === "true") {
                isPrevBase = true;
            }
        }
        
        hardFloor = Math.max(nowSec, hardFloor);

        let activeHold = parseInt(global('TDS_Hold_Until'), 10) || 0;
        if (itinerary.length === 0 && activeHold > nowSec) {
            hardFloor = Math.max(hardFloor, activeHold);
        }

        let cLen = pendingChain.length;
        let tailLeg = pendingChain[cLen - 1];

        let arrMatch = tailLeg.targetDesc.match(/#arr:(\d+)/i);
        let defArrMins = parseInt(global('Arrival_Buffer_Mins'), 10) || 5;
        let targetBufferSecs = tailLeg.isDepart ? 0 : (arrMatch ? parseInt(arrMatch[1], 10) : defArrMins) * 60;
        
        if (tailLeg.apiType === "DEPART") {
            tailLeg.depTarget = tailLeg.isDepart 
                ? tailLeg.evStartSecs 
                : (tailLeg.evStartSecs - targetBufferSecs - tailLeg.durationSecs);
        } else {
            tailLeg.depTarget = Math.max(
                vTime, 
                (tailLeg.apiType === "ARRIVE" ? tailLeg.apiUnix - tailLeg.durationSecs : tailLeg.apiUnix)
            );
        }

        for (let i = cLen - 2; i >= 0; i--) {
            let leg = pendingChain[i]; 
            let nextLeg = pendingChain[i + 1];

            let arrTarget = nextLeg.depTarget - leg.dropinDur - leg.stopPadSecs;
            leg.depTarget = arrTarget - leg.durationSecs;
        }

        let headLeg = pendingChain[0];
        let actualHeadDeparture;
        
        let leaveASAP = false;
        if (!isPrevBase || headLeg.actionType === "EOD_RETURN") {
            leaveASAP = true;
        }

        if (leaveASAP || headLeg.apiType === "ACTIVE_TRAVEL") {
            actualHeadDeparture = hardFloor;
        } else {
            actualHeadDeparture = Math.max(hardFloor, headLeg.depTarget);
        }

        let currentUnix = actualHeadDeparture;
        let outTitles = []; 
        let outStarts = []; 
        let outEnds = [];

        let ovrRaw = readFile("Tasker/Tesla/Data/TDS_Overrides.json") || "{}";
        let OVR = {}; 
        try { 
            OVR = JSON.parse(ovrRaw); 
        } catch(e) {}

        let depMemRaw = OVR['Depart_Memory'] || "";
        
        let newDepMem = [];

        if (depMemRaw.length > 2) {
            let parts = depMemRaw.split(",");

            for (let k = 0; k < parts.length; k++) {
                if (!parts[k]) continue;

                let dp = parts[k].split("~");
                let inPending = pendingChain.some(l => l.targetEventId === dp[0]);

                if (!inPending) {
                    newDepMem.push(parts[k]);
                }
            }
        }

        for (let i = 0; i < cLen; i++) {
            let leg = pendingChain[i];

            leg.actualDeparture = currentUnix;
            leg.actualArrival = leg.actualDeparture + leg.durationSecs;
            
            let delta = leg.evStartSecs - (leg.isDepart ? leg.actualDeparture : leg.actualArrival);
            
            if (delta >= 0) {
                leg.actualBuffer = Math.floor(delta / 60);

                if (leg.isDepart) {
                    leg.actualBuffer = 9999; 
                }
            } else {
                leg.actualLate = Math.ceil(Math.abs(delta) / 60);
                leg.actualBuffer = 0;
            }

            currentUnix = leg.actualArrival + (leg.dropinDur || 0) + leg.stopPadSecs;

            newDepMem.push(leg.targetEventId + "~" + leg.actualDeparture);

            if (i === cLen - 1) {
                let oldD = null;

                if (depMemRaw.length > 2) {
                    let parts = depMemRaw.split(",");

                    for (let k = 0; k < parts.length; k++) {
                        let dp = parts[k].split("~");

                        if (dp[0] === leg.targetEventId) {
                            oldD = parseInt(dp[1], 10); 
                            break;
                        }
                    }
                }
                
                let departChanged = "false"; 
                let departDiffMins = 0;
                let apiConflictStr = "";
                let liveLateMins = parseInt(local('block_step12'), 10) || 0;
                let timeGapFromNow = leg.apiUnix - nowSec; 
                
                if (timeGapFromNow <= 64800) {
                    if (oldD !== null && !isNaN(oldD) && oldD !== leg.actualDeparture) {
                        let diffDays = Math.round(
                            (
                                new Date(leg.apiUnix * 1000).setHours(0, 0, 0, 0) -
                                new Date(nowSec * 1000).setHours(0, 0, 0, 0)
                            ) / 86400000
                        );

                        if (
                            diffDays === 1 &&
                            leg.actionType !== "EOD_RETURN" &&
                            leg.actionType !== "EOD"
                        ) {
                            departChanged = "true"; 
                            departDiffMins = Math.round((leg.actualDeparture - oldD) / 60); 
                        }
                    }

                    let ignored = OVR['Ignored_Lateness'] || "";

                    if (
                        liveLateMins > 0 &&
                        ignored.indexOf(leg.targetEventId) === -1 &&
                        leg.actionType === "EVENT" &&
                        leg.apiType !== "ACTIVE_TRAVEL"
                    ) {
                        apiConflictStr = "AUTO_REPLAN|" + leg.targetEventId;
                    }
                }

                setLocal('depart_changed', departChanged); 
                setLocal('depart_diff_mins', departDiffMins.toString());
                setLocal('api_conflict', apiConflictStr); 
                setLocal('live_late_mins', liveLateMins.toString());
            }

            if (leg.apiType === "ACTIVE_TRAVEL" || leg.durationSecs <= 0) {
                outTitles.push("SKIP_CALENDAR");

                // V24.17 update:
                // Use dummy values rather than blanks to protect Tasker Variable Split.
                outStarts.push("IGNORE");
                outEnds.push("IGNORE");
            } else {
                let modeEmoji = "🚗"; 

                if (leg.mode === "WALK") {
                    modeEmoji = "🚶";
                } else if (leg.mode === "TRANSIT") {
                    modeEmoji = "🚆";
                } else if (leg.mode === "LIFT") {
                    modeEmoji = "🚕";
                }

                let finalTitle = leg.isAttachedDropin 
                    ? ("🔄 Drop-in: " + leg.targetTitle) 
                    : (modeEmoji + " to " + leg.targetTitle);

                if (leg.stopPadSecs > 0) {
                    finalTitle += " (+" + leg.stopUiStr + " stop" + 
                        (leg.pendingStopsRaw.indexOf(",") !== -1 ? "s" : "") + ")";
                }

                outTitles.push(finalTitle);
                outStarts.push(String(leg.actualDeparture * 1000));
                outEnds.push(String(leg.actualArrival * 1000));
            }

            itinerary.push({
                targetEventId: leg.targetEventId,
                targetTitle: leg.targetTitle,
                targetDesc: leg.targetDesc,
                targetCoords: leg.targetCoords,
                mode: leg.mode,
                departUnix: leg.actualDeparture,
                arriveUnix: leg.actualArrival,
                durationSecs: leg.durationSecs,
                distanceMiles: leg.distanceMiles,
                pitstopState: leg.pitstopState, 
                latenessMins: leg.actualLate || 0,
                bufferMins: leg.actualBuffer,
                transitStepsRaw: leg.transitStepsRaw,
                holdUntilUnix: activeHold,
                pendingStopsRaw: leg.pendingStopsRaw 
            });
        }
        
        OVR['Depart_Memory'] = newDepMem.join(",");

        try { 
            writeFile("Tasker/Tesla/Data/TDS_Overrides.json", JSON.stringify(OVR), false); 
        } catch(e) {}

        writeFile("Tasker/Tesla/Data/Itin_Master.json", JSON.stringify(itinerary), false);
        
        setLocal('cal_title_out', outTitles.join("|"));
        setLocal('cal_start_out', outStarts.join("|"));
        setLocal('cal_end_out', outEnds.join("|"));
    }

} catch(e) { 
    flash("Unified Engine Crash:\n" + e.message); 
}