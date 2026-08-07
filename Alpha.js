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

try {
    let nowSec       = Math.floor(Date.now() / 1000);
    let fetchStartMs = forceMs(global('TIMEMS')); 
    let cutoffMs     = fetchStartMs + 691200000;  

    let mem = {};
    try { mem = JSON.parse(readFile("Tasker/Tesla/Data/TDS_Overrides.json") || "{}"); } catch(e) {}
    let trimmedEventsRaw = mem['Trimmed_Events'] || "";

    // Phase 5 Slice B (REQ-5CACHE-1): Alpha no longer reads or writes the route
    // / temp caches. The temp rollup (keep-until-event + capped-Welford/outlier
    // commit) moved verbatim into Route_Cache_Manager; Alpha stages the
    // ROLLUP_DUE_TEMP command at the end of this pass and embeds the PRUNE
    // payload so the manager re-stages it for the Override Handler (serial
    // owner chain, mirroring the TDS_State_Command re-stage precedent).

    let lastSyncRaw  = (global('Tesla_Last_Sync') || "").trim();
    let lastSyncUnix = parseInt(lastSyncRaw, 10);
    if (isNaN(lastSyncUnix) || lastSyncUnix <= 0) {
        lastSyncUnix = 0; // legacy date-string or empty value forces a one-time migration
    }
    if (!isSameUTCDay(lastSyncUnix, nowSec)) {
        setGlobal('Tesla_Last_Sync', String(utcDayBoundaryUnix(nowSec)));
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

    // D1 (RULE-8C): Alpha no longer writes TDS_Overrides.json — the Override
    // Handler is the sole writer. Alpha stages a PRUNE command so the handler
    // prunes eventOverrides and the global transient memories with today's
    // whitelist. The OVR top-level memory arrays stay as untouched projections;
    // Compiler/Finaliser still read them until Slice E removes those reads.
    // Phase 5 Slice B (REQ-5CACHE-1): the PRUNE payload now travels embedded in
    // the ROLLUP_DUE_TEMP command; Route_Cache_Manager runs the rollup (sole
    // writer of the caches) and re-stages PRUNE for the Override Handler.
    setLocal('par1', 'ROLLUP_DUE_TEMP');
    setLocal('par2', JSON.stringify({ nowSec: nowSec, prune: { nowSec: nowSec, whitelistMap: whitelistMap } }));

    setLocal('tds_temp_json', JSON.stringify(validEvents));
    setLocal('raw_base_data', baseStr);
    setLocal('locs_to_fetch', fetchList.join("^^"));
    setLocal('orphaned_travel_ids', orphanedTravel.join("|"));
    // Phase 2 RULE-8A: Alpha no longer clears the live master files.
    // Generation_Publisher owns all writes to TDS_Master.* and Itin_Master.*.

} catch(e) { 
    flash("Monolithic Alpha Engine Crash:\n" + e.message); 
}
