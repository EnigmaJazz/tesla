// TDS_Helper — Phase 2 read-only manifest resolver.
// par1 = events|master|itinerary returns the active committed resource (prior/empty fallback).
// par1 = Filename:Index:Key returns legacy getter value.
// Direct writes to RULE-8A files are rejected.

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
function readActive(kind) {
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
  return [];
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

try {
  const par1 = local("par1");
  const par2 = local("par2");
  if (par2 !== "") throw new Error("TDS_Helper generic setter is removed");
  const parts = String(par1).split(":");
  let result;
  if (parts[0] === "readOrigin") {
    result = readOrigin();
  } else if (parts[0] === "readActiveGeneration") {
    result = readActiveGeneration(parts[1] || "master");
  } else if (parts[0] === "events" || parts[0] === "master" || parts[0] === "itinerary") {
    result = readActive(parts[0]);
  } else {
    const arr = readJson(PHASE2_DATA_DIR + parts[0] + ".json") || [];
    result = arr[parseInt(parts[1], 10)][parts[2]];
  }
  setLocal("return_value", typeof result === "string" ? result : JSON.stringify(result));
} catch (e) {
  setLocal("return_value", "ERROR: " + e.message);
}
