// ==========================================
// API RESULT PARSER (TCS-7 V12.7)
// Extracts optimizedWaypoint routing for Cluster arrays.
// [V12.7] Safe array insertion and null-safe transit time parsing.
// ==========================================

(function() {
    function forceSeconds(val) {
        let v = parseFloat(val); 
        if (isNaN(v) || v < 0) return 0; 
        return Math.floor(v); 
    }

    // Phase 5 Slice C (REQ-5REQID-1/2, REQ-5LOG-1): correlation helpers.
    function logEvt(code, severity, details) {
        flash(JSON.stringify({ timestamp: Date.now(), generationId: global('TDS_Active_Generation') || null,
            component: "API_Parser", severity: severity, code: code, tripId: null, details: details || {} }));
    }

    // Request state is manager-owned (documented read-only schema); the parser
    // only reads it for exact correlation and never writes it.
    function readLatestByCluster() {
        let rawState = readFile("Tasker/Tesla/Data/TDS_Route_Request_State.json");
        if (!rawState) return null;
        try {
            let st = JSON.parse(rawState);
            if (st && st.schemaVersion === 1 && st.latestByCluster) return st.latestByCluster;
        } catch (e) {}
        return null;
    }

    // Exact correlation (REQ-5REQID-2): generation MUST equal the active
    // generation AND the latest-by-cluster record MUST match generation +
    // requestId exactly. Superseded (older) requestIds, unknown clusters, and
    // callbacks carrying NO correlation are stale. Post-migration every
    // callback MUST carry the staged correlation envelope; an absent or
    // malformed one is discarded (never falls back to local staging state).
    function correlationOk(correlation) {
        if (!correlation) return false;
        let activeGen = global('TDS_Active_Generation') || null;
        let corrGen = correlation.generationId || null;
        if (corrGen !== activeGen) return false;
        if (typeof correlation.clusterId !== "string" || correlation.clusterId.length === 0) return false;
        if (typeof correlation.requestId !== "string" || correlation.requestId.length === 0) return false;
        let latest = readLatestByCluster();
        let rec = latest ? latest[correlation.clusterId] : null;
        if (!rec) return false;
        if (rec.requestId !== correlation.requestId) return false;
        if ((rec.generationId || null) !== corrGen) return false;
        return true;
    }

    try {
        let rawPayload = readFile("Tasker/Tesla/Data/temp_payload.json");
        if (!rawPayload || rawPayload.indexOf("{") === -1) throw new Error("Missing or empty disk staging payload.");

        let staged = JSON.parse(rawPayload);
        let correlation = null;
        let res = staged;
        if (staged && typeof staged === "object" && !Array.isArray(staged) && staged.correlation && typeof staged.correlation === "object"
            && staged.response && typeof staged.response === "object" && !Array.isArray(staged.response)) {
            // Callback envelope {correlation, response} retained by staging
            // (post-migration the builder ALWAYS stages this envelope). The
            // response member MUST be an object (routes/legs payload) — a
            // truthy string/array response is stale, never accepted.
            correlation = staged.correlation;
            res = staged.response;
        } else {
            // Anything else — raw {routes:[...]}, malformed envelope, non-object
            // response, or a response without a valid correlation — is stale.
            // There is NO local-correlation fallback: correlation must travel
            // WITH the callback (REQ-5REQID-2/3).
            correlation = null;
            if (staged && typeof staged === "object" && !Array.isArray(staged) && typeof staged.response === "object" && !Array.isArray(staged.response)) res = staged.response;
        }

        if (!correlationOk(correlation)) {
            logEvt("STALE_API_RESPONSE_DISCARDED", "warn", { reason: "correlation mismatch", correlation: correlation || null });
            setLocal('par1', '');
            setLocal('par2', '');
            writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);
            return; // REQ-5REQID-2: no cache/reorder mutation on mismatch.
        }
        if (correlation) logEvt("ROUTE_RESPONSE_ACCEPTED", "info", { clusterId: correlation.clusterId, requestId: correlation.requestId });
        // REQ-5REQID-3: consume the accepted request so a replay of this
        // callback is stale. Mid-chain rule: par1/par2 MUST stay the staged
        // cache command, so the consume is staged into dedicated locals
        // (tds_consume_par1/par2) that the serial router consumes AFTER the
        // cache manager; the harness shim delivers directly.
        if (correlation) {
            // Mid-chain rule: save par1/par2 before the shim delivery (the
            // cacheManager shim sets par1/par2 to the staged consume entry),
            // then restore so the cache command stays staged.
            const savedP1 = local('par1');
            const savedP2 = local('par2');
            setLocal('tds_consume_par1', 'REQUEST_STATE_CONSUME');
            setLocal('tds_consume_par2', JSON.stringify({ clusterId: correlation.clusterId, requestId: correlation.requestId }));
            if (typeof cacheManager === "function") {
                cacheManager("REQUEST_STATE_CONSUME", { clusterId: correlation.clusterId, requestId: correlation.requestId });
            }
            setLocal('par1', savedP1);
            setLocal('par2', savedP2);
        }
        
        if (local('api_route_mode') === "CLUSTER") {
            let clusterRaw = local('api_cluster_json') || local('par1');
            let cluster = JSON.parse(clusterRaw);
            let uLoc = global('User_Loc') || "0,0";
            let wpIdStr = cluster.waypoints.map(function(w){ return w.id; }).join(",");

            let orderedIds = [];
            
            if (res.routes && res.routes.length > 0 && res.routes[0].optimizedIntermediateWaypointIndex) {
                let optIndexes = res.routes[0].optimizedIntermediateWaypointIndex;
                for (let x = 0; x < optIndexes.length; x++) orderedIds.push(cluster.waypoints[optIndexes[x]].id);
            } else {
                for (let k = 0; k < cluster.waypoints.length; k++) orderedIds.push(cluster.waypoints[k].id);
            }
            
            let finalOrderStr = orderedIds.join(",");
            // Phase 5 Slice B (REQ-5CACHE-1): API Parser never writes the order
            // cache directly. It stages ORDER_CACHE_UPSERT; Route_Cache_Manager
            // owns TDS_Order_Cache.json/.txt and re-stages ENQUEUE_REORDER for
            // TDS_State_Command (which owns the TDS_Reorder_Commands.json append).
            setLocal('par1', 'ORDER_CACHE_UPSERT');
            setLocal('par2', JSON.stringify({
                clusterKey: uLoc + "|" + cluster.destination.id + "|" + wpIdStr,
                orderedEventIds: orderedIds,
                generationId: global('TDS_Active_Generation') || null,
                source: 'API_Parser',
                emittedAt: Math.floor(Date.now() / 1000)
            }));
            writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);
            return;
        }

        let dur = 0; let distM = 0; let stepsStr = "";
        
        if (res.routes && res.routes.length > 0) {
            let route = res.routes[0];
            let leg = (route.legs && route.legs.length > 0) ? route.legs[0] : {};

            let rawDurStr = String(route.duration || leg.staticDuration || "0s");
            dur = parseInt(rawDurStr.replace('s', ''), 10); 
            distM = parseInt(route.distanceMeters || leg.distanceMeters || 0, 10);
            
            if (local('api_route_mode') === "TRANSIT" && leg.steps && leg.steps.length > 0) {
                let steps = leg.steps;
                for (let s = 0; s < steps.length; s++) {
                    if (steps[s].transitDetails) {
                        let td = steps[s].transitDetails;
                        // [SURGICAL UPGRADE: Null-safe Transit Parsing]
                        let dt = td.stopDetails.departureTime ? new Date(td.stopDetails.departureTime) : new Date();
                        let hrs = ("0" + dt.getHours()).slice(-2);
                        let mins = ("0" + dt.getMinutes()).slice(-2);
                        let lineName = td.transitLine.nameShort || td.transitLine.name || "Transit";
                        let stopName = td.stopDetails.arrivalStop ? td.stopDetails.arrivalStop.name : "Destination";
                        stepsStr += "  • [" + hrs + ":" + mins + "] " + lineName + " to " + stopName + "\n";
                    } else if (steps[s].navigationInstruction && steps[s].navigationInstruction.instructions) {
                        stepsStr += "  • (Walk) " + steps[s].navigationInstruction.instructions + "\n";
                    }
                }
            }
        }
        
        if (isNaN(dur) || dur < 0 || isNaN(distM) || distM < 0 || distM > 5000000) {
            flash("⚠️ API Parser Fault: Invalid metrics.");
            let mockFallback = JSON.stringify({ durationSecs: 0, distanceMeters: 0, distanceMiles: "0", transitSteps: "" });
            setLocal('api_return_json', mockFallback);
            writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);
            return; 
        }

        let resultObj = { durationSecs: dur, distanceMeters: distM, distanceMiles: (distM / 1609.34).toFixed(1), transitSteps: stepsStr.length > 0 ? ("\n" + stepsStr) : "" };
        setLocal('api_return_json', JSON.stringify(resultObj));
        
        let nowSec = Math.floor(Date.now() / 1000);
        let targetSec = forceSeconds(local('par14')) || nowSec;
        let origParam = (local('par11') || "").trim(); let destParam = (local('par12') || "").trim(); let modeParam = (local('par13') || "DRIVE").trim().toUpperCase();

        if (origParam && destParam) {
            // Phase 5 Slice B (REQ-5CACHE-1): the session sample is staged;
            // Route_Cache_Manager owns Temp_Route_Cache.json/.txt.
            setLocal('par1', 'SESSION_CACHE_UPSERT');
            setLocal('par2', JSON.stringify({
                origin: origParam, destination: destParam, mode: modeParam,
                durationSecs: dur, distanceMeters: distM,
                apiUnix: nowSec, targetUnix: targetSec, emittedAt: nowSec
            }));
        }

        writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false);

    } catch(e) {
        flash("API Result Parser Exception. \n" + e.message);
        let mockFallback = JSON.stringify({ durationSecs: 0, distanceMeters: 0, distanceMiles: "0", transitSteps: "" });
        setLocal('api_return_json', mockFallback);
        try { writeFile("Tasker/Tesla/Data/temp_payload.json", "{}", false); } catch(err){}
        return; 
    }
})();
