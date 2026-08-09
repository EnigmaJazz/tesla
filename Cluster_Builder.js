// Cluster_Builder.js — READ-ONLY adapter.
// Groups consecutive dropin events from Alpha's staged candidates into
// route-optimization clusters and stages the selected cluster in %par1.
//
// Inputs:  %tds_temp_json, %cluster_idx, %raw_base_data, %Home_Coords
// Outputs: %par1, %cluster_count, %cluster_eof, %return_value
//
// No file reads. No file writes. Only stages locals + flash logs.

// IIFE wrapper (repo convention, cf. Gatekeeper/API_Parser): the Tasker runtime
// and the harness vm both reject top-level `return`; the early returns inside
// the try block are legal only inside a function.
(function() {

const BASE_DEST_ID = "BASE";
// Sentinel for "no usable coordinates" — matches the repo's no-magic-values convention.
const UNUSABLE_COORDS = "0,0";

try {

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function isDropin(ev) {
    return ev.isDropin === true
      || /(#dropin)/i.test((ev.title || "") + " " + (ev.desc || ""));
  }

  function flashLog(severity, code, details) {
    let entry = {
      timestamp: Math.floor(Date.now() / 1000),
      generationId: global("TDS_Active_Generation") || null,
      component: "Cluster_Builder",
      severity: severity,
      code: code,
      tripId: null,
      details: details || {}
    };
    flash(JSON.stringify(entry));
  }

  function parseBaseCoords(rawBaseData, homeCoords) {
    if (!rawBaseData || typeof rawBaseData !== "string") {
      return homeCoords || "";
    }
    let entries = rawBaseData.split("|");
    let first = entries[0];
    let fields = first.split("~");
    let coords = fields[2] || "";
    return coords || (homeCoords || "");
  }

  // ------------------------------------------------------------------
  // Parse input events
  // ------------------------------------------------------------------

  let rawEvents = local("tds_temp_json") || "";
  let events;
  try {
    events = JSON.parse(rawEvents);
  } catch (e) {
    flashLog("ERROR", "CLUSTER_BUILDER_FAULT", { message: "Failed to parse %tds_temp_json: " + String(e.message || e) });
    setLocal("par1", "");
    setLocal("cluster_count", "0");
    setLocal("cluster_eof", "true");
    setLocal("return_value", "fault");
    return;
  }

  if (!Array.isArray(events)) {
    flashLog("ERROR", "CLUSTER_BUILDER_FAULT", { message: "%tds_temp_json is not an array" });
    setLocal("par1", "");
    setLocal("cluster_count", "0");
    setLocal("cluster_eof", "true");
    setLocal("return_value", "fault");
    return;
  }

  // ------------------------------------------------------------------
  // Group consecutive dropins
  // ------------------------------------------------------------------

  let groups = []; // each group = { waypoints, skippedIds, prevNonDropin, nextNonDropin }

  let currentGroup = null; // { waypoints: [], skippedIds: [], prevNonDropin: null }
  let lastAnchor = null;   // preceding non-dropin event (the group's origin anchor)

  function flushGroup() {
    if (currentGroup) {
      groups.push({
        waypoints: currentGroup.waypoints,
        skippedIds: currentGroup.skippedIds,
        prevNonDropin: currentGroup.prevNonDropin,
        nextNonDropin: currentGroup.nextNonDropin
      });
    }
    currentGroup = null;
  }

  for (let i = 0; i < events.length; i++) {
    let ev = events[i];
    if (isDropin(ev)) {
      if (!currentGroup) {
        currentGroup = { waypoints: [], skippedIds: [], prevNonDropin: lastAnchor, nextNonDropin: null };
      }
      // Only include waypoints with usable coords
      if (ev.coords && ev.coords !== UNUSABLE_COORDS) {
        let wp = { id: ev.id, coords: ev.coords };
        if (typeof ev.dropinOrder === "number" && ev.dropinOrder > 0) {
          wp.dropinOrder = ev.dropinOrder;
        }
        currentGroup.waypoints.push(wp);
      } else {
        // Dropin with "0,0" coords — record for the skip log; the group stays
        // alive so a later dropin with coords can still join it.
        currentGroup.skippedIds.push(ev.id);
      }
    } else {
      lastAnchor = ev;
      if (currentGroup) {
        currentGroup.nextNonDropin = ev;
        flushGroup();
      }
    }
  }

  // Flush tail group (all-dropin day)
  flushGroup();

  // ------------------------------------------------------------------
  // Resolve destinations and build cluster objects
  // ------------------------------------------------------------------

  let homeCoords = global("Home_Coords") || "";
  let rawBaseData = local("raw_base_data") || "";
  let baseCoords = parseBaseCoords(rawBaseData, homeCoords);

  let clusters = [];
  let clusterLogIndex = 0;

  for (let g = 0; g < groups.length; g++) {
    let group = groups[g];
    clusterLogIndex++;

    let destId;
    let destCoords;

    if (group.nextNonDropin) {
      destId = group.nextNonDropin.id;
      destCoords = group.nextNonDropin.coords;
    } else {
      // Tail group — use base coords
      destId = BASE_DEST_ID;
      destCoords = baseCoords;
    }

    // Validate destination coords
    if (!destCoords || destCoords === UNUSABLE_COORDS) {
      const reason = group.nextNonDropin ? "no_destination_coords" : "no_base_coords";
      flashLog("WARN", "CLUSTER_SKIPPED", {
        index: clusterLogIndex,
        reason: reason
      });
      continue;
    }

    // Explicit origin (judgment-day A1): the preceding non-dropin anchor, or
    // the base for the head group — never the live location. The cluster API
    // optimizes the waypoint order from this origin.
    const originCoords = group.prevNonDropin ? group.prevNonDropin.coords : baseCoords;
    if (!originCoords || originCoords === UNUSABLE_COORDS) {
      flashLog("WARN", "CLUSTER_SKIPPED", {
        index: clusterLogIndex,
        reason: "no_origin_coords"
      });
      continue;
    }

    // Per-event waypoint skips (dropins with unusable coords)
    if (group.skippedIds.length > 0) {
      for (let s = 0; s < group.skippedIds.length; s++) {
        flashLog("WARN", "CLUSTER_SKIPPED", {
          index: clusterLogIndex,
          reason: "no_waypoint_coords",
          eventId: group.skippedIds[s]
        });
      }
    }

    // Validate waypoints
    if (group.waypoints.length === 0) {
      flashLog("WARN", "CLUSTER_SKIPPED", {
        index: clusterLogIndex,
        reason: "no_waypoint_coords"
      });
      continue;
    }

    clusters.push({
      origin: originCoords,
      destination: { id: destId, coords: destCoords },
      waypoints: group.waypoints
    });
  }

  // ------------------------------------------------------------------
  // Stage selected cluster
  // ------------------------------------------------------------------

  let clusterCount = clusters.length;
  let idx = parseInt(local("cluster_idx") || "1", 10);
  if (isNaN(idx) || idx <= 0) idx = 1;

  let par1 = "";
  let clusterEof = "true";

  if (clusterCount > 0 && idx >= 1 && idx <= clusterCount) {
    par1 = JSON.stringify(clusters[idx - 1]);
    clusterEof = "false";

    let c = clusters[idx - 1];
    let wpIds = [];
    for (let w = 0; w < c.waypoints.length; w++) {
      wpIds.push(c.waypoints[w].id);
    }
    flashLog("INFO", "CLUSTER_BUILT", {
      index: idx,
      count: clusterCount,
      destinationId: c.destination.id,
      waypointIds: wpIds,
      waypointCount: c.waypoints.length
    });
  } else {
    par1 = "";
    clusterEof = "true";
  }

  if (clusterCount === 0) {
    flashLog("INFO", "NO_DROPIN_CLUSTERS", {});
  }

  setLocal("par1", par1);
  setLocal("cluster_count", String(clusterCount));
  setLocal("cluster_eof", clusterEof);
  setLocal("return_value", "ok");

} catch (e) {
  // Outer catch — anything unexpected
  try {
    flashLog("ERROR", "CLUSTER_BUILDER_FAULT", { message: String(e.message || e) });
  } catch (_) {
    // Can't even flash — nothing we can do
  }
  setLocal("par1", "");
  setLocal("cluster_count", "0");
  setLocal("cluster_eof", "true");
  setLocal("return_value", "fault");
}

})();
