// ==========================================
// TDS OCCURRENCE ID PARSER (v2.0) — canonical reference
//
// Strict parser for occurrence IDs. The Tasker JSlet runtime has no module
// system, so production consumers inline an identical copy of the constants,
// regex, parser, and structured logger; the only thing that differs between
// copies is the `component` value passed at the call site. This file exists
// for the harness and as the reference those inline copies must stay in sync
// with.
//
// ID-2 / SCRIPT-15: occurrence IDs are `<coreId>_<base36StartUnix>`. The
// core MAY contain underscores (Google Calendar IDs can), so the split uses
// `lastIndexOf("_")`; the full string must match
// `^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$` and the base-36 suffix must decode to a
// Unix timestamp in [ID_SUFFIX_MIN_UNIX, ID_SUFFIX_MAX_UNIX).
//
// Rejections flash structured JSON (AGENTS.md logging contract) with code
// ID_PARSE_REJECTED and reasons empty_id | malformed_format | invalid_suffix;
// the caller MUST skip the rejected occurrence/command (no apply).
//
// This file MUST NOT use require/import/module.exports.
// ==========================================

const ID_SUFFIX_MIN_UNIX = 1e9;
const ID_SUFFIX_MAX_UNIX = 2.5e9;
const ID_OCCURRENCE_REGEX = /^([0-9A-Za-z_]+)_([0-9A-Za-z]+)$/;

function parseOccurrenceId(rawId, component) {
    component = component || "ID_Parser";
    if (typeof rawId !== "string" || rawId.length === 0) {
        return rejectOccurrenceId(rawId, "empty_id", component);
    }
    const lastSep = rawId.lastIndexOf("_");
    if (lastSep <= 0 || lastSep === rawId.length - 1) {
        return rejectOccurrenceId(rawId, "malformed_format", component);
    }
    const match = ID_OCCURRENCE_REGEX.exec(rawId);
    if (!match) {
        return rejectOccurrenceId(rawId, "malformed_format", component);
    }
    const suffixNum = parseInt(match[2], 36);
    if (isNaN(suffixNum) || suffixNum < ID_SUFFIX_MIN_UNIX || suffixNum >= ID_SUFFIX_MAX_UNIX) {
        return rejectOccurrenceId(rawId, "invalid_suffix", component);
    }
    return { ok: true, coreId: match[1], instanceStartUnix: suffixNum, rawId: rawId };
}

function rejectOccurrenceId(rawId, reason, component) {
    flash(JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        generationId: null,
        component: component,
        severity: "WARN",
        code: "ID_PARSE_REJECTED",
        tripId: null,
        details: { rawId: rawId, reason: reason }
    }));
    return { ok: false, reason: reason };
}
