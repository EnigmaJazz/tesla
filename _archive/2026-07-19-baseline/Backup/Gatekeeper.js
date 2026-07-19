// ==========================================
// SMART CACHE GATEKEEPER (V6.7 FILE I/O)
// Updates L1/L2 terminology to reflect NVMe storage.
// ==========================================

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

try {
    setLocal('cache_hit', 'false'); 
    let orig = safeGet('par11'); 
    let dest = safeGet('par12'); 
    let mode = safeGet('par13').toUpperCase() || "DRIVE";

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

            let diskRaw = "";
            try { diskRaw = readFile("Tasker/Tesla/Data/RouteCache.txt") || ""; } catch(e) {}
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
                            cachedDurSecs = mean;
                            cachedDistM = parseInt(p[4], 10);
                            cacheSource = "Master Cache"; // Changed from Welford
                            break;
                        }
                    }
                }
            }

            if (cachedDurSecs === -1) {
                let tempRaw = "";
                try { tempRaw = readFile("Tasker/Tesla/Data/Temp_Route_Cache.txt") || ""; } catch(e) {}
                
                if (tempRaw !== "") {
                    let tempArr = tempRaw.split("|");
                    for (let t = tempArr.length - 1; t >= 0; t--) {
                        let tp = tempArr[t].split("~");
                        if (tp.length < 7) continue;

                        if (tp[2].trim() === mode && isClose(tp[0], orig) && isClose(tp[1], dest)) {
                            cachedDurSecs = parseInt(tp[3], 10);
                            cachedDistM = parseInt(tp[4], 10);
                            cacheSource = "Session Cache"; // Changed from RAM
                            break;
                        }
                    }
                }
            }

            if (cachedDurSecs !== -1) {
                setLocal('cache_hit', 'true');
                setLocal('api_return_json', JSON.stringify({ 
                    durationSecs: cachedDurSecs, 
                    distanceMeters: cachedDistM, 
                    distanceMiles: (cachedDistM * 0.000621371).toFixed(1), 
                    transitSteps: "⚡ Resolved via " + cacheSource 
                }));
            }
        }
    }
} catch(err) { flash("Gatekeeper Engine Fault: " + err.message); }
