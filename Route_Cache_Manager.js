// Route_Cache_Manager.js — Phase 5 Slice B (REQ-5CACHE-1/2, RULE-8E).
//
// Sole writer of the four cache resources AND their legacy text projections:
//   TDS_Route_Cache.json          (master Welford cache)  + RouteCache.txt
//   Temp_Route_Cache.json         (session samples)       + Temp_Route_Cache.txt
//   TDS_Order_Cache.json          (cluster orders)        + TDS_Order_Cache.txt
//   TDS_Route_Request_State.json  (latest request correlation; the full
//                                  correlation flow lands in Slice C)
//
// Input is %par1 (exact command name) plus %par2 (JSON object payload), the
// same staged-command contract as TDS_State_Command. Every command is validated
// BEFORE mutation; invalid entries log CACHE_ENTRY_REJECTED (LOG-17) and are
// rejected without file mutation. Successful mutations log ROUTE_CACHE_MUTATED
// and write every touched file with read-back; on a write/read-back failure the
// pre-command snapshots are restored and the command returns ERROR.
//
// Commands:
//   SESSION_CACHE_UPSERT  {origin,destination,mode,durationSecs,distanceMeters,
//                          apiUnix,targetUnix,emittedAt}
//       Append one pending route measurement to Temp_Route_Cache.json.
//   ROLLUP_DUE_TEMP       {nowSec, prune?}
//       Commit due (nowSec >= targetUnix) temp samples into the master cache
//       using Alpha's capped-Welford/outlier rollup, verbatim. An optional
//       `prune` payload is re-staged as the Override Handler's PRUNE command
//       (serial owner chain, mirroring the TDS_State_Command re-stage
//       precedent: owner re-stages the next owner's command).
//   ORDER_CACHE_UPSERT    {clusterKey,orderedEventIds,generationId,source,
//                          emittedAt}
//       Upsert one cluster order; then re-stages ENQUEUE_REORDER for
//       TDS_State_Command (which owns the TDS_Reorder_Commands.json append).
//   REQUEST_STATE_REGISTER {generationId,clusterId,requestId,emittedAt}
//       Record the latest request correlation per cluster (Slice C wires the
//       API builder to this command).
//   CACHE_READ            {kind: "route"|"temp"|"order"|"request"}
//       Read-only accessor; sets cache_read_result. Readers never write.
//   PRUNE                 {nowSec}
//       Drop expired entries across all four caches; also persists legacy text
//       migration (the JSON caches are authoritative).
//
// Migration: on first read of a JSON cache that is absent while the legacy
// text file exists, the text is parsed into the JSON schema (legacy-tolerant:
// short/garbage rows are skipped; nonpositive durations are misses per
// REQ-5CACHE-2). The text files remain as byte-faithful projections so the
// unchanged readers (Gatekeeper, Sandbox) keep selecting identically; Slice D
// retires the text projections.
//
// Top-level identifiers use unique RCM_-prefixed names (var) so the shared
// harness vm context never sees a redeclaration, matching TDS_State_Command.

var RCM_SCHEMA_VERSION = 1;
var RCM_MASTER_TTL_SECS = 30 * 86400;     // CACHE-11 master cache retention
var RCM_TEMP_TTL_SECS = 24 * 3600;        // session samples
var RCM_ORDER_TTL_SECS = 7 * 86400;       // cluster order cache
var RCM_REQUEST_TTL_SECS = 2 * 3600;      // request correlation records
var RCM_WALK = "WALK";
var RCM_WELFORD_CAP = 20;                 // Alpha's capped-Welford n ceiling
var RCM_BUCKET_WINDOW_MINS = 60;          // time-bucket tolerance (minutes)
var RCM_OUTLIER_Z = 2.0;                  // z-score outlier threshold
var RCM_OUTLIER_MIN_DIFF_SECS = 300;      // min |delta| for z-score outliers
var RCM_LEGACY_TOD_UNKNOWN = -999;        // legacy "no bucket" sentinel
var RCM_COMPONENT = "Route_Cache_Manager";
var RCM_ROUTE_JSON = "Tasker/Tesla/Data/TDS_Route_Cache.json";
var RCM_ROUTE_TEXT = "Tasker/Tesla/Data/RouteCache.txt";
var RCM_TEMP_JSON = "Tasker/Tesla/Data/Temp_Route_Cache.json";
var RCM_TEMP_TEXT = "Tasker/Tesla/Data/Temp_Route_Cache.txt";
var RCM_ORDER_JSON = "Tasker/Tesla/Data/TDS_Order_Cache.json";
var RCM_ORDER_TEXT = "Tasker/Tesla/Data/TDS_Order_Cache.txt";
var RCM_REQUEST_JSON = "Tasker/Tesla/Data/TDS_Route_Request_State.json";

function rcmNowSec() { return Math.floor(Date.now() / 1000); }
function rcmLog(severity, code, details) {
  flash(JSON.stringify({ timestamp: Date.now(), generationId: global('TDS_Active_Generation') || null,
    component: RCM_COMPONENT, severity: severity, code: code, tripId: details && details.tripId || null, details: details || {} }));
}
function rcmReadJson(path) {
  const raw = readFile(path) || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function rcmIsObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function rcmIsNonEmptyString(v) { return typeof v === "string" && v.length > 0; }

// Legacy spatial helpers — copied verbatim from Alpha so matching is identical.
function rcmGetDist(lat1, lon1, lat2, lon2) {
  let R = 6371e3; let rLat1 = lat1 * Math.PI / 180; let rLat2 = lat2 * Math.PI / 180;
  let dLat = (lat2 - lat1) * Math.PI / 180; let dLon = (lon2 - lon1) * Math.PI / 180;
  let a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function rcmIsClose(cStrA, cStrB) {
  if (!cStrA || !cStrB || cStrA === "0,0" || cStrB === "0,0") return false;
  let pA = cStrA.split(","), pB = cStrB.split(",");
  if (pA.length !== 2 || pB.length !== 2) return false;
  return rcmGetDist(parseFloat(pA[0]), parseFloat(pA[1]), parseFloat(pB[0]), parseFloat(pB[1])) <= 200;
}

// Snapshot / read-back / restore (same contract as the Override Handler).
function rcmSnapshot(path) {
  const raw = readFile(path);
  return { existed: raw !== null, raw: raw === null ? "" : raw };
}
function rcmWriteWithReadback(path, content) {
  writeFile(path, content);
  if (readFile(path) !== content) {
    rcmLog("error", "GENERATION_VALIDATION_FAILED", { reason: "read-back mismatch", path: path, writer: RCM_COMPONENT });
    throw new Error("READ_BACK_MISMATCH: " + path);
  }
}
function rcmRestore(snap) {
  try {
    if (snap.existed) {
      rcmWriteWithReadback(snap.path, snap.raw);
    } else {
      deleteFile(snap.path);
    }
  } catch (e) {
    rcmLog("error", "GENERATION_VALIDATION_FAILED", { reason: "snapshot restore failed: " + snap.path + ": " + e.message });
  }
}

// --- Exact-key route identity ----------------------------------------------
function rcmRouteKey(o, d, m, bucket, dayClass) {
  return o + "~~" + d + "~~" + m + "~~" + (bucket === null ? "null" : bucket) + "~~" + dayClass;
}
function rcmTempKey(o, d, m, apiUnix) {
  return o + "~~" + d + "~~" + m + "~~" + apiUnix;
}

// --- Legacy text migration (JSON is authoritative after first mutation) -----
function rcmMigrateRouteText(nowSec) {
  const raw = readFile(RCM_ROUTE_TEXT);
  if (!raw || raw.indexOf("%") === 0) return {};
  const rows = raw.split("|");
  const entries = {};
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i].split("~");
    if (p.length < 10 || rows[i].indexOf("~") === -1) continue;
    const mode = p[2];
    const mean = parseFloat(p[3]);
    if (isNaN(mean) || mean <= 0) continue; // nonpositive entries are misses (REQ-5CACHE-2)
    const updatedAt = parseInt(p[5], 10) || nowSec;
    const tod = parseInt(p[7], 10);
    const dayClass = parseInt(p[8], 10);
    const bucket = (mode === RCM_WALK) ? null : tod;
    const key = rcmRouteKey(p[0], p[1], mode, bucket, dayClass);
    entries[key] = {
      originCell: p[0], destinationCell: p[1], mode: mode, dayClass: dayClass,
      bucket: bucket, meanDurationSecs: mean, sampleCount: parseInt(p[9], 10) || 1,
      m2: parseFloat(p[6]) || 0, distanceMiles: parseInt(p[4], 10) || 0,
      createdAt: updatedAt, updatedAt: updatedAt, expiresAt: updatedAt + RCM_MASTER_TTL_SECS,
      targetUnix: null, apiUnix: null
    };
  }
  return entries;
}
function rcmMigrateTempText(nowSec) {
  const raw = readFile(RCM_TEMP_TEXT);
  if (!raw || raw.indexOf("%") === 0) return {};
  const rows = raw.split("|");
  const entries = {};
  for (let i = 0; i < rows.length; i++) {
    const tp = rows[i].split("~");
    if (tp.length < 7 || rows[i].indexOf("~") === -1) continue;
    const o = tp[0] ? tp[0].trim() : "";
    const d = tp[1] ? tp[1].trim() : "";
    const m = tp[2] ? tp[2].trim() : "";
    if (!o || !d || o === "0,0" || d === "0,0") continue;
    const durSec = parseInt(tp[3], 10);
    const distM = parseInt(tp[4], 10);
    const apiUnix = parseInt(tp[5], 10);
    const targetSec = parseInt(tp[6], 10);
    if (isNaN(durSec) || isNaN(distM) || isNaN(apiUnix) || isNaN(targetSec)) continue;
    if (durSec <= 0) continue; // nonpositive durations are misses
    const key = rcmTempKey(o, d, m, apiUnix);
    entries[key] = {
      originCell: o, destinationCell: d, mode: m, dayClass: null, bucket: null,
      meanDurationSecs: durSec, sampleCount: 1, m2: 0, distanceMiles: distM,
      createdAt: apiUnix, updatedAt: apiUnix, expiresAt: apiUnix + RCM_TEMP_TTL_SECS,
      targetUnix: targetSec, apiUnix: apiUnix
    };
  }
  return entries;
}
function rcmMigrateOrderText(nowSec) {
  const raw = readFile(RCM_ORDER_TEXT);
  if (!raw) return {};
  const lines = raw.split("\n");
  const entries = {};
  for (let i = 0; i < lines.length; i++) {
    const cp = lines[i].split("|");
    if (cp.length !== 4) continue;
    const clusterKey = cp[0] + "|" + cp[1] + "|" + cp[2];
    const result = cp[3].split(",").filter(function (id) { return id; });
    if (result.length === 0) continue;
    entries[clusterKey] = { clusterKey: clusterKey, result: result, createdAt: nowSec, updatedAt: nowSec, expiresAt: nowSec + RCM_ORDER_TTL_SECS };
  }
  return entries;
}

// --- Cache readers (JSON authoritative, legacy text fallback) ---------------
function rcmReadRouteCache(nowSec) {
  const obj = rcmReadJson(RCM_ROUTE_JSON);
  if (obj && obj.schemaVersion === RCM_SCHEMA_VERSION && obj.entries) return obj;
  if (obj) rcmLog("warn", "CACHE_ENTRY_REJECTED", { reason: "malformed route cache file", path: RCM_ROUTE_JSON });
  return { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: nowSec, entries: rcmMigrateRouteText(nowSec) };
}
function rcmReadTempCache(nowSec) {
  const obj = rcmReadJson(RCM_TEMP_JSON);
  if (obj && obj.schemaVersion === RCM_SCHEMA_VERSION && obj.entries) return obj;
  if (obj) rcmLog("warn", "CACHE_ENTRY_REJECTED", { reason: "malformed temp cache file", path: RCM_TEMP_JSON });
  return { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: nowSec, entries: rcmMigrateTempText(nowSec) };
}
function rcmReadOrderCache(nowSec) {
  const obj = rcmReadJson(RCM_ORDER_JSON);
  if (obj && obj.schemaVersion === RCM_SCHEMA_VERSION && obj.entries) return obj;
  if (obj) rcmLog("warn", "CACHE_ENTRY_REJECTED", { reason: "malformed order cache file", path: RCM_ORDER_JSON });
  return { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: nowSec, entries: rcmMigrateOrderText(nowSec) };
}
function rcmReadRequestState(nowSec) {
  const obj = rcmReadJson(RCM_REQUEST_JSON);
  if (obj && obj.schemaVersion === RCM_SCHEMA_VERSION && obj.latestByCluster) return obj;
  return { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: nowSec, latestByCluster: {} };
}

// --- Text projections (byte-faithful legacy formats for unchanged readers) --
function rcmProjectRouteText(entries) {
  const keys = Object.keys(entries);
  const lines = [];
  for (let i = 0; i < keys.length; i++) {
    const e = entries[keys[i]];
    // Position 7 (tod) is a dead field for WALK in every reader; the bucket is
    // null in JSON per REQ-5CACHE-2, so the projection writes 0 there.
    const todText = (e.bucket === null) ? "0" : String(e.bucket);
    lines.push(e.originCell + "~" + e.destinationCell + "~" + e.mode + "~" + e.meanDurationSecs + "~" +
      e.distanceMiles + "~" + e.updatedAt + "~" + e.m2 + "~" + todText + "~" + e.dayClass + "~" + e.sampleCount);
  }
  return lines.join("|");
}
function rcmProjectTempText(entries) {
  const keys = Object.keys(entries);
  const lines = [];
  for (let i = 0; i < keys.length; i++) {
    const e = entries[keys[i]];
    lines.push(e.originCell + "~" + e.destinationCell + "~" + e.mode + "~" + e.meanDurationSecs + "~" +
      e.distanceMiles + "~" + e.apiUnix + "~" + e.targetUnix);
  }
  return lines.join("|");
}
function rcmProjectOrderText(entries) {
  const keys = Object.keys(entries);
  const lines = [];
  for (let i = 0; i < keys.length; i++) {
    const e = entries[keys[i]];
    lines.push(e.clusterKey + "|" + e.result.join(","));
  }
  return lines.join("\n");
}

// --- Alpha's capped-Welford/outlier rollup, moved verbatim ------------------
// Legacy route-entry format: o~d~m~mean~dist~updatedSec~m2~tod~dayType~n.
function rcmRollupMeasurement(entries, trip, nowSec) {
  const to = trip.o, td = trip.d, tm = trip.m, finalDur = trip.dur, tUnix = trip.eventUnix;
  const tDate = new Date(tUnix * 1000);
  const tod = tDate.getHours() * 60 + tDate.getMinutes();
  const dayType = (tDate.getDay() === 0 || tDate.getDay() === 6) ? 1 : 0;
  let matchFound = false; let isOutlier = false;
  const zombieTracker = {};
  const keys = Object.keys(entries);
  const updatedEntries = {};
  for (let r = 0; r < keys.length; r++) {
    const key = keys[r];
    const e = entries[key];
    const isSpatialMatch = (e.mode === tm && rcmIsClose(e.originCell, to) && rcmIsClose(e.destinationCell, td));
    if (isSpatialMatch && tm !== RCM_WALK) {
      let diff = Math.abs(tod - e.bucket);
      if (diff > 720) diff = 1440 - diff;
      if (diff <= RCM_BUCKET_WINDOW_MINS && e.bucket !== RCM_LEGACY_TOD_UNKNOWN && e.dayClass === dayType) {
        const zKey = tm + "_" + e.bucket + "_" + e.dayClass;
        if (zombieTracker[zKey]) continue; // legacy: a second same-bucket match is dropped
        zombieTracker[zKey] = true;
        matchFound = true;
        const oldMean = e.meanDurationSecs;
        const oldDist = e.distanceMiles;
        const oldM2 = e.m2;
        let n = e.sampleCount;
        if (isNaN(n) || n < 1) n = 1;
        const sd = (n > 2) ? Math.sqrt(oldM2 / (n - 1)) : Math.max(120, oldMean * 0.15);
        if (n >= 3) {
          const zScore = Math.abs(finalDur - oldMean) / sd;
          isOutlier = (zScore > RCM_OUTLIER_Z && Math.abs(finalDur - oldMean) > RCM_OUTLIER_MIN_DIFF_SECS);
        } else {
          isOutlier = (finalDur > oldMean * 3.0 || finalDur < oldMean * 0.33);
        }
        if (!isOutlier) {
          const newN = Math.min(n + 1, RCM_WELFORD_CAP);
          const delta = finalDur - oldMean;
          const newMean = oldMean + (delta / newN);
          const delta2 = finalDur - newMean;
          const newM2 = oldM2 + (delta * delta2);
          updatedEntries[key] = rcmUpdatedEntry(e, Math.round(newMean), Math.round(newM2), newN, tod, dayType, nowSec);
        } else {
          const shockedN = Math.max(1, Math.floor(n / 2));
          updatedEntries[key] = rcmUpdatedEntry(e, Math.round(oldMean), Math.round(oldM2), shockedN, tod, dayType, nowSec);
        }
        continue;
      }
      // Spatial DRIVE/TRANSIT match outside the time bucket: the legacy rollup
      // culls it from the cache (byte-identical preservation).
      continue;
    }
    updatedEntries[key] = e;
  }
  if (!matchFound && !isOutlier) {
    const newKey = rcmRouteKey(to, td, tm, (tm === RCM_WALK) ? null : tod, dayType);
    updatedEntries[newKey] = {
      originCell: to, destinationCell: td, mode: tm, dayClass: dayType,
      bucket: (tm === RCM_WALK) ? null : tod,
      meanDurationSecs: finalDur, sampleCount: 1, m2: 0,
      distanceMiles: trip.dist || 0, createdAt: nowSec, updatedAt: nowSec,
      expiresAt: nowSec + RCM_MASTER_TTL_SECS, targetUnix: null, apiUnix: null
    };
  }
  return updatedEntries;
}
function rcmUpdatedEntry(e, mean, m2, n, tod, dayType, nowSec) {
  return {
    originCell: e.originCell, destinationCell: e.destinationCell, mode: e.mode,
    dayClass: dayType, bucket: (e.mode === RCM_WALK) ? null : tod,
    meanDurationSecs: mean, sampleCount: n, m2: m2, distanceMiles: e.distanceMiles,
    createdAt: e.createdAt, updatedAt: nowSec, expiresAt: nowSec + RCM_MASTER_TTL_SECS,
    targetUnix: (e.targetUnix === undefined) ? null : e.targetUnix,
    apiUnix: (e.apiUnix === undefined) ? null : e.apiUnix
  };
}

// --- Command handlers --------------------------------------------------------

function rcmHandleSessionUpsert(payload) {
  if (!rcmIsNonEmptyString(payload.origin) || !rcmIsNonEmptyString(payload.destination) || !rcmIsNonEmptyString(payload.mode)) {
    return "invalid origin/destination/mode";
  }
  if (typeof payload.durationSecs !== "number" || isNaN(payload.durationSecs) || !isFinite(payload.durationSecs) || payload.durationSecs <= 0) {
    return "durationSecs must be a positive number"; // nonpositive durations are misses (REQ-5CACHE-2)
  }
  if (typeof payload.distanceMeters !== "number" || isNaN(payload.distanceMeters) || payload.distanceMeters < 0 || payload.distanceMeters > 5000000) {
    return "distanceMeters out of range";
  }
  if (typeof payload.apiUnix !== "number" || typeof payload.targetUnix !== "number") {
    return "apiUnix/targetUnix must be numbers";
  }
  const now = rcmNowSec();
  const temp = rcmReadTempCache(now);
  // TTL: drop expired session samples before appending (CACHE-11, temp 24h).
  const entries = {};
  const tKeys = Object.keys(temp.entries);
  for (let i = 0; i < tKeys.length; i++) {
    const e = temp.entries[tKeys[i]];
    if (e.expiresAt && e.expiresAt < now) continue;
    entries[tKeys[i]] = e;
  }
  const apiUnix = payload.apiUnix;
  const key = rcmTempKey(payload.origin, payload.destination, payload.mode, apiUnix);
  entries[key] = {
    originCell: payload.origin, destinationCell: payload.destination, mode: payload.mode,
    dayClass: null, bucket: null, meanDurationSecs: payload.durationSecs, sampleCount: 1,
    m2: 0, distanceMiles: payload.distanceMeters, createdAt: apiUnix, updatedAt: apiUnix,
    expiresAt: apiUnix + RCM_TEMP_TTL_SECS, targetUnix: payload.targetUnix, apiUnix: apiUnix
  };
  const next = { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, entries: entries };
  const snap = [{ path: RCM_TEMP_JSON, snap: rcmSnapshot(RCM_TEMP_JSON) }, { path: RCM_TEMP_TEXT, snap: rcmSnapshot(RCM_TEMP_TEXT) }];
  try {
    rcmWriteWithReadback(RCM_TEMP_JSON, JSON.stringify(next));
    rcmWriteWithReadback(RCM_TEMP_TEXT, rcmProjectTempText(entries));
  } catch (e) {
    rcmRestore(snap[0].snap); rcmRestore(snap[1].snap);
    throw new Error("SESSION_CACHE_COMMIT_FAILED: " + e.message);
  }
  rcmLog("info", "ROUTE_CACHE_MUTATED", { command: "SESSION_CACHE_UPSERT", routeKey: key, mode: payload.mode, durationSecs: payload.durationSecs });
  return "OK: SESSION_CACHE_UPSERT " + key;
}

function rcmHandleOrderUpsert(payload) {
  if (!rcmIsNonEmptyString(payload.clusterKey)) return "clusterKey must be a non-empty string";
  if (!Array.isArray(payload.orderedEventIds) || payload.orderedEventIds.length === 0) return "orderedEventIds must be a non-empty array";
  for (let i = 0; i < payload.orderedEventIds.length; i++) {
    if (!rcmIsNonEmptyString(payload.orderedEventIds[i])) return "orderedEventIds entries must be non-empty strings";
  }
  if (!rcmIsNonEmptyString(payload.source)) return "source must be a non-empty string";
  if (typeof payload.emittedAt !== "number") return "emittedAt must be a number";
  const now = rcmNowSec();
  const order = rcmReadOrderCache(now);
  const entries = {};
  const oKeys = Object.keys(order.entries);
  for (let i = 0; i < oKeys.length; i++) {
    const e = order.entries[oKeys[i]];
    if (e.expiresAt && e.expiresAt < now) continue; // TTL 7 days
    entries[oKeys[i]] = e;
  }
  entries[payload.clusterKey] = {
    clusterKey: payload.clusterKey, result: payload.orderedEventIds.slice(),
    createdAt: now, updatedAt: now, expiresAt: now + RCM_ORDER_TTL_SECS
  };
  const next = { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, entries: entries };
  const snap = [{ path: RCM_ORDER_JSON, snap: rcmSnapshot(RCM_ORDER_JSON) }, { path: RCM_ORDER_TEXT, snap: rcmSnapshot(RCM_ORDER_TEXT) }];
  try {
    rcmWriteWithReadback(RCM_ORDER_JSON, JSON.stringify(next));
    rcmWriteWithReadback(RCM_ORDER_TEXT, rcmProjectOrderText(entries));
  } catch (e) {
    rcmRestore(snap[0].snap); rcmRestore(snap[1].snap);
    throw new Error("ORDER_CACHE_COMMIT_FAILED: " + e.message);
  }
  rcmLog("info", "ROUTE_CACHE_MUTATED", { command: "ORDER_CACHE_UPSERT", clusterKey: payload.clusterKey, count: payload.orderedEventIds.length });
  // Re-stage the reorder command for TDS_State_Command (owner chain: the
  // manager owns the order cache; the State Command owns the queue append).
  setLocal('par1', 'ENQUEUE_REORDER');
  setLocal('par2', JSON.stringify({
    generationId: payload.generationId === undefined ? null : payload.generationId,
    clusterId: payload.source + "-cluster",
    orderedEventIds: payload.orderedEventIds,
    source: payload.source,
    emittedAt: payload.emittedAt
  }));
  return "OK: ORDER_CACHE_UPSERT " + payload.clusterKey;
}

function rcmHandleRollup(payload) {
  if (typeof payload.nowSec !== "number" || isNaN(payload.nowSec)) return "nowSec must be a number";
  const now = payload.nowSec;
  const temp = rcmReadTempCache(now);
  const tKeys = Object.keys(temp.entries);
  if (tKeys.length === 0) {
    // Legacy gate: an empty (or %-prefixed) temp cache performs no work.
    if (payload.prune && rcmIsObject(payload.prune)) {
      setLocal('par1', 'PRUNE');
      setLocal('par2', JSON.stringify(payload.prune));
    }
    return "OK: ROLLUP_DUE_TEMP (nothing due)";
  }
  // Split due / keep; drop malformed or TTL-expired samples (legacy-tolerant).
  const keep = {};
  const latest = {};
  const order = [];
  for (let i = 0; i < tKeys.length; i++) {
    const key = tKeys[i];
    const e = temp.entries[key];
    const o = e.originCell, d = e.destinationCell, m = e.mode;
    const durSec = e.meanDurationSecs, distM = e.distanceMiles, apiUnix = e.apiUnix, targetSec = e.targetUnix;
    if (!o || !d || o === "0,0" || d === "0,0") continue;
    if (isNaN(durSec) || isNaN(distM) || isNaN(apiUnix) || isNaN(targetSec)) continue;
    if (distM > 3000000 || distM > 10000000) continue; // legacy-verbatim double check
    const rkey = o + "~~" + d + "~~" + m;
    if (now >= targetSec) {
      if (!latest[rkey] || latest[rkey].apiUnix < apiUnix) {
        latest[rkey] = { o: o, d: d, m: m, dur: durSec, dist: distM, apiUnix: apiUnix, eventUnix: targetSec };
        if (order.indexOf(rkey) === -1) order.push(rkey);
      }
    } else if (e.expiresAt && e.expiresAt < now) {
      continue; // session sample TTL expired before its event (CACHE-11)
    } else {
      keep[key] = e;
    }
  }
  const nextTemp = { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, entries: keep };
  let routeCache = rcmReadRouteCache(now);
  // Master TTL prune before applying new measurements (CACHE-11, 30 days).
  const routeKeys = Object.keys(routeCache.entries);
  const prunedRoute = {};
  for (let i = 0; i < routeKeys.length; i++) {
    const e = routeCache.entries[routeKeys[i]];
    if (e.expiresAt && e.expiresAt < now) continue;
    prunedRoute[routeKeys[i]] = e;
  }
  routeCache.entries = prunedRoute;
  const commits = [];
  for (let c = 0; c < order.length; c++) {
    const trip = latest[order[c]];
    routeCache.entries = rcmRollupMeasurement(routeCache.entries, trip, now);
    commits.push(trip);
  }
  const nextRoute = { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, entries: routeCache.entries };
  const snaps = [
    { path: RCM_TEMP_JSON, snap: rcmSnapshot(RCM_TEMP_JSON) },
    { path: RCM_TEMP_TEXT, snap: rcmSnapshot(RCM_TEMP_TEXT) },
    { path: RCM_ROUTE_JSON, snap: rcmSnapshot(RCM_ROUTE_JSON) },
    { path: RCM_ROUTE_TEXT, snap: rcmSnapshot(RCM_ROUTE_TEXT) }
  ];
  try {
    rcmWriteWithReadback(RCM_TEMP_JSON, JSON.stringify(nextTemp));
    rcmWriteWithReadback(RCM_TEMP_TEXT, rcmProjectTempText(keep));
    if (commits.length > 0) {
      rcmWriteWithReadback(RCM_ROUTE_JSON, JSON.stringify(nextRoute));
      rcmWriteWithReadback(RCM_ROUTE_TEXT, rcmProjectRouteText(routeCache.entries));
    }
  } catch (e) {
    for (let s = 0; s < snaps.length; s++) rcmRestore(snaps[s].snap);
    throw new Error("ROLLUP_COMMIT_FAILED: " + e.message);
  }
  for (let c = 0; c < commits.length; c++) {
    rcmLog("info", "ROUTE_CACHE_MUTATED", { command: "ROLLUP_DUE_TEMP", routeKey: commits[c].o + "~~" + commits[c].d + "~~" + commits[c].m, mode: commits[c].m, durationSecs: commits[c].dur });
  }
  // Owner chain: Alpha's embedded PRUNE payload runs next in the serial task.
  if (payload.prune && rcmIsObject(payload.prune)) {
    setLocal('par1', 'PRUNE');
    setLocal('par2', JSON.stringify(payload.prune));
  }
  return "OK: ROLLUP_DUE_TEMP committed=" + commits.length + " kept=" + Object.keys(keep).length;
}

function rcmHandleRegister(payload) {
  if (!rcmIsNonEmptyString(payload.clusterId) || !rcmIsNonEmptyString(payload.requestId)) {
    return "clusterId/requestId must be non-empty strings";
  }
  if (typeof payload.emittedAt !== "number") return "emittedAt must be a number";
  const now = rcmNowSec();
  const state = rcmReadRequestState(now);
  const latestByCluster = {};
  const sKeys = Object.keys(state.latestByCluster);
  for (let i = 0; i < sKeys.length; i++) {
    const rec = state.latestByCluster[sKeys[i]];
    if (rec.emittedAt && rec.emittedAt < now - RCM_REQUEST_TTL_SECS) continue; // TTL 2h
    latestByCluster[sKeys[i]] = rec;
  }
  latestByCluster[payload.clusterId] = {
    generationId: payload.generationId === undefined ? null : payload.generationId,
    clusterId: payload.clusterId, requestId: payload.requestId, emittedAt: payload.emittedAt
  };
  const next = { schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, latestByCluster: latestByCluster };
  const snap = rcmSnapshot(RCM_REQUEST_JSON);
  try {
    rcmWriteWithReadback(RCM_REQUEST_JSON, JSON.stringify(next));
  } catch (e) {
    rcmRestore(snap);
    throw new Error("REQUEST_STATE_COMMIT_FAILED: " + e.message);
  }
  rcmLog("info", "ROUTE_REQUEST_REGISTERED", { clusterId: payload.clusterId, requestId: payload.requestId });
  return "OK: REQUEST_STATE_REGISTER " + payload.clusterId;
}

function rcmHandleRead(payload) {
  const now = rcmNowSec();
  let cache = null;
  if (payload.kind === "route") cache = rcmReadRouteCache(now);
  else if (payload.kind === "temp") cache = rcmReadTempCache(now);
  else if (payload.kind === "order") cache = rcmReadOrderCache(now);
  else if (payload.kind === "request") cache = rcmReadRequestState(now);
  else return "unknown kind: " + payload.kind;
  setLocal('cache_read_result', JSON.stringify(cache));
  return "OK: CACHE_READ " + payload.kind;
}

function rcmHandlePrune(payload) {
  if (typeof payload.nowSec !== "number" || isNaN(payload.nowSec)) return "nowSec must be a number";
  const now = payload.nowSec;
  const route = rcmReadRouteCache(now);
  const temp = rcmReadTempCache(now);
  const order = rcmReadOrderCache(now);
  const state = rcmReadRequestState(now);
  let prunedRoute = 0, prunedTemp = 0, prunedOrder = 0, prunedRequest = 0;
  const routeEntries = {};
  Object.keys(route.entries).forEach(function (k) {
    if (route.entries[k].expiresAt && route.entries[k].expiresAt < now) { prunedRoute++; return; }
    routeEntries[k] = route.entries[k];
  });
  const tempEntries = {};
  Object.keys(temp.entries).forEach(function (k) {
    if (temp.entries[k].expiresAt && temp.entries[k].expiresAt < now) { prunedTemp++; return; }
    tempEntries[k] = temp.entries[k];
  });
  const orderEntries = {};
  Object.keys(order.entries).forEach(function (k) {
    if (order.entries[k].expiresAt && order.entries[k].expiresAt < now) { prunedOrder++; return; }
    orderEntries[k] = order.entries[k];
  });
  const latestByCluster = {};
  Object.keys(state.latestByCluster).forEach(function (k) {
    const rec = state.latestByCluster[k];
    if (rec.emittedAt && rec.emittedAt < now - RCM_REQUEST_TTL_SECS) { prunedRequest++; return; }
    latestByCluster[k] = rec;
  });
  const snaps = [
    { path: RCM_ROUTE_JSON, snap: rcmSnapshot(RCM_ROUTE_JSON) }, { path: RCM_ROUTE_TEXT, snap: rcmSnapshot(RCM_ROUTE_TEXT) },
    { path: RCM_TEMP_JSON, snap: rcmSnapshot(RCM_TEMP_JSON) }, { path: RCM_TEMP_TEXT, snap: rcmSnapshot(RCM_TEMP_TEXT) },
    { path: RCM_ORDER_JSON, snap: rcmSnapshot(RCM_ORDER_JSON) }, { path: RCM_ORDER_TEXT, snap: rcmSnapshot(RCM_ORDER_TEXT) },
    { path: RCM_REQUEST_JSON, snap: rcmSnapshot(RCM_REQUEST_JSON) }
  ];
  try {
    rcmWriteWithReadback(RCM_ROUTE_JSON, JSON.stringify({ schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, entries: routeEntries }));
    rcmWriteWithReadback(RCM_ROUTE_TEXT, rcmProjectRouteText(routeEntries));
    rcmWriteWithReadback(RCM_TEMP_JSON, JSON.stringify({ schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, entries: tempEntries }));
    rcmWriteWithReadback(RCM_TEMP_TEXT, rcmProjectTempText(tempEntries));
    rcmWriteWithReadback(RCM_ORDER_JSON, JSON.stringify({ schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, entries: orderEntries }));
    rcmWriteWithReadback(RCM_ORDER_TEXT, rcmProjectOrderText(orderEntries));
    rcmWriteWithReadback(RCM_REQUEST_JSON, JSON.stringify({ schemaVersion: RCM_SCHEMA_VERSION, updatedAt: now, latestByCluster: latestByCluster }));
  } catch (e) {
    for (let s = 0; s < snaps.length; s++) rcmRestore(snaps[s].snap);
    throw new Error("PRUNE_COMMIT_FAILED: " + e.message);
  }
  rcmLog("info", "ROUTE_CACHE_MUTATED", { command: "PRUNE", prunedRoute: prunedRoute, prunedTemp: prunedTemp, prunedOrder: prunedOrder, prunedRequest: prunedRequest });
  return "OK: PRUNE route=" + prunedRoute + " temp=" + prunedTemp + " order=" + prunedOrder + " request=" + prunedRequest;
}

// --- Shell -------------------------------------------------------------------

var RCM_COMMAND = local("par1") || "";
var RCM_PAYLOAD_RAW = local("par2") || "";
var RCM_PAYLOAD = null;
try { RCM_PAYLOAD = RCM_PAYLOAD_RAW ? JSON.parse(RCM_PAYLOAD_RAW) : null; } catch (e) { RCM_PAYLOAD = null; }

if (!RCM_COMMAND) {
  rcmLog("warn", "CACHE_ENTRY_REJECTED", { command: "", reason: "missing command" });
  setLocal('return_value', "ERROR: missing command");
} else if (RCM_PAYLOAD === null || !rcmIsObject(RCM_PAYLOAD)) {
  rcmLog("warn", "CACHE_ENTRY_REJECTED", { command: RCM_COMMAND, reason: "invalid JSON payload" });
  setLocal('return_value', "ERROR: invalid JSON payload");
} else {
  let result = null;
  if (RCM_COMMAND === "SESSION_CACHE_UPSERT") result = rcmHandleSessionUpsert(RCM_PAYLOAD);
  else if (RCM_COMMAND === "ORDER_CACHE_UPSERT") result = rcmHandleOrderUpsert(RCM_PAYLOAD);
  else if (RCM_COMMAND === "ROLLUP_DUE_TEMP") result = rcmHandleRollup(RCM_PAYLOAD);
  else if (RCM_COMMAND === "REQUEST_STATE_REGISTER") result = rcmHandleRegister(RCM_PAYLOAD);
  else if (RCM_COMMAND === "CACHE_READ") result = rcmHandleRead(RCM_PAYLOAD);
  else if (RCM_COMMAND === "PRUNE") result = rcmHandlePrune(RCM_PAYLOAD);
  else result = "unknown command: " + RCM_COMMAND;
  if (result === null || result.indexOf("ERROR") === 0 || result.indexOf("invalid") === 0 || result.indexOf("unknown") === 0 || result.indexOf("must") === 0) {
    rcmLog("warn", "CACHE_ENTRY_REJECTED", { command: RCM_COMMAND, reason: result });
    setLocal('return_value', "ERROR: " + result);
  } else {
    setLocal('return_value', result);
  }
}
