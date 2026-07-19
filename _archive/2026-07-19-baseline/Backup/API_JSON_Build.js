// ==========================================
// PRE-API PAYLOAD BUILDER (Hardened V3)
// Cures the TRAFFIC_UNAWARE 400 crash via explicit routingPreference enums,
// strictly strips timestamps from pedestrian routes, and forces ISO-8601.
// ==========================================

function getCoord(rawStr, splitIndex) {
    if (!rawStr || rawStr.indexOf("%") === 0) return 0.0;
    var parts = rawStr.split(",");
    var val = parseFloat(parts[splitIndex]);
    return isNaN(val) ? 0.0 : val;
}

try {
    var rawMode = local('par13') || "DRIVE";
    var routeMode = (rawMode === "TRANSIT") ? "TRANSIT" : ((rawMode === "WALK") ? "WALK" : "DRIVE");

    var targetMs = Date.now();
    var inputNum = parseFloat(local('par14'));
    
    if (!isNaN(inputNum) && inputNum > 0) {
        targetMs = (inputNum < 20000000000) ? Math.floor(inputNum * 1000) : Math.floor(inputNum);
    }

    var isoTime = new Date(targetMs).toISOString();

    var body = {
        "origin": {
            "location": {
                "latLng": {
                    "latitude": getCoord(local('par11'), 0),
                    "longitude": getCoord(local('par11'), 1)
                }
            }
        },
        "destination": {
            "location": {
                "latLng": {
                    "latitude": getCoord(local('par12'), 0),
                    "longitude": getCoord(local('par12'), 1)
                }
            }
        },
        "travelMode": routeMode,
        "computeAlternativeRoutes": false
    };

    // ==========================================
    // THE V2 TRAFFIC & TIME FORK
    // ==========================================
    if (routeMode === "DRIVE") {
        body.departureTime = isoTime;
        // The magic key: Tells Google "Yes, look at the live/historical traffic models for this timestamp"
        body.routingPreference = "TRAFFIC_AWARE"; 
    } 
    else if (routeMode === "TRANSIT") {
        if (local('par15') === "ARRIVE") {
            body.arrivalTime = isoTime;
        } else {
            body.departureTime = isoTime;
        }
    }
    // If routeMode === "WALK", we attach zero time properties and zero traffic preferences!

    setLocal('api_request_body', JSON.stringify(body)); 
    setLocal('api_route_mode', routeMode);

} catch(e) {
    flash("Payload Builder JS Crash:\n" + e.message);
}