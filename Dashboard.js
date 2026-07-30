// ==========================================
// V6 DASHBOARD RENDERER (v9.0)
// - Locks pre-flight trip buttons (Pitstop, Drive Instead) to a 2hr window.
// - Keeps active trips visible until physical arrival/completion.
// [V9.0] Fixed Sentry Mode multiplier bug and flexible single-digit regex.
// ==========================================

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
function readActiveGeneration(kind) {
    var m = readJson("Tasker/Tesla/Data/TDS_Run_Manifest.json");
    var key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
    if (m && m.activeGeneration) {
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

try {
    var master = readActiveGeneration("itinerary");

    var total_legs = master.length;
    var lines = []; 
    var idx = 0; 
    
    var rawUnit = global('Range_Unit') || "0.000621371";
    if (rawUnit.indexOf("%") === 0) rawUnit = "0.000621371";
    var isMiles = parseFloat(rawUnit) < 0.001; 
    var sentry_rate_per_hour = isMiles ? 1.0 : 1.6; 
    var defBufMins = parseInt(global('Arrival_Buffer_Mins') || "5", 10);
    
    var hArr = (global('Home_Coords') || "0,0").split(","); 
    var baseData = "";
    try { baseData = readFile("Tasker/Tesla/Data/TDS_Base_Geocodes.txt") || "none"; } catch(e) { baseData = "none"; }

    var uLocRaw = (global('User_Loc') || "0,0").split(",");
    var uLat = parseFloat(uLocRaw[0]) || 0;
    var uLng = parseFloat(uLocRaw[1]) || 0;

    var cLocStr = global('Car_Loc') || hArr.join(",");
    var cLoc = cLocStr.split(",");
    var withCar = (getDist(uLat, uLng, parseFloat(cLoc[0]), parseFloat(cLoc[1])) < 150);
    var currentStatus = global('Current_Status') || "Idle";
    var isCurrentlyCharging = (getDist(uLat, uLng, parseFloat(hArr[0]), parseFloat(hArr[1])) < 150) || /(Charging)/i.test(currentStatus);

    var showTrips = total_legs > 0;
    var now_sec = Math.floor(Date.now() / 1000);
    var daysArr = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    if (showTrips) {
        var firstTripUnix = parseInt(master[0].departUnix || master[0].time || 0);
        var firstTripDate = new Date(firstTripUnix * 1000);
        var firstTripMidnight = new Date(firstTripDate.getFullYear(), firstTripDate.getMonth(), firstTripDate.getDate()).getTime() / 1000;
        
        var isAfter5PM = now_sec >= (firstTripMidnight + 17 * 3600); 

        var day1Str = firstTripDate.toDateString();
        var day2Str = null;
        var day2Count = 0;
        var currentDayStr = "";

        var tmpToday = new Date(now_sec * 1000); 
        tmpToday.setHours(0,0,0,0);
        var todayTimeMs = tmpToday.getTime();
        var lastPrintedTimeMs = 0; 

        for (var i = 0; i < total_legs; i++) { 
            var leg = master[i]; 
            var depUnix = parseInt(leg.departUnix || leg.time || 0);
            var legDate = new Date(depUnix * 1000); 
            var legDayStr = legDate.toDateString();
            
            var mode = leg.mode || "WALK";
            var pitState = leg.pitstopState || leg.pit || "";

            if (legDayStr !== day1Str) {
                if (!day2Str) day2Str = legDayStr;
                if (legDayStr === day2Str) {
                    if (mode !== "EOD_RETURN" && pitState !== "end_of_day" && pitState !== "handled" && pitState !== "forced") {
                        day2Count++;
                    }
                    if (!isAfter5PM && day2Count > 1) continue; 
                } else {
                    continue; 
                }
            }

            var tmpLeg = new Date(legDate.getTime()); 
            tmpLeg.setHours(0,0,0,0);
            var legTimeMs = tmpLeg.getTime();

            if (legDayStr !== currentDayStr) {
                var fillStartMs = (lastPrintedTimeMs === 0) ? todayTimeMs : (lastPrintedTimeMs + 86400000);
                var daysDiff = Math.round((legTimeMs - fillStartMs) / 86400000);
                
                if (daysDiff > 0) {
                    if (daysDiff === 1) {
                        var fd = new Date(fillStartMs);
                        var fDateStr = (fillStartMs === todayTimeMs) ? "Today" : daysArr[fd.getDay()].substring(0,3);
                        lines.push("• [" + fDateStr + "] No trips scheduled");
                    } else {
                        var firstD = new Date(fillStartMs);
                        var lastD = new Date(legTimeMs - 86400000);
                        var fStr1 = (fillStartMs === todayTimeMs) ? "Today" : daysArr[firstD.getDay()].substring(0,3);
                        var fStr2 = daysArr[lastD.getDay()].substring(0,3);
                        lines.push("• [" + fStr1 + "-" + fStr2 + "] No trips scheduled");
                    }
                }
                currentDayStr = legDayStr;
                lastPrintedTimeMs = legTimeMs; 
            }

            var time = legDate.getHours() + ":" + (legDate.getMinutes() < 10 ? '0' : '') + legDate.getMinutes(); 
            var modeStr = mode === "WALK" ? "🚶" : (mode === "TRANSIT" ? "🚆" : (mode === "LIFT" ? "🚕" : "🚗"));
            var warn = (leg.warn && leg.warn !== "none") ? " " + leg.warn : ""; 
            
            var isEOD = (mode === "EOD_RETURN" || pitState === "end_of_day");
            var pit = "";
            if (isEOD) pit = " (End of Day)";
            else if (pitState === "true" || pitState === "forced" || pitState === "handled") pit = " (Pitstop)";
            else if (pitState === "possible") pit = " (Pitstop?)";
            
            var holdUnix = parseInt(leg.holdUntilUnix || 0, 10);
            var holdStr = "";
            if (holdUnix > now_sec) {
                var hDate = new Date(holdUnix * 1000);
                holdStr = " [⏳" + hDate.getHours() + ":" + (hDate.getMinutes() < 10 ? '0' : '') + hDate.getMinutes() + "]";
            }

            var destTitle = leg.targetTitle || leg.loc || "Destination";
            var targetDesc = leg.targetDesc || leg.desc || "";
            
            if (leg.targetEventId && (leg.targetEventId.indexOf("_IN") !== -1 || leg.targetEventId.indexOf("_OUT") !== -1)) {
                destTitle = destTitle.replace(/^(Start:|End:)\s*/i, "");
            }

            let isDropin = /(#dropin)/i.test(targetDesc);
            let dropinUiStr = "";
            
            if (isDropin) {
                modeStr = "🔄";
                destTitle = "Drop-in: " + destTitle;
                
                let arrUnix = parseInt(leg.arriveUnix || 0, 10);
                let boundsStr = [];
                
                // [SURGICAL UPGRADE: Flexible UI Regex]
                let openMatch = targetDesc.match(/#open:(\d{1,2}):?(\d{2})/i);
                if (openMatch) {
                    let oD = new Date(arrUnix * 1000);
                    oD.setHours(parseInt(openMatch[1], 10), parseInt(openMatch[2], 10), 0, 0);
                    let openUnix = Math.floor(oD.getTime() / 1000);
                    if (arrUnix < openUnix + 3600) {
                        boundsStr.push("Opens " + openMatch[1] + ":" + openMatch[2]);
                    }
                }
                
                let closeMatch = targetDesc.match(/#close:(\d{1,2}):?(\d{2})/i);
                if (closeMatch) {
                    let cD = new Date(arrUnix * 1000);
                    cD.setHours(parseInt(closeMatch[1], 10), parseInt(closeMatch[2], 10), 0, 0);
                    let closeUnix = Math.floor(cD.getTime() / 1000);
                    if (arrUnix > closeUnix - 5400) {
                        boundsStr.push("Closes " + closeMatch[1] + ":" + closeMatch[2]);
                    }
                }
                
                if (boundsStr.length > 0) {
                    dropinUiStr += " (" + boundsStr.join(", ") + ")";
                }
                
                if (leg.pendingStopsRaw) {
                    let stopsUi = leg.pendingStopsRaw.split(",").map(function(s) { return s + "m"; }).join(", ");
                    dropinUiStr += " (+" + stopsUi + " stop" + (leg.pendingStopsRaw.indexOf(",") !== -1 ? "s" : "") + ")";
                }
            }

            var prefix = (i === idx) ? "➡️ " : "• "; 
            if (destTitle.indexOf("to next connection") !== -1) prefix = (i === idx) ? "  ➡️ " : "  └ "; 
            
            var dayPrefix = "";
            if (i === 0 || legDayStr !== new Date(parseInt(master[i-1].departUnix || master[i-1].time)*1000).toDateString()) {
                var pName = (legTimeMs === todayTimeMs) ? "Today" : daysArr[legDate.getDay()].substring(0,3);
                dayPrefix = "[" + pName + "] ";
            }
            
            var lateness = parseInt(leg.latenessMins || 0, 10);
            var buffer = parseInt(leg.bufferMins || 0, 10);
            var reqBuf = defBufMins;
            var arrMatch = targetDesc.match(/#arr:(\d+)/i);
            if (arrMatch) reqBuf = parseInt(arrMatch[1], 10);

            var lateStr = "";
            if (!isEOD && !isDropin) {
                if (lateness > 0) lateStr = " (⚠️Late " + lateness + "m)";
                else if (buffer >= 0 && buffer < reqBuf) lateStr = " (⚠️Buf " + buffer + "m)";
            }
            
            var tripLine = prefix + dayPrefix + time + " " + modeStr + warn + holdStr + " to " + destTitle + pit + dropinUiStr + lateStr;
            lines.push(tripLine);
            
            if (i === 0 && mode === "TRANSIT" && leg.transitStepsRaw && leg.transitStepsRaw.indexOf("⚡ Resolved") === -1) {
                var tSteps = leg.transitStepsRaw.trim().split("\n");
                for (var ts = 0; ts < tSteps.length; ts++) {
                    if (tSteps[ts].trim() !== "") lines.push("   " + tSteps[ts].trim());
                }
            }
        }
    }

    var haltState = global('TDS_Lateness_Halt') || "false";
    
    if (haltState === "true") {
        if (lines.length === 0) {
            lines.push("🛑 SIMULATION HALTED: Unresolved lateness issue.");
            lines.push("Please select an option to complete routing.");
        } else {
            lines.unshift("🛑 SIMULATION HALTED: Resolve lateness to continue.");
        }
    } else if (lines.length === 0) {
        lines.push((total_legs > 0 && !showTrips) ? "Next trip is > 24h away" : "No upcoming trips");
    }

    if (lines.length > 9) {
        lines = lines.slice(0, 8);
        lines.push("   ... plus more trips");
    }

    var summary = lines.join("\n");

    // ==========================================
    // SECTION 2: STATIONARY SENTRY PHYSICS ENGINE
    // ==========================================
    var total_drive_meters = 0;
    var total_sentry_secs = 0;

    function isSafeHaven(testCoordsStr, timeSecs) {
        if (!testCoordsStr || testCoordsStr === "0,0") return false;
        var c = testCoordsStr.split(",");
        if (getDist(parseFloat(c[0]), parseFloat(c[1]), parseFloat(hArr[0]), parseFloat(hArr[1])) < 150) return true;

        if (baseData !== "none" && baseData.length > 3) {
            var bases = baseData.split("|");
            for (var k = 0; k < bases.length; k++) {
                if (!bases[k]) continue; var bp = bases[k].split("~");
                // [SURGICAL UPGRADE: Sentry Mode Millisecond Fix]
                // bp is already in seconds. Do not multiply timeSecs by 1000 here.
                if (timeSecs >= parseFloat(bp[0]) && timeSecs <= parseFloat(bp[1])) {
                    var bc = (bp[2] || "0,0").split(",");
                    var isBaseMatch = getDist(parseFloat(c[0]), parseFloat(c[1]), parseFloat(bc[0]), parseFloat(bc[1])) < 150;
                    var hasCharger = bp[3] === "true" || /(#charge|charging)/i.test((bp[4] || "") + " " + (bp[5] || ""));
                    if (isBaseMatch && hasCharger) return true;
                }
            }
        }
        return false;
    }

    var parked_coords = cLocStr;
    var parked_since_sec = now_sec;
    var tracking_battery = true;

    for (var j = 0; j < total_legs; j++) {
        var t = master[j];
        var tDep = parseInt(t.departUnix || t.time || 0);
        var tArr = parseInt(t.arriveUnix || (tDep + (t.durationSecs || 1800)));
        var tMode = t.mode || "WALK";
        var tCoords = t.targetCoords || t.coords || "0,0";
        var tDesc = t.targetDesc || t.desc || "";
        var tTitle = t.targetTitle || t.loc || "";

        if (!tracking_battery) break; 

        if (tMode === "DRIVE" || tMode === "EOD_RETURN") {
            if (tDep > parked_since_sec) {
                if (!isSafeHaven(parked_coords, parked_since_sec)) {
                    total_sentry_secs += (tDep - parked_since_sec);
                }
            }
            var distM = parseFloat(t.dist || (t.distanceMiles ? t.distanceMiles * 1609.34 : 0));
            total_drive_meters += distM;
            parked_coords = tCoords;
            parked_since_sec = tArr;

            if (isSafeHaven(tCoords, tArr) || /(#charge|charging)/i.test(tTitle + " " + tDesc)) {
                tracking_battery = false; 
                break;
            }
        }
    }

    if (tracking_battery && total_legs > 0) {
        if (!isSafeHaven(parked_coords, parked_since_sec)) total_sentry_secs += 21600; 
    }

    var sentry_drain_dist = (total_sentry_secs / 3600) * sentry_rate_per_hour;
    var rawMax = global('Max_Range') || "330";
    if (rawMax.indexOf("%") === 0) rawMax = "330";
    var rawBatt = global('Car_Battery') || "85";
    if (rawBatt.indexOf("%") === 0) rawBatt = "85";

    var needed_distance = (total_drive_meters * parseFloat(rawUnit)) + sentry_drain_dist + 10; 
    var needed_pct = Math.round((needed_distance / parseFloat(rawMax)) * 100); 
    var batt_pct = Math.round(parseFloat(rawBatt)); 

    // ==========================================
    // SECTION 3: EVALUATE DYNAMIC BUTTONS & LOCKSCREEN
    // ==========================================
    var target_time = now_sec;
    var bLabels = []; var bActions = [];
    var nextSyncStr = global('Next_Sync') || "";
    if (nextSyncStr.indexOf("%") === 0) nextSyncStr = ""; 

    var targetBaseCoords = hArr; 
    var targetBaseLabel = "Home";
    if (baseData !== "none" && baseData.length > 3) { 
        var bases = baseData.split("|"); 
        for (var j = 0; j < bases.length; j++) { 
            if (!bases[j]) continue; var bParts = bases[j].split("~"); 
            if (now_sec >= parseFloat(bParts[0]) && now_sec <= parseFloat(bParts[1])) { 
                targetBaseCoords = bParts[2].split(","); targetBaseLabel = bParts[4] || "Base"; break; 
            } 
        } 
    } 

    var distToBase = getDist(uLat, uLng, parseFloat(targetBaseCoords[0]), parseFloat(targetBaseCoords[1]));
    var distToHome = getDist(uLat, uLng, parseFloat(hArr[0]), parseFloat(hArr[1]));

    if (total_legs > 0) {
        var nTrip = master[idx];
        var nDep = parseInt(nTrip.departUnix || nTrip.time || now_sec);
        target_time = nDep;
        
        var nHold = parseInt(nTrip.holdUntilUnix || 0, 10);
        if (nHold > now_sec) {
            var uiDate = new Date(nHold * 1000);
            setLocal('ui_pub_text', "Holding until " + uiDate.getHours() + ":" + (uiDate.getMinutes() < 10 ? '0' : '') + uiDate.getMinutes());
        } else {
            setLocal('ui_pub_text', "Unlock for trip details");
        }
        
        var titleWithSync = currentStatus + (nextSyncStr ? " (Next Sync: " + nextSyncStr + ")" : "");
        setLocal('ui_next_loc', titleWithSync); 
        setLocal('ui_pub_title', currentStatus); 
        
        var nextMode = nTrip.mode;
        var nextPitState = nTrip.pitstopState || nTrip.pit || "";
        var timeToDep = nDep - now_sec;

        if (timeToDep <= 7200) {
            if (timeToDep < 1800) {
                bLabels.push("⏳ Delay..."); bActions.push("TDS_Delay");
            }
            if (withCar && nextMode !== "DRIVE" && bLabels.length < 3) {
                bLabels.push("🚗 Drive Instead"); bActions.push("TDS_Drive");
            }
            if (nextMode === "DRIVE" && nextPitState === "possible" && bLabels.length < 3) {
                bLabels.push("🏠 Add Pitstop"); bActions.push("TDS_Pitstop");
            }
            if (!withCar && (currentStatus.indexOf("Walk") !== -1 || currentStatus.indexOf("Idle") !== -1) && bLabels.length < 3) {
                bLabels.push("📍 Find Car"); bActions.push("TDS_Find");
            }
            if (bLabels.length < 3) {
                bLabels.push("⏱️ Depart Now"); bActions.push("TDS_Depart");
            }
        }
    } else {
        var titleWithSyncIdle = currentStatus + (nextSyncStr ? " (Next Sync: " + nextSyncStr + ")" : "");
        setLocal('ui_next_loc', titleWithSyncIdle); 
        setLocal('ui_pub_title', currentStatus);
        setLocal('ui_pub_text', "Engine Idle");
    }

    if (distToBase > 200 && bLabels.length < 3) {
        var alreadyRoutingBase = false;
        if (total_legs > 0) {
             let ntC = (master[0].targetCoords || master[0].coords || "0,0").split(",");
             if (ntC.length === 2 && getDist(parseFloat(ntC[0]), parseFloat(ntC[1]), parseFloat(targetBaseCoords[0]), parseFloat(targetBaseCoords[1])) < 200) {
                 alreadyRoutingBase = true;
             }
        }

        if (!alreadyRoutingBase) {
            var carDistToTarget = getDist(parseFloat(cLoc[0]), parseFloat(cLoc[1]), parseFloat(targetBaseCoords[0]), parseFloat(targetBaseCoords[1]));
            var carAtTarget = carDistToTarget < 300;
            var carAtHome = getDist(parseFloat(cLoc[0]), parseFloat(cLoc[1]), parseFloat(hArr[0]), parseFloat(hArr[1])) < 300;
            var returningHome = getDist(parseFloat(targetBaseCoords[0]), parseFloat(targetBaseCoords[1]), parseFloat(hArr[0]), parseFloat(hArr[1])) < 300;

            var targetMode = "WALK";
            if (distToBase >= 1500) targetMode = "TRANSIT";
            if (!carAtTarget && (!carAtHome || returningHome)) targetMode = "DRIVE";
            var modeEmoji = targetMode === "DRIVE" ? "🚗" : (targetMode === "TRANSIT" ? "🚆" : "🚶");

            bLabels.push(modeEmoji + " Route " + targetBaseLabel); bActions.push("TDS_Return_Base"); 
            setGlobal('TDS_Return_Coords', targetBaseCoords.join(","));
            setGlobal('TDS_Return_Mode', "AUTO");
            setGlobal('TDS_Return_Name', targetBaseLabel);
        }
    }

    if (distToHome > 200 && targetBaseLabel !== "Home" && bLabels.length < 3) {
        var alreadyRoutingHome = false;
        if (total_legs > 0) {
             let ntC = (master[0].targetCoords || master[0].coords || "0,0").split(",");
             if (ntC.length === 2 && getDist(parseFloat(ntC[0]), parseFloat(ntC[1]), parseFloat(hArr[0]), parseFloat(hArr[1])) < 200) {
                 alreadyRoutingHome = true;
             }
        }
        if (!alreadyRoutingHome) {
            bLabels.push("🏠 Route Home"); bActions.push("TDS_Return_Home"); 
        }
    }

    setLocal('btn_count', String(bLabels.length));
    for(var b = 0; b < 3; b++){
        setLocal('ui_b' + (b+1) + '_l', bLabels[b] || "");
        setLocal('ui_b' + (b+1) + '_a', bActions[b] || "");
    }

    var battAlertBool = (parseFloat(batt_pct) < parseFloat(needed_pct) && !isCurrentlyCharging);
    var battEmoji = "🔋";
    if (isCurrentlyCharging) battEmoji = "🔌";
    else if (battAlertBool) battEmoji = "🪫";
    
    var battText = battEmoji + " Current: " + batt_pct + "% Needed:" + needed_pct + "%";
    summary = summary + "\n" + battText;

    setLocal('ui_batt_current', String(batt_pct));
    setLocal('ui_batt_needed', String(needed_pct));
    setLocal('batt_alert', battAlertBool ? "true" : "false");
    setLocal('ui_is_charging', isCurrentlyCharging ? "true" : "false");
    setLocal('ui_batt_emoji', battEmoji);
    setLocal('ui_target_time', String((target_time * 1000).toFixed(0)));
    setLocal('ui_sub', summary);

    var refreshTriggers = [];
    var midDate = new Date(now_sec * 1000);
    midDate.setDate(midDate.getDate() + 1); 
    midDate.setHours(0,0,0,0);
    refreshTriggers.push(Math.floor(midDate.getTime() / 1000));

    if (total_legs > 0) {
        var nTrip0 = master[0];
        var nDep0 = parseInt(nTrip0.departUnix || nTrip0.time || now_sec);
        refreshTriggers.push(nDep0 - 7200); 
        refreshTriggers.push(nDep0 - 1800); 
        refreshTriggers.push(nDep0);        
        
        var ftD = new Date(nDep0 * 1000);
        ftD.setHours(0,0,0,0);
        var fivePM = Math.floor(ftD.getTime() / 1000) + (17 * 3600);
        if (fivePM > now_sec) refreshTriggers.push(fivePM);
    }

    var nextRefresh = -1;
    for (var r = 0; r < refreshTriggers.length; r++) {
        if (refreshTriggers[r] > now_sec) {
            if (nextRefresh === -1 || refreshTriggers[r] < nextRefresh) {
                nextRefresh = refreshTriggers[r];
            }
        }
    }
    
    if (nextRefresh !== -1) {
        var refD = new Date(nextRefresh * 1000);
        var rHH = ("0" + refD.getHours()).slice(-2);
        var rMM = ("0" + refD.getMinutes()).slice(-2);
        setGlobal('TDS_Next_Dash_Refresh', rHH + "." + rMM);
    }

} catch (err) {
    flash("Dashboard Render Error: " + err.message);
    setLocal('ui_sub', "⚠️ Dashboard Error: " + err.message);
    setLocal('btn_count', "0");
}
