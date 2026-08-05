// DST-safe UTC day-boundary regression test.
//
// Verifies the pure UTC helpers used across Alpha.js, Sandbox_Engine.js,
// Finaliser.js, Compiler.js, and Dispatcher.js, plus the Dispatcher multi-
// waypoint chain-break behaviour around the UK BST→GMT transition.
//
// Run: node harness/test_dst_utc.js

process.env.TZ = 'Europe/London';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createSandbox } = require('./mock_tasker');
const { runScript } = require('./runner');
const { isSameUTCDay, utcDayBoundaryUnix, SECONDS_PER_DAY } = require('./day_utils');

const testName = 'DST: UTC day-boundary math is correct across UK BST→GMT and GMT→BST transitions';

function fail(msg) {
    console.log('FAIL: ' + testName + ' — ' + msg);
    process.exit(1);
}

try {
    // -----------------------------------------------------------------
    // 1. isSameUTCDay with known UTC timestamps
    // -----------------------------------------------------------------
    const t1 = 1700000000;                 // ~2023-11-14 22:13:20 UTC
    const t1Plus1h = 1700003600;           // same UTC day
    const t1Plus24h = 1700086400;          // next UTC day

    assert.equal(isSameUTCDay(t1, t1Plus1h), true, 'same UTC day (1 h apart)');
    assert.equal(isSameUTCDay(t1, t1Plus24h), false, 'different UTC days (24 h apart)');

    // UK BST→GMT transition: clocks go back at 2026-10-25 02:00 BST (01:00 UTC).
    // 00:30 UTC and 01:30 UTC are both in the doubled local hour (01:30 BST / 01:30 GMT)
    // but, crucially, both are the same UTC day.
    const bstToGmtA = Date.parse('2026-10-25T00:30:00Z') / 1000;
    const bstToGmtB = Date.parse('2026-10-25T01:30:00Z') / 1000;
    assert.equal(isSameUTCDay(bstToGmtA, bstToGmtB), true, 'BST→GMT doubled hour: same UTC day');

    // UK GMT→BST transition: clocks spring forward at 2027-03-28 01:00 GMT (01:00 UTC).
    // 00:30 UTC and 01:30 UTC are on the same UTC day but local time jumps from 00:30 GMT to 02:30 BST.
    const gmtToBstA = Date.parse('2027-03-28T00:30:00Z') / 1000;
    const gmtToBstB = Date.parse('2027-03-28T01:30:00Z') / 1000;
    assert.equal(isSameUTCDay(gmtToBstA, gmtToBstB), true, 'GMT→BST skipped hour: same UTC day');

    // Midnight boundary
    const justBeforeMidnight = Date.parse('2026-10-25T23:59:59Z') / 1000;
    const justAfterMidnight = Date.parse('2026-10-26T00:00:00Z') / 1000;
    assert.equal(isSameUTCDay(justBeforeMidnight, justAfterMidnight), false, 'UTC midnight boundary: different days');

    // -----------------------------------------------------------------
    // 2. utcDayBoundaryUnix
    // -----------------------------------------------------------------
    const boundaryForT1 = utcDayBoundaryUnix(t1);
    assert.equal(boundaryForT1, Date.parse('2023-11-14T00:00:00Z') / 1000, 'UTC midnight of t1');

    assert.equal(
        utcDayBoundaryUnix(bstToGmtB),
        Date.parse('2026-10-25T00:00:00Z') / 1000,
        'UTC midnight of BST→GMT transition day'
    );

    // -----------------------------------------------------------------
    // 3. Dispatcher multi-waypoint chain break across the BST→GMT transition
    //
    // Old code compared local days via getDate(), so two timestamps that both
    // displayed as "25 Oct" in local time would cluster even when they straddle
    // the UTC day boundary. The new code must break the chain at the UTC boundary.
    // -----------------------------------------------------------------
    const nowSec = Date.parse('2026-10-25T00:15:00Z') / 1000; // during the transition night

    // Leg 0 arrives at 23:50 UTC on 24 Oct (local 25 Oct 00:50 BST).
    // Leg 1 departs at 00:10 UTC on 25 Oct (local 25 Oct 00:10 GMT).
    // Same local day, different UTC days, and only a 20-minute stay -> old
    // getDate() logic would cluster, but the UTC helper must break the chain.
    const leg0Arrive = Date.parse('2026-10-24T23:50:00Z') / 1000;
    const leg1Depart = Date.parse('2026-10-25T00:10:00Z') / 1000;
    const nowForDispatcher = Date.parse('2026-10-24T23:55:00Z') / 1000;

    assert.equal(
        isSameUTCDay(leg0Arrive, leg1Depart),
        false,
        'Dispatcher chain-break probe: different UTC days despite same local date'
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
            departUnix: leg1Depart + 1800,
            arriveUnix: leg1Depart + 1800,
            targetTitle: 'Leg1',
            targetCoords: '52.0,-2.0'
        }
    ]);

    const dispatcherGlobals = {
        Tesla_Last_Scheduled: String(nowForDispatcher - 7200),
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
        nowMs: nowForDispatcher * 1000
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
        'Dispatcher must break multi-waypoint chain at UTC day boundary; expected 1 waypoint, got ' + waypoints.length
    );

    console.log('PASS: ' + testName);
    console.log('  same UTC day (1 h apart) = true');
    console.log('  different UTC days (24 h apart) = false');
    console.log('  BST→GMT doubled hour same UTC day = true');
    console.log('  GMT→BST skipped hour same UTC day = true');
    console.log('  UTC midnight boundary = false');
    console.log('  utcDayBoundaryUnix(1700000000) = ' + boundaryForT1);
    console.log('  Dispatcher chain-break waypoints = ' + waypoints.length);

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
    console.log('  same UTC day (1 h apart) = true');
    console.log('  different UTC days (24 h apart) = false');
    console.log('  BST→GMT doubled hour same UTC day = true');
    console.log('  GMT→BST skipped hour same UTC day = true');
    console.log('  UTC midnight boundary = false');
    console.log('  utcDayBoundaryUnix(1700000000) = ' + boundaryForT1);
    console.log('  Dispatcher chain-break waypoints = ' + waypoints.length);
    console.log('  DST-local planningDay = ' + dstHead.planningDay + ' (local, typed envelope)');
    process.exit(0);
} catch (e) {
    fail(e.message);
}
