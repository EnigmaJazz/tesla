// TESLA_CONFIG.json (gitignored) overrides device setup; see TESLA_CONFIG.example.json.
// The anchor path Tasker/Tesla/ is the Tasker install root.
var TESLA_CFG = {};
try { TESLA_CFG = JSON.parse(readFile("Tasker/Tesla/TESLA_CONFIG.json") || "{}"); } catch (e) { TESLA_CFG = {}; }
var DATA_ROOT = (TESLA_CFG && typeof TESLA_CFG.dataRoot === "string" && TESLA_CFG.dataRoot) || "Tasker/Tesla/Data/";

// ==========================================
// SMART CACHE GATEKEEPER (V7.1)
// Intercepts JSON Clusters on %par1. 
// Uses isClose for GPS drift caching. Merges Master Sorter logic.
// [V7.0] In-Place Array Sorting to protect Strict Event chronology.
// [V7.1] Slice D (REQ-5CACHE-1/2): reads the route/temp/order caches from
//        the Route Cache Manager's JSON files, read-only. Gatekeeper NEVER
//        writes cache files — the manager is the sole writer (RULE-8E). The
//        legacy RouteCache.txt / Temp_Route_Cache.txt / TDS_Order_Cache.txt
//        projections are retired; expired entries are misses (SCN-5CACHE-3),
//        matching the manager's CACHE_READ filter. Selection rules are
//        byte-identical to V7.0: backward scan for the master/temp tiers,
//        forward scan for order rows, exact mode match, isClose GPS drift,
//        WALK unbucketed, DRIVE exact tod + dayClass within 60 minutes.
// ==========================================

(function() {
    const METERS_PER_MILE = 1609.344; // Slice D: JSON distanceMiles field unit
    const CACHE_MODE_WALK = "WALK";   // route-entry mode constant (manager parity)

    function forceSeconds(val) {
        let v = parseFloat(val); 
        if (isNaN(v) || v <= 0) return 0;
        return Math.floor(v); 
    }

    function safeGet(varName) {
        let v = local(varName);
        if (v === undefined || v === null || String(v) === "undefined" || String(v).indexOf("%") === 0) return "";
        return String(v).trim();
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
        return getDist(parseFloat(pA[0]), parseFloat(pA[1]), parseFloat(pB[0]), parseFloat(pB[1])) <= 200;
    }

    // Remediation (REQ-5CACHE-2 SCN-5CACHE-3, REQ-5LOG-1): the direct readers
    // must reject exactly what the manager's rcmFilterRouteEntries rejects and
    // emit reader-origin CACHE_ENTRY_REJECTED LOG-17 on every drop. No
    // require/import (Tasker standalone isolation) — the filter is duplicated
    // inline per repo convention; Route_Cache_Manager.js remains the SOLE
    // writer of every cache file (this script stays read-only).
    function gkRouteKey(o, d, m, bucket, dayClass) {
        return o + "~~" + d + "~~" + m + "~~" + (bucket === null ? "null" : bucket) + "~~" + dayClass;
    }
    function gkTempKey(o, d, m, apiUnix) {
        return o + "~~" + d + "~~" + m + "~~" + apiUnix;
    }
    function gkRejectCacheEntry(reason, key, extra) {
        flash(JSON.stringify({
            timestamp: Date.now(),
            generationId: global('TDS_Active_Generation') || null,
            component: "Gatekeeper",
            severity: "warn",
            code: "CACHE_ENTRY_REJECTED",
            tripId: null,
            details: Object.assign({ reason: reason, key: key }, extra || {})
        }));
    }

    // Slice D (REQ-5CACHE-1/2): read-only JSON cache accessor. The Route Cache
    // Manager is the SOLE writer of TDS_Route_Cache.json / Temp_Route_Cache.json
    // / TDS_Order_Cache.json; this script only ever reads them (never writes).
    // kind selects the entry contract: "route"/"temp" entries are filtered
    // inline exactly like the manager's rcmFilterRouteEntries/rcmFilterTempEntries
    // (SCN-5CACHE-3) and each drop emits CACHE_ENTRY_REJECTED (REQ-5LOG-1);
    // "order" entries keep the original validation (clusterKey/result is checked
    // by the caller; only expired entries drop here).
    function readCacheJson(path, nowSec, kind) {
        let raw = "";
        try { raw = readFile(path) || ""; } catch (e) { return null; }
        if (!raw) return null;
        try {
            let obj = JSON.parse(raw);
            if (!obj || obj.schemaVersion !== 1 || !obj.entries || typeof obj.entries !== "object") return null;
            let out = {};
            let keys = Object.keys(obj.entries);
            for (let i = 0; i < keys.length; i++) {
                let e = obj.entries[keys[i]];
                if (kind === "order") {
                    if (!e || typeof e !== "object") continue;
                    if (typeof e.expiresAt === "number" && e.expiresAt <= nowSec) continue; // expired = miss
                    out[keys[i]] = e;
                    continue;
                }
                if (kind === "temp") {
                    if (!e || typeof e !== "object") { gkRejectCacheEntry("temp entry not an object", keys[i]); continue; }
                    if (typeof e.originCell !== "string" || typeof e.destinationCell !== "string" || typeof e.mode !== "string"
                        || typeof e.meanDurationSecs !== "number" || !isFinite(e.meanDurationSecs) || typeof e.sampleCount !== "number" || !isFinite(e.sampleCount)
                        || typeof e.m2 !== "number" || !isFinite(e.m2) || typeof e.distanceMiles !== "number" || !isFinite(e.distanceMiles)
                        || typeof e.apiUnix !== "number" || !isFinite(e.apiUnix) || typeof e.targetUnix !== "number" || !isFinite(e.targetUnix)
                        || e.dayClass === undefined || e.bucket === undefined
                        || (e.dayClass !== null && (typeof e.dayClass !== "number" || !isFinite(e.dayClass)))
                        || (e.bucket !== null && (typeof e.bucket !== "number" || !isFinite(e.bucket)))
                        || typeof e.createdAt !== "number" || typeof e.updatedAt !== "number") {
                        gkRejectCacheEntry("temp entry malformed fields", keys[i]); continue;
                    }
                    if (typeof e.expiresAt !== "number" || e.expiresAt <= nowSec) { gkRejectCacheEntry("temp entry expired", keys[i], { expiresAt: e.expiresAt }); continue; }
                    if (!(e.meanDurationSecs > 0)) { gkRejectCacheEntry("temp entry nonpositive duration", keys[i]); continue; }
                    if (gkTempKey(e.originCell, e.destinationCell, e.mode, e.apiUnix) !== keys[i]) { gkRejectCacheEntry("temp key mismatch", keys[i]); continue; }
                    out[keys[i]] = e;
                    continue;
                }
                // route kind: replicate rcmFilterRouteEntries exactly
                if (!e || typeof e !== "object") { gkRejectCacheEntry("route entry not an object", keys[i]); continue; }
                if (typeof e.originCell !== "string" || typeof e.destinationCell !== "string" || typeof e.mode !== "string"
                    || typeof e.meanDurationSecs !== "number" || !isFinite(e.meanDurationSecs) || typeof e.sampleCount !== "number" || !isFinite(e.sampleCount)
                    || typeof e.m2 !== "number" || !isFinite(e.m2) || typeof e.distanceMiles !== "number" || !isFinite(e.distanceMiles)
                    || typeof e.dayClass !== "number" || (e.bucket !== null && typeof e.bucket !== "number") || typeof e.createdAt !== "number" || typeof e.updatedAt !== "number") {
                    gkRejectCacheEntry("route entry malformed fields", keys[i]); continue;
                }
                if (e.mode === CACHE_MODE_WALK && e.bucket !== null) { gkRejectCacheEntry("walk entry must have null bucket", keys[i]); continue; }
                if (e.mode !== CACHE_MODE_WALK && e.bucket === null) { gkRejectCacheEntry("non-walk entry must have numeric bucket", keys[i]); continue; }
                if (typeof e.expiresAt !== "number" || e.expiresAt <= nowSec) { gkRejectCacheEntry("route entry expired", keys[i], { expiresAt: e.expiresAt }); continue; }
                if (!(e.meanDurationSecs > 0)) { gkRejectCacheEntry("route entry nonpositive duration", keys[i]); continue; }
                if (gkRouteKey(e.originCell, e.destinationCell, e.mode, e.bucket, e.dayClass) !== keys[i]) { gkRejectCacheEntry("route key/bucket mismatch", keys[i]); continue; }
                out[keys[i]] = e;
            }
            return { schemaVersion: obj.schemaVersion, entries: out };
        } catch (e) { return null; }
    }

    // [SURGICAL UPGRADE: In-Place Sorting]
    // Phase 4 (REQ-4REORDER-1): producers never write the queue or masters.
    // The Gatekeeper stages an ENQUEUE_REORDER command; TDS_State_Command owns
    // the append and the Generation Publisher drains it.
    function emitReorderCommand(orderedIdsStr, source) {
        const orderedIds = orderedIdsStr.split(",").filter(function (id) { return id; });
        if (orderedIds.length === 0) return;
        setLocal('par1', 'ENQUEUE_REORDER');
        setLocal('par2', JSON.stringify({
            generationId: global('TDS_Active_Generation') || null,
            clusterId: source + "-cluster",
            orderedEventIds: orderedIds,
            source: source,
            emittedAt: Math.floor(Date.now() / 1000)
        }));
    }
    function sortMasterJson(orderedIdsStr) {
        let orderedIds = orderedIdsStr.split(",");
        let masterRaw = readFile(DATA_ROOT + "TDS_Master.json") || "[]";
        let masterArr = JSON.parse(masterRaw);

        let targetIndices = [];
        let clusterMap = {};
        
        for(let i = 0; i < masterArr.length; i++) {
            if (orderedIds.indexOf(masterArr[i].id) !== -1) {
                targetIndices.push(i);
                clusterMap[masterArr[i].id] = masterArr[i];
            }
        }
        
        for(let j = 0; j < orderedIds.length; j++) {
            if (targetIndices[j] !== undefined && clusterMap[orderedIds[j]]) {
                masterArr[targetIndices[j]] = clusterMap[orderedIds[j]];
            }
        }

        // Phase 2 RULE-8A: do not write the live master directly.
        // Emit a typed reorder command for the Generation Publisher to apply.
        emitReorderCommand(orderedIdsStr, 'Gatekeeper');
    }

    try {
        setLocal('cache_hit', 'false'); 
        setLocal('cluster_bypass', 'false');
        
        let rawPar1 = safeGet('par1');
        
        if (rawPar1.indexOf("{") === 0) {
            let cluster = JSON.parse(rawPar1);
            let wp = cluster.waypoints;
            
            let hasForcedOrder = false; let forcedWp = [];
            for (let i = 0; i < wp.length; i++) {
                if (wp[i].dropinOrder !== undefined) hasForcedOrder = true;
                forcedWp.push(wp[i]);
            }
            
            if (hasForcedOrder) {
                forcedWp.sort(function(a, b) {
                    let valA = a.dropinOrder !== undefined ? a.dropinOrder : 999;
                    let valB = b.dropinOrder !== undefined ? b.dropinOrder : 999;
                    return valA - valB;
                });
                let sortedIds = forcedWp.map(function(w) { return w.id; }).join(",");
                sortMasterJson(sortedIds);
                setLocal('cluster_bypass', 'true'); 
                return; 
            }
            
            let uLoc = global('User_Loc') || "0,0";
            let wpIdStr = wp.map(function(w) { return w.id; }).join(",");

            // Slice D (REQ-5CACHE-1): order-cache reads come from the manager's
            // JSON (read-only; the manager is the sole writer). The legacy row
            // shape origin|destination.id|wpIdStr|result is preserved by the
            // JSON clusterKey (first three fields) + result array.
            let orderCache = readCacheJson(DATA_ROOT + "TDS_Order_Cache.json", Math.floor(Date.now() / 1000), "order");
            if (orderCache) {
                let oKeys = Object.keys(orderCache.entries);
                for (let c = 0; c < oKeys.length; c++) {
                    let oe = orderCache.entries[oKeys[c]];
                    if (!oe || typeof oe.clusterKey !== "string" || !Array.isArray(oe.result)) continue;
                    let kp = oe.clusterKey.split("|");
                    if (kp.length === 3 && isClose(kp[0], uLoc) && kp[1] === cluster.destination.id && kp[2] === wpIdStr) {
                        sortMasterJson(oe.result.join(","));
                        setLocal('cluster_bypass', 'true');
                        return; 
                    }
                }
            }
            return; 
        }

        let orig = safeGet('par11'); let dest = safeGet('par12'); let mode = safeGet('par13').toUpperCase() || "DRIVE";

        if (orig !== "" && dest !== "") {
            let nowSec  = Math.floor(Date.now() / 1000);
            let targetSec = forceSeconds(local('par14')) || nowSec;
            let d = new Date(targetSec * 1000);
            let targetTod = (d.getHours() * 60) + d.getMinutes();
            let targetDay = (d.getDay() === 0 || d.getDay() === 6) ? 1 : 0; 
            
            let masterThresh = parseInt(global('Live_Traffic_Threshold'), 10) || 7200;
            let isFuture     = (targetSec - nowSec) > masterThresh;

            if (isFuture || mode === "WALK") {
                let cachedDurSecs = -1, cachedDistM = 0, cacheSource = "";
                // Slice D (REQ-5CACHE-1/2): master-cache reads come from the
                // manager's JSON (read-only; the manager is the sole writer).
                // distanceMiles in the JSON holds actual miles. Expired rows are
                // already dropped by readCacheJson (expired = miss).
                let routeCache = readCacheJson(DATA_ROOT + "TDS_Route_Cache.json", nowSec, "route");
                if (routeCache) {
                    let rKeys = Object.keys(routeCache.entries);
                    for (let i = rKeys.length - 1; i >= 0; i--) {
                        let e = routeCache.entries[rKeys[i]];
                        if (!e || typeof e.meanDurationSecs !== "number" || typeof e.mode !== "string") continue;

                        if (e.mode === mode && isClose(e.originCell, orig) && isClose(e.destinationCell, dest)) {
                            let cTod = (e.bucket === null) ? -999 : e.bucket;
                            let cDay = e.dayClass;

                            if (mode === "WALK" || (isFuture && typeof cTod === "number" && cTod !== -999 && cDay === targetDay)) {
                                let diff = Math.abs(targetTod - cTod);
                                if (diff > 720) diff = 1440 - diff;
                                if (mode === "WALK" || diff <= 60) {
                                    cachedDurSecs = e.meanDurationSecs; cachedDistM = (typeof e.distanceMiles === "number") ? e.distanceMiles : 0; cacheSource = "Master Cache"; 
                                    break;
                                }
                            }
                        }
                    }
                }

                if (cachedDurSecs === -1) {
                    // Slice D: session-cache reads come from the manager's JSON.
                    let tempCache = readCacheJson(DATA_ROOT + "Temp_Route_Cache.json", nowSec, "temp");
                    if (tempCache) {
                        let tKeys = Object.keys(tempCache.entries);
                        for (let t = tKeys.length - 1; t >= 0; t--) {
                            let te = tempCache.entries[tKeys[t]];
                            if (!te || typeof te.meanDurationSecs !== "number" || typeof te.mode !== "string") continue;

                            if (te.mode === mode && isClose(te.originCell, orig) && isClose(te.destinationCell, dest)) {
                                cachedDurSecs = te.meanDurationSecs; cachedDistM = (typeof te.distanceMiles === "number") ? te.distanceMiles : 0; cacheSource = "Session Cache"; 
                                break;
                            }
                        }
                    }
                }

                if (cachedDurSecs !== -1) {
                    setLocal('cache_hit', 'true');
                    setLocal('api_return_json', JSON.stringify({ durationSecs: cachedDurSecs, distanceMeters: Math.round(cachedDistM * METERS_PER_MILE), distanceMiles: cachedDistM.toFixed(1), transitSteps: "⚡ Resolved via " + cacheSource }));
                }
            }
        }
    } catch(err) { flash("Gatekeeper Engine Fault: " + err.message); }
})();
