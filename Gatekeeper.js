// ==========================================
// SMART CACHE GATEKEEPER (V7.0)
// Intercepts JSON Clusters on %par1. 
// Uses isClose for GPS drift caching. Merges Master Sorter logic.
// [V7.0] In-Place Array Sorting to protect Strict Event chronology.
// ==========================================

(function() {
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

    // [SURGICAL UPGRADE: In-Place Sorting]
    function emitReorderCommand(orderedIdsStr, source) {
        const queuePath = "Tasker/Tesla/Data/TDS_Reorder_Commands.json";
        let queue = [];
        try {
            const raw = readFile(queuePath) || "[]";
            queue = JSON.parse(raw);
            if (!Array.isArray(queue)) queue = [];
        } catch (e) { queue = []; }
        const orderedIds = orderedIdsStr.split(",").filter(function (id) { return id; });
        if (orderedIds.length === 0) return;
        queue.push({
            type: "APPLY_CLUSTER_REORDER",
            generationId: global('TDS_Active_Generation') || null,
            clusterId: source + "-cluster",
            orderedEventIds: orderedIds,
            source: source,
            emittedAt: Math.floor(Date.now() / 1000)
        });
        writeFile(queuePath, JSON.stringify(queue), false);
    }
    function sortMasterJson(orderedIdsStr) {
        let orderedIds = orderedIdsStr.split(",");
        let masterRaw = readFile("Tasker/Tesla/Data/TDS_Master.json") || "[]";
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
            
            let orderCacheRaw = "";
            try { orderCacheRaw = readFile("Tasker/Tesla/Data/TDS_Order_Cache.txt") || ""; } catch(e){}
            let cacheRows = orderCacheRaw.split("\n");
            
            for(let c=0; c<cacheRows.length; c++) {
                if(!cacheRows[c]) continue;
                let cp = cacheRows[c].split("|"); 
                if (cp.length === 4 && isClose(cp[0], uLoc) && cp[1] === cluster.destination.id && cp[2] === wpIdStr) {
                    sortMasterJson(cp[3]);
                    setLocal('cluster_bypass', 'true');
                    return; 
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
                let diskRaw = ""; try { diskRaw = readFile("Tasker/Tesla/Data/RouteCache.txt") || ""; } catch(e) {}
                let welford = diskRaw.split("|");

                for (let i = welford.length - 1; i >= 0; i--) {
                    let p = welford[i].split("~");
                    if (p.length < 10) continue;

                    if (p[2].trim() === mode && isClose(p[0], orig) && isClose(p[1], dest)) {
                        let mean = parseInt(p[3], 10);
                        let cTod = parseInt(p[7], 10);
                        let cDay = parseInt(p[8], 10);

                        if (mode === "WALK" || (isFuture && !isNaN(cTod) && cTod !== -999 && cDay === targetDay)) {
                            let diff = Math.abs(targetTod - cTod);
                            if (diff > 720) diff = 1440 - diff;
                            if (mode === "WALK" || diff <= 60) {
                                cachedDurSecs = mean; cachedDistM = parseInt(p[4], 10); cacheSource = "Master Cache"; 
                                break;
                            }
                        }
                    }
                }

                if (cachedDurSecs === -1) {
                    let tempRaw = ""; try { tempRaw = readFile("Tasker/Tesla/Data/Temp_Route_Cache.txt") || ""; } catch(e) {}
                    if (tempRaw !== "") {
                        let tempArr = tempRaw.split("|");
                        for (let t = tempArr.length - 1; t >= 0; t--) {
                            let tp = tempArr[t].split("~");
                            if (tp.length < 7) continue;

                            if (tp[2].trim() === mode && isClose(tp[0], orig) && isClose(tp[1], dest)) {
                                cachedDurSecs = parseInt(tp[3], 10); cachedDistM = parseInt(tp[4], 10); cacheSource = "Session Cache"; 
                                break;
                            }
                        }
                    }
                }

                if (cachedDurSecs !== -1) {
                    setLocal('cache_hit', 'true');
                    setLocal('api_return_json', JSON.stringify({ durationSecs: cachedDurSecs, distanceMeters: cachedDistM, distanceMiles: (cachedDistM * 0.000621371).toFixed(1), transitSteps: "⚡ Resolved via " + cacheSource }));
                }
            }
        }
    } catch(err) { flash("Gatekeeper Engine Fault: " + err.message); }
})();
