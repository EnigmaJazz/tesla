// TDS_Helper — read-only manifest resolver (REQ-4HELPER-1).
// par1 = readOrigin | readActiveGeneration[:events|master|itinerary] returns
// the active committed resource (prior/legacy fallback). Generic getters
// (legacy Filename:Index:Key form), setters, and unknown operations are
// rejected with HELPER_REQUEST_REJECTED; this script never writes.

const PHASE2_MANIFEST_PATH = "Tasker/Tesla/Data/TDS_Run_Manifest.json";
const PHASE2_DATA_DIR = "Tasker/Tesla/Data/";

function encodeGen(g) { return String(g).replace(/:/g, "_"); }
function pathFor(g, kind) {
  return PHASE2_DATA_DIR + (kind === "events" ? "TDS_Events." : kind === "master" ? "TDS_Master." : "Itin_Master.") + encodeGen(g) + ".json";
}
function readJson(path) {
  const raw = readFile(path) || "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Phase 3 PR-E: Canonical active-generation reader. Consumers (Compiler,
// Dispatcher, Dashboard, Sandbox_Engine) keep a local copy for Tasker
// standalone-script isolation, but the algorithm is defined here as the
// single source of truth. Future phases may invoke TDS_Helper via par1 and
// read a cached global instead of duplicating the logic.
function readActiveGeneration(kind) {
  const m = readJson(PHASE2_MANIFEST_PATH);
  const key = kind === "events" ? "eventsPath" : kind === "master" ? "masterPath" : "itineraryPath";
  if (m && m.state === "committed" && m.activeGeneration) {
    const data = readJson(m[key] || pathFor(m.activeGeneration, kind));
    if (data !== null) return data;
  }
  if (m && m.previousGeneration) {
    const data = readJson(pathFor(m.previousGeneration, kind));
    if (data !== null) return data;
  }
  if (kind === "events" || kind === "master") {
    const legacy = readJson(PHASE2_DATA_DIR + "TDS_Master.json");
    if (legacy !== null) return legacy;
  }
  if (kind === "itinerary") {
    const legacyItin = readJson(PHASE2_DATA_DIR + "Itin_Master.json");
    if (legacyItin !== null) return legacyItin;
  }
  return [];
}

// Phase 3 PR-E: Canonical READ_ORIGIN helper. Returns the current origin
// from the reducer state file, or 'PLANNED' if the state file is missing.
// Consumers (Sandbox_Engine, Dispatcher, Dashboard) must use this logic to
// avoid the "silent state inference" pattern that AGENTS.md forbids.
function readOrigin() {
  const raw = readFile(PHASE2_DATA_DIR + "TDS_Trip_State.json") || "";
  if (!raw) return "PLANNED";
  try {
    const s = JSON.parse(raw);
    return s.currentOrigin || "PLANNED";
  } catch (e) {
    return "PLANNED";
  }
}

function helperLogEvent(severity, code, details) {
  flash(JSON.stringify({ timestamp: Date.now(), generationId: global('TDS_Active_Generation') || null,
    component: "TDS_Helper", severity: severity, code: code, tripId: details && details.tripId || null, details: details || {} }));
}

try {
  const par1 = local("par1");
  const par2 = local("par2");
  if (par2 !== "") {
    helperLogEvent("warn", "HELPER_REQUEST_REJECTED", { reason: "generic setter is removed", par1: par1 });
    throw new Error("TDS_Helper generic setter is removed");
  }
  const parts = String(par1).split(":");
  let result;
  if (parts[0] === "readOrigin") {
    // REQ-4HELPER-1: readOrigin takes NO kind suffix; a suffixed request is
    // an unknown/unsupported operation and MUST be rejected.
    if (parts.length > 1 && parts[1] !== "") {
      helperLogEvent("warn", "HELPER_REQUEST_REJECTED", { reason: "readOrigin takes no suffix", par1: par1 });
      throw new Error("TDS_Helper: readOrigin suffix rejected: " + par1);
    }
    result = readOrigin();
  } else if (parts[0] === "readActiveGeneration") {
    // REQ-4HELPER-1: only the exact events|master|itinerary kinds are valid;
    // any other suffix is an unsupported operation and MUST be rejected.
    const kind = parts[1] || "master";
    if (kind !== "events" && kind !== "master" && kind !== "itinerary") {
      helperLogEvent("warn", "HELPER_REQUEST_REJECTED", { reason: "unknown readActiveGeneration kind", par1: par1 });
      throw new Error("TDS_Helper: unknown kind rejected: " + par1);
    }
    result = readActiveGeneration(kind);
  } else {
    helperLogEvent("warn", "HELPER_REQUEST_REJECTED", { reason: "unknown helper operation", par1: par1 });
    throw new Error("TDS_Helper: unknown operation rejected: " + par1);
  }
  setLocal("return_value", typeof result === "string" ? result : JSON.stringify(result));
} catch (e) {
  setLocal("return_value", "ERROR: " + e.message);
}
