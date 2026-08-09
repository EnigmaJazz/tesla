// DST-safe LOCAL day-boundary regression test.
//
// Verifies the local-time helpers (isSameLocalDay / localDayBoundaryUnix)
// used across Alpha.js, Sandbox_Engine.js, Finaliser.js, Compiler.js, and
// Dispatcher.js, plus the Dispatcher multi-waypoint chain-break behaviour
// around local midnight on a DST day. INV-0.2: day comparisons use the
// configured local timezone (the device timezone) and must be DST-safe.
//
// Run: node harness/test_dst_utc.js

process.env.TZ = 'Europe/London';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');
const { isSameLocalDay, localDayBoundaryUnix } = require('./day_utils');

const testName = 'DST: LOCAL day-boundary math is correct across UK BST→GMT and GMT→BST transitions';

function fail(msg) {
    console.log('FAIL: ' + testName + ' — ' + msg);
    process.exit(1);
}

try {
    // -----------------------------------------------------------------
    // 1. isSameLocalDay with known timestamps (local == UTC in GMT months)
    // -----------------------------------------------------------------
    const t1 = 1700000000;                 // ~2023-11-14 22:13:20 UTC == local (GMT)
    const t1Plus1h = 1700003600;           // same local day
    const t1Plus24h = 1700086400;          // next local day

    assert.equal(isSameLocalDay(t1, t1Plus1h), true, 'same local day (1 h apart)');
    assert.equal(isSameLocalDay(t1, t1Plus24h), false, 'different local days (24 h apart)');

    // UK BST→GMT transition: clocks go back at 2026-10-25 02:00 BST (01:00 UTC).
    // 00:30 UTC and 01:30 UTC are both in the doubled local hour (01:30 BST / 01:30 GMT)
    // and both fall on local 2026-10-25.
    const bstToGmtA = Date.parse('2026-10-25T00:30:00Z') / 1000;
    const bstToGmtB = Date.parse('2026-10-25T01:30:00Z') / 1000;
    assert.equal(isSameLocalDay(bstToGmtA, bstToGmtB), true, 'BST→GMT doubled hour: same local day');

    // UK GMT→BST transition: clocks spring forward at 2027-03-28 01:00 GMT (01:00 UTC).
    // 00:30 UTC and 01:30 UTC land on local 00:30 GMT and 02:30 BST — same local day.
    const gmtToBstA = Date.parse('2027-03-28T00:30:00Z') / 1000;
    const gmtToBstB = Date.parse('2027-03-28T01:30:00Z') / 1000;
    assert.equal(isSameLocalDay(gmtToBstA, gmtToBstB), true, 'GMT→BST skipped hour: same local day');

    // Local midnight boundary (GMT month: local midnight == 00:00Z).
    const justBeforeMidnight = Date.parse('2026-10-25T23:59:59Z') / 1000;
    const justAfterMidnight = Date.parse('2026-10-26T00:00:00Z') / 1000;
    assert.equal(isSameLocalDay(justBeforeMidnight, justAfterMidnight), false, 'local midnight boundary: different days');

    // THE DST PROOF: in BST, local midnight is 23:00Z of the PREVIOUS UTC day.
    // 2026-07-14T22:00Z is local 23:00 BST on 14 Jul; 2026-07-14T23:30Z is
    // local 00:30 BST on 15 Jul — the SAME UTC day, different LOCAL days.
    // A UTC-based implementation returns true here, so this pair discriminates.
    const bstEvening = Date.parse('2026-07-14T22:00:00Z') / 1000;
    const bstAfterMidnight = Date.parse('2026-07-14T23:30:00Z') / 1000;
    assert.equal(isSameLocalDay(bstEvening, bstAfterMidnight), false,
        'BST: 23:00 and 00:30 local are different local days despite the same UTC day');

    // -----------------------------------------------------------------
    // 2. localDayBoundaryUnix — local midnight, DST-aware
    // -----------------------------------------------------------------
    const boundaryForT1 = localDayBoundaryUnix(t1);
    assert.equal(boundaryForT1, Date.parse('2023-11-14T00:00:00Z') / 1000, 'local midnight of t1 (GMT month)');

    assert.equal(
        localDayBoundaryUnix(bstToGmtB),
        Date.parse('2026-10-24T23:00:00Z') / 1000,
        'local midnight of the BST→GMT transition day must be 23:00Z (BST still active at midnight)'
    );

    // DST proof for the boundary: local midnight of 14 Jul 2026 (BST) is
    // 2026-07-13T23:00:00Z, NOT 2026-07-14T00:00:00Z.
    assert.equal(
        localDayBoundaryUnix(bstEvening),
        Date.parse('2026-07-13T23:00:00Z') / 1000,
        'BST local midnight must be 23:00Z of the previous UTC day'
    );

    // -----------------------------------------------------------------
    // 3. Dispatcher multi-waypoint chain break at the LOCAL midnight
    //
    // Old code compared UTC days, so two legs straddling LOCAL midnight
    // (23:00 BST on 14 Jul → 00:30 BST on 15 Jul, both UTC 14 Jul) would
    // cluster. The local helper must break the chain at the local boundary.
    // Stay is 90 min (> 45 min) so the stay fallback cannot mask the result,
    // and the pair shares a UTC day so a UTC-only implementation would NOT
    // break — the single waypoint can only come from the local-day check.
    // -----------------------------------------------------------------
    const nowSec = Date.parse('2026-07-14T21:50:00Z') / 1000;

    const leg0Arrive = bstEvening;            // local 23:00 BST, 14 Jul
    const leg1Depart = bstAfterMidnight;      // local 00:30 BST, 15 Jul (same UTC day)

    assert.equal(
        isSameLocalDay(leg0Arrive, leg1Depart),
        false,
        'Dispatcher chain-break probe: different LOCAL days despite same UTC date'
    );

    const chainBreakMaster = JSON.stringify([
        {
            mode: 'DRIVE',
            departUnix: leg1Depart,
            arriveUnix: leg0Arrive,
            targetTitle: 'Leg0',
            targetCoords: '51.0,-1.0'
        },
        {
            mode: 'DRIVE',
            departUnix: leg1Depart + 3600,
            arriveUnix: leg1Depart + 3600,
            targetTitle: 'Leg1',
            targetCoords: '52.0,-2.0'
        }
    ]);

    const dispatcherGlobals = {
        Tesla_Last_Scheduled: String(nowSec - 7200),
        Tesla_Last_HVAC_Unix: '0',
        Tesla_Last_Nav: '',
        Google_Last_Nav: '',
        Current_Status: '',
        User_At_AdHoc: ''
    };

    const dispatcherFiles = {
        'Tasker/Tesla/Data/Itin_Master.json': chainBreakMaster
    };

    const { sandbox: dispSandbox, store: dispStore } = createSandbox({
        globals: dispatcherGlobals,
        files: dispatcherFiles,
        nowMs: nowSec * 1000
    });

    const dispatcherPath = path.resolve(__dirname, '..', 'Dispatcher.js');
    runScript(dispatcherPath, dispSandbox, dispStore);

    if (dispStore.runError) {
        fail('Dispatcher fixture threw: ' + dispStore.runError.message + ' (line ' + dispStore.runError.line + ')');
    }

    const navPayload = dispStore.locals['tds_next_coords'] || '';
    const waypoints = navPayload.split('~').filter(function (c) { return c.length > 0; });

    assert.equal(
        waypoints.length,
        1,
        'Dispatcher must break multi-waypoint chain at the LOCAL day boundary; expected 1 waypoint, got ' + waypoints.length
    );

    // -----------------------------------------------------------------
    // 4. Slice A: Sandbox planningDay must be DST-local, not UTC.
    //
    // An event at 2026-10-24T23:30:00Z lands on local day 2026-10-25
    // (00:30 BST) but UTC day 2026-10-24. The planned queue row col 20 must
    // carry the LOCAL planning day label.
    // -----------------------------------------------------------------
    const dstNowSec = Date.parse('2026-10-24T22:30:00Z') / 1000;   // local 23:30 BST on 24 Oct
    const dstEvStart = Date.parse('2026-10-24T23:30:00Z') / 1000;  // local 00:30 BST on 25 Oct
    const dstHomeCoords = '51.9,-2.1';
    const dstEventCoords = '52.5,-1.5';
    const dstDayLabel = '2026-10-25'; // LOCAL day, differs from UTC day 2026-10-24

    const dstMasterJson = JSON.stringify([
        {
            id: 'event_dst_kx8f04',
            start: dstEvStart,
            end: dstEvStart + 3600,
            duration: 3600,
            title: 'DST Event',
            desc: '',
            loc: 'Office',
            coords: dstEventCoords
        }
    ]);

    const dstBaseGeocodes = [
        dstNowSec.toString(),
        (dstNowSec + 86400).toString(),
        dstHomeCoords,
        '0',
        'Home',
        '',
        'home_base'
    ].join('~');

    const dstFiles = {
        'Tasker/Tesla/Data/Itin_Master.json': '[]',
        'Tasker/Tesla/Data/TDS_Master.json': dstMasterJson,
        'Tasker/Tesla/Data/TDS_Base_Geocodes.txt': dstBaseGeocodes,
        'Tasker/Tesla/Data/TDS_Overrides.json': '{}',
        'Tasker/Tesla/Data/Temp_Route_Cache.txt': '',
        'Tasker/Tesla/Data/RouteCache.txt': ''
    };

    const dstGlobals = {
        User_At_Base: 'true',
        Base_Arrival_Unix: dstNowSec.toString(),
        User_Loc: dstHomeCoords,
        Home_Coords: dstHomeCoords,
        Current_Status: '',
        Arrival_Buffer_Mins: '5',
        Departure_Buffer_Mins: '5',
        Max_Walk_Meters: '8046',
        Daily_Walk_Meters: '0',
        Live_Traffic_Threshold: '7200',
        Car_Connected: 'false'
    };

    const dstLocals = {
        idx: '1',
        vcar_loc: dstHomeCoords,
        virtual_time: String(dstNowSec)
    };

    const { sandbox: dstSandbox, store: dstStore } = createSandbox({
        locals: dstLocals,
        globals: dstGlobals,
        files: dstFiles,
        nowMs: dstNowSec * 1000
    });

    const sandboxPath = path.resolve(__dirname, '..', 'Sandbox_Engine.js');
    runScript(sandboxPath, dstSandbox, dstStore);

    if (dstStore.runError) {
        fail('DST Sandbox fixture threw: ' + dstStore.runError.message + ' (line ' + dstStore.runError.line + ')');
    }

    const dstQueue = dstStore.locals['block_queue'];
    if (!dstQueue || dstQueue === 'EOF') fail('DST Sandbox expected non-empty block_queue');
    const dstEnv = JSON.parse(dstQueue);
    const dstHead = dstEnv.rows[0];
    if (!dstHead) fail('DST Sandbox expected a head row');
    if (dstHead.planningDay !== dstDayLabel) {
        fail('DST planningDay should be local ' + dstDayLabel + ', got ' + JSON.stringify(dstHead.planningDay) + ' (UTC day is 2026-10-24)');
    }

    console.log('PASS: ' + testName);
    console.log('  same local day (1 h apart) = true');
    console.log('  different local days (24 h apart) = false');
    console.log('  BST→GMT doubled hour same local day = true');
    console.log('  GMT→BST skipped hour same local day = true');
    console.log('  local midnight boundary = false');
    console.log('  BST 22:00Z/23:30Z = different local days, same UTC day = false');
    console.log('  localDayBoundaryUnix(1700000000) = ' + boundaryForT1);
    console.log('  BST local midnight = 23:00Z previous UTC day (verified)');
    console.log('  Dispatcher chain-break waypoints = ' + waypoints.length);
    console.log('  DST-local planningDay = ' + dstHead.planningDay + ' (local, typed envelope)');
    process.exit(0);
} catch (e) {
    fail(e.message);
}
