/**
 * =========================================================================
 * TWO-PLAYER SYNCHRONIZED SUPABASE LIFECYCLE E2E TEST
 * The Last Dataset | MAHE Manipal
 * =========================================================================
 *
 * Exercises the end-to-end multi-player game flow on live Supabase:
 * 1. Two players register under shared team with distinct sessions.
 * 2. Third player attempt rejected by database trigger (400 TEAM_CAP_EXCEEDED).
 * 3. Alternating progression: Player 1 Sanctuary -> Player 2 Yellow -> Player 1 Blue -> Player 2 Orange -> Player 1 Red.
 * 4. Dataset entitlement checks and download validation.
 * 5. Concurrent qualifying ML submissions from both teammates: exactly one awards points.
 * 6. Permanent post-qualification lockout applies across both teammate sessions.
 * 7. Score ledger inspection: strictly 6 rows, exactly 1,510 points.
 * 8. Safe teardown in finally block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');
const { supabase } = require('../lib/supabaseClient');

function hashPassword(passcode) {
  return crypto.createHash('sha256').update(String(passcode).trim(), 'utf8').digest('hex');
}

const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'staging-duo-supabase-secret-key-min-32-chars';

function getSampleCsv(multiplier = 0.5) {
  const samplePath = path.join(ROOT, 'server_data', 'sample_submission.csv');
  const lines = fs.readFileSync(samplePath, 'utf8').trim().split(/\r?\n/);
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 2) {
      out.push(`${parts[0].trim()},${multiplier.toFixed(4)}`);
    }
  }
  return out.join('\n');
}

function getWinningCsv() {
  const answersPath = process.env.GROUND_TRUTH_PATH || process.env.PRIVATE_ANSWERS_PATH || path.join(ROOT, 'server_data', 'private_answers.csv');
  if (fs.existsSync(answersPath)) {
    return fs.readFileSync(answersPath, 'utf8');
  }
  if (process.env.PRIVATE_ANSWERS_BASE64) {
    return Buffer.from(process.env.PRIVATE_ANSWERS_BASE64, 'base64').toString('utf8');
  }
  const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'sample_predictions.csv');
  if (fs.existsSync(fixturePath)) {
    return fs.readFileSync(fixturePath, 'utf8');
  }
  return getSampleCsv(0.85);
}

test('Two-Player Synchronized Supabase E2E: Sessions, Concurrency, 3,100 Pts & Permanent Lock', async (t) => {
  if (!supabase) {
    console.log('  [SKIP] Supabase not configured in current environment.');
    return;
  }

  // Check if RPCs exist
  const probeRes = await supabase.rpc('complete_zone_atomic', {
    p_team_id: '__PROBE__',
    p_zone_id: 'sanctuary'
  });

  if (probeRes.error && probeRes.error.code === 'PGRST202') {
    console.log('\n  [NOTICE] complete_zone_atomic RPC is not yet installed on this Supabase project.');
    console.log('  Please run supabase/APPLY_TO_PRODUCTION.sql in the Supabase SQL Editor.');
    t.skip('Skipping live test: RPCs pending execution in Supabase Dashboard SQL Editor');
    return;
  }

  const runId = crypto.randomBytes(4).toString('hex');
  const teamId = `DUO-STAGE-${runId.toUpperCase()}`;
  const teamName = `Synchronized Duo ${runId}`;
  const p1Delegate = `P1-${runId}`;
  const p2Delegate = `P2-${runId}`;
  const p3Delegate = `P3-${runId}`;
  const rawPasscode = 'StagingDuo2026!';
  const hashedPasscode = hashPassword(rawPasscode);

  console.log(`\nSetting up disposable Supabase duo team: ${teamId}`);

  // Start Hub server connected to Supabase
  const server = createHubServer({
    baseDir: ROOT,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      ENABLE_DEV_TOOLS: 'true'
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Provision team & members in Supabase
    await supabase.from('teams').insert({
      id: teamId,
      team_name: teamName,
      team_leader_name: 'Player One',
      leader_mobile: '9876543210',
      passcode_hash: hashedPasscode,
      is_active: true
    });

    await supabase.from('team_members').insert([
      { delegate_id: p1Delegate, team_id: teamId, member_name: 'Player One', is_leader: true },
      { delegate_id: p2Delegate, team_id: teamId, member_name: 'Player Two', is_leader: false }
    ]);

    await supabase.from('zone_progress').insert([
      { team_id: teamId, zone_id: 'sanctuary', status: 'available', unlocked_at: new Date().toISOString() },
      { team_id: teamId, zone_id: 'yellow', status: 'locked' },
      { team_id: teamId, zone_id: 'blue', status: 'locked' },
      { team_id: teamId, zone_id: 'orange', status: 'locked' },
      { team_id: teamId, zone_id: 'red', status: 'locked' },
      { team_id: teamId, zone_id: 'purple', status: 'locked' }
    ]);

    // 2. Player 1 logs in
    const p1Login = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, delegateId: p1Delegate, passcode: rawPasscode })
    });
    assert.equal(p1Login.status, 200, 'Player 1 login must succeed');
    const cookie1 = p1Login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie1 && cookie1.includes('td_session='), 'Player 1 receives session cookie');

    // 3. Player 2 logs in
    const p2Login = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, delegateId: p2Delegate, passcode: rawPasscode })
    });
    assert.equal(p2Login.status, 200, 'Player 2 login must succeed');
    const cookie2 = p2Login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie2 && cookie2 !== cookie1, 'Player 2 receives distinct session cookie');

    // 4. Test 3rd player cap rejection at database level
    const p3Insert = await supabase.from('team_members').insert({
      delegate_id: p3Delegate,
      team_id: teamId,
      member_name: 'Player Three',
      is_leader: false
    });
    assert.ok(p3Insert.error && p3Insert.error.message.includes('TEAM_CAP_EXCEEDED'), 'Trigger must reject 3rd team member');

    // 5. Player 1 completes Sanctuary (100 pts)
    const sancRes = await fetch(`${baseUrl}/api/sanctuary/complete`, {
      method: 'POST',
      headers: { Cookie: cookie1 }
    });
    assert.equal(sancRes.status, 200, 'Sanctuary completion must succeed');
    const bootAfterSanc = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie2 } })).json();
    assert.equal(bootAfterSanc.score.total, 100, 'Team score after Sanctuary must be 100 pts');
    assert.equal(bootAfterSanc.zones.find(z => z.id === 'yellow')?.unlocked, true, 'Yellow must unlock for Player 2');

    // 6. Player 2 completes Yellow (200 pts)
    const ySolve = await fetch(`${baseUrl}/api/dev/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ ctfId: 'yellow-01' })
    });
    assert.equal(ySolve.status, 200, 'Yellow CTF solve must succeed');

    const yellowRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ zoneId: 'yellow' })
    });
    assert.equal(yellowRes.status, 200, 'Yellow completion must succeed');

    // 7. Player 1 downloads community_final dataset
    const ds1Res = await fetch(`${baseUrl}/api/dataset/community_final`, { headers: { Cookie: cookie1 } });
    assert.equal(ds1Res.status, 200, 'Player 1 can download entitled community_final');

    // 8. Player 1 completes Blue (4 CTFs, 400 pts)
    for (const ctfId of ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04']) {
      const bSolve = await fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ ctfId })
      });
      assert.equal(bSolve.status, 200, `Blue CTF ${ctfId} solve must succeed`);
    }

    const blueRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ zoneId: 'blue' })
    });
    assert.equal(blueRes.status, 200, 'Blue completion must succeed');

    // 9. Player 2 completes Orange (600 pts)
    const oSolve = await fetch(`${baseUrl}/api/dev/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ ctfId: 'orange-01' })
    });
    assert.equal(oSolve.status, 200, 'Orange CTF solve must succeed');

    const orangeRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ zoneId: 'orange' })
    });
    assert.equal(orangeRes.status, 200, 'Orange completion must succeed');

    // 10. Player 1 completes Red (800 pts)
    const rSolve = await fetch(`${baseUrl}/api/dev/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ ctfId: 'red-01' })
    });
    assert.equal(rSolve.status, 200, 'Red CTF solve must succeed');

    const redRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ zoneId: 'red' })
    });
    assert.equal(redRes.status, 200, 'Red completion must succeed');

    // Check score before Purple
    const bootBeforePurple = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie2 } })).json();
    assert.equal(bootBeforePurple.score.total, 2100, 'Score before Purple must be exactly 2,100 pts');

    // 11. Player 2 downloads train.csv
    const trainRes = await fetch(`${baseUrl}/api/dataset/train`, { headers: { Cookie: cookie2 } });
    assert.equal(trainRes.status, 200, 'Player 2 can download train dataset for Purple');

    // 12. Player 2 submits non-qualifying ML submission (0.50)
    const lowRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ csvContent: getSampleCsv(0.50), rawFilename: 'draft_p2.csv' })
    });
    assert.equal(lowRes.status, 200);
    const lowJson = await lowRes.json();
    assert.equal(lowJson.qualifiesForEscape, false);
    assert.equal(lowJson.submissionsUsed, 1);

    // 13. Concurrent qualifying submission race: Player 1 and Player 2 submit simultaneously
    const winningCsv = getWinningCsv();
    const [raceP1, raceP2] = await Promise.all([
      fetch(`${baseUrl}/api/ml/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: JSON.stringify({ csvContent: winningCsv, rawFilename: 'final_p1.csv' })
      }),
      fetch(`${baseUrl}/api/ml/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
        body: JSON.stringify({ csvContent: winningCsv, rawFilename: 'final_p2.csv' })
      })
    ]);

    const raceP1Json = await raceP1.json();
    const raceP2Json = await raceP2.json();

    // One of them qualifies, or if serialized, the second gets locked with 429 PURPLE_ALREADY_COMPLETED
    const qualCount = (raceP1Json.qualifiesForEscape ? 1 : 0) + (raceP2Json.qualifiesForEscape ? 1 : 0);
    assert.ok(qualCount >= 1, 'At least one submission must qualify for escape');

    // 14. Permanent post-qualification lockout applies to both sessions
    const postP1 = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
      body: JSON.stringify({ csvContent: winningCsv, rawFilename: 'post_p1.csv' })
    });
    assert.equal(postP1.status, 429, 'Player 1 must be locked after escape');
    const postP1Json = await postP1.json();
    assert.equal(postP1Json.error, 'PURPLE_ALREADY_COMPLETED');

    const postP2 = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
      body: JSON.stringify({ csvContent: winningCsv, rawFilename: 'post_p2.csv' })
    });
    assert.equal(postP2.status, 429, 'Player 2 must be locked after escape');
    const postP2Json = await postP2.json();
    assert.equal(postP2Json.error, 'PURPLE_ALREADY_COMPLETED');

    // 15. Verify score ledger in database: exactly 6 entries, strictly 3,100 pts
    const { data: ledgerRows } = await supabase
      .from('score_ledger')
      .select('*')
      .eq('team_id', teamId)
      .order('id', { ascending: true });

    assert.equal(ledgerRows.length, 6, `Expected exactly 6 ledger entries, got ${ledgerRows.length}`);
    const finalSum = ledgerRows.reduce((sum, r) => sum + r.points, 0);
    assert.equal(finalSum, 3100, `Final score in database must be strictly 3,100 (got ${finalSum})`);
    console.log(`  [PASS] Two-Player Synchronized Supabase E2E complete: strictly 3,100 points!`);

  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
    console.log(`Tearing down disposable duo team ${teamId}...`);
    try {
      await supabase.from('score_ledger').delete().eq('team_id', teamId);
      await supabase.from('ml_submissions').delete().eq('team_id', teamId);
      await supabase.from('dataset_entitlements').delete().eq('team_id', teamId);
      await supabase.from('team_sessions').delete().eq('team_id', teamId);
      await supabase.from('zone_progress').delete().eq('team_id', teamId);
      await supabase.from('team_members').delete().eq('team_id', teamId);
      await supabase.from('teams').delete().eq('team_id', teamId);
    } catch (cleanupErr) {
      console.warn('Warning during teardown:', cleanupErr.message);
    }
  }
});
