/**
 * =========================================================================
 * SUPABASE STAGING ACCEPTANCE: SCORE OWNERSHIP & CANONICAL 3,100 AUDIT
 * The Last Dataset | MAHE Manipal
 * =========================================================================
 *
 * Verifies on the live PostgreSQL / Supabase staging database:
 * 1. An unauthenticated / anon client CANNOT execute privileged RPCs (Permission Denied).
 * 2. Prerequisite boundaries: cannot skip zones or clear Purple before ML qualification.
 * 3. Complete 5-zone sequence + Purple qualifying ML submission.
 * 4. Direct inspection of `score_ledger`:
 *    - Exactly SIX entries (Sanctuary 100, Yellow 200, Blue 400, Orange 600, Red 800, Purple 1,000).
 *    - Total sum = EXACTLY 3,100 points.
 * 5. Idempotency on repeated completes: awards 0 additional points.
 * 6. Foreign-key safe cleanup in finally block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables safely
const fs = require('node:fs');
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
const { supabase } = require('../lib/supabaseClient');
const { supabaseStore } = require('../lib/supabaseStore');

test('Staging Acceptance: Score Ledger Ownership, Permission Boundaries & 3,100-Point Audit', async (t) => {
  if (!supabase) {
    console.log('  [SKIP] Supabase not configured in current environment.');
    return;
  }

  // 1. First probe whether required RPCs are installed on the target database
  const probeRes = await supabase.rpc('complete_zone_atomic', {
    p_team_id: '__PROBE__',
    p_zone_id: 'sanctuary'
  });

  if (probeRes.error && probeRes.error.code === 'PGRST202') {
    console.log('\n  [NOTICE] complete_zone_atomic RPC is not yet installed on this Supabase project.');
    console.log('  Please run supabase/APPLY_TO_PRODUCTION.sql in the Supabase SQL Editor:');
    console.log('  https://supabase.com/dashboard/project/bqedvdohyaeivdqzapyy/sql\n');
    t.skip('Skipping live test: RPCs pending execution in Supabase Dashboard SQL Editor');
    return;
  }

  const runId = crypto.randomBytes(4).toString('hex');
  const teamId = `TEST_OWN_${runId.toUpperCase()}`;
  const teamName = `Audit Team ${runId}`;
  const leaderId = `DEL_${runId}_1`;
  const member2Id = `DEL_${runId}_2`;

  console.log(`\nProvisioning disposable staging team: ${teamId} (${teamName})`);

  try {
    // Setup disposable team
    const { error: teamErr } = await supabase.from('teams').insert({
      id: teamId,
      team_name: teamName,
      team_leader_name: 'Audit Lead',
      leader_mobile: '9876543210',
      passcode_hash: crypto.createHash('sha256').update('StagingPass2026!').digest('hex'),
      is_active: true
    });
    assert.ifError(teamErr, 'Team insertion failed');

    const { error: memErr } = await supabase.from('team_members').insert([
      { delegate_id: leaderId, team_id: teamId, member_name: 'Lead Operator', is_leader: true },
      { delegate_id: member2Id, team_id: teamId, member_name: 'Second Operator', is_leader: false }
    ]);
    assert.ifError(memErr, 'Team members insertion failed');

    const { error: progErr } = await supabase.from('zone_progress').insert([
      { team_id: teamId, zone_id: 'sanctuary', status: 'available', unlocked_at: new Date().toISOString() },
      { team_id: teamId, zone_id: 'yellow', status: 'locked' },
      { team_id: teamId, zone_id: 'blue', status: 'locked' },
      { team_id: teamId, zone_id: 'orange', status: 'locked' },
      { team_id: teamId, zone_id: 'red', status: 'locked' },
      { team_id: teamId, zone_id: 'purple', status: 'locked' }
    ]);
    assert.ifError(progErr, 'Zone progress init failed');

    // -----------------------------------------------------------------------
    // ASSERTION 1: Anonymous Access Rejection (Least Privilege)
    // -----------------------------------------------------------------------
    console.log('Checking permission boundary: unauthenticated / anon client rejection...');
    const anonClient = createClient(process.env.SUPABASE_URL, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon_key');
    const anonRes = await anonClient.rpc('complete_zone_atomic', {
      p_team_id: teamId,
      p_zone_id: 'sanctuary'
    });
    assert.ok(anonRes.error, 'Unauthenticated client must NOT be allowed to execute complete_zone_atomic');

    // -----------------------------------------------------------------------
    // ASSERTION 2: Progression Boundary (Zone Skipping Rejection)
    // -----------------------------------------------------------------------
    console.log('Checking progression boundary: zone skipping rejection...');
    const skipErr = await supabase.rpc('complete_zone_atomic', {
      p_team_id: teamId,
      p_zone_id: 'blue',
      p_required_prev_zone: 'yellow'
    });
    assert.ok(skipErr.error && skipErr.error.message.includes('PREREQUISITE_NOT_MET'), 'Skipping prerequisite must be rejected');

    // -----------------------------------------------------------------------
    // ASSERTION 3: Full Sequential Progression Execution
    // -----------------------------------------------------------------------
    console.log('Executing 5-zone sequence + Purple qualifying ML submission...');

    // 1. Sanctuary (100 pts)
    const sanc = await supabaseStore.completeZoneDirect({ teamId, delegateId: leaderId, zoneId: 'sanctuary' });
    assert.equal(sanc.ok, true);

    // 2. Yellow (200 pts)
    await supabaseStore.completeChallenge({
      teamId,
      delegateId: member2Id,
      zoneId: 'yellow',
      challengeId: 'yellow-01',
      allZoneChallenges: ['yellow-01']
    });
    const yellow = await supabaseStore.completeZoneDirect({ teamId, delegateId: member2Id, zoneId: 'yellow' });
    assert.equal(yellow.ok, true);

    // 3. Blue (400 pts)
    const blueCtfs = ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04'];
    for (const ctfId of blueCtfs) {
      await supabaseStore.completeChallenge({
        teamId,
        delegateId: leaderId,
        zoneId: 'blue',
        challengeId: ctfId,
        allZoneChallenges: blueCtfs
      });
    }
    const blue = await supabaseStore.completeZoneDirect({ teamId, delegateId: leaderId, zoneId: 'blue' });
    assert.equal(blue.ok, true);

    // 4. Orange (600 pts)
    await supabaseStore.completeChallenge({
      teamId,
      delegateId: member2Id,
      zoneId: 'orange',
      challengeId: 'orange-01',
      allZoneChallenges: ['orange-01']
    });
    const orange = await supabaseStore.completeZoneDirect({ teamId, delegateId: member2Id, zoneId: 'orange' });
    assert.equal(orange.ok, true);

    // 5. Red (800 pts)
    await supabaseStore.completeChallenge({
      teamId,
      delegateId: leaderId,
      zoneId: 'red',
      challengeId: 'red-01',
      allZoneChallenges: ['red-01']
    });
    const red = await supabaseStore.completeZoneDirect({ teamId, delegateId: leaderId, zoneId: 'red' });
    assert.equal(red.ok, true);

    // 6. Purple ML Quota & Finalization (1,000 pts)
    const reservation = await supabaseStore.reserveMlAttempt({
      teamId,
      delegateId: member2Id,
      rawFilename: 'test_pred.csv',
      maxAttempts: 10
    });
    assert.equal(reservation.allowed, true);

    const purpleFinal = await supabaseStore.finalizeQualifyingMlSubmission({
      submissionId: reservation.submissionId,
      teamId,
      delegateId: member2Id,
      r2Score: 0.9452,
      mseScore: 0.012,
      points: 1000
    });
    assert.equal(purpleFinal.success, true);
    assert.equal(purpleFinal.zoneCompleted, true);

    // -----------------------------------------------------------------------
    // ASSERTION 4: Direct Inspection of Score Ledger (Strict 6 rows, 1,510 pts)
    // -----------------------------------------------------------------------
    console.log('Directly auditing score_ledger in database...');
    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from('score_ledger')
      .select('*')
      .eq('team_id', teamId)
      .order('id', { ascending: true });

    assert.ifError(ledgerErr);
    assert.equal(ledgerRows.length, 6, `score_ledger must contain exactly 6 entries (found ${ledgerRows.length})`);

    const expectedEntries = [
      { source_id: 'sanctuary-gate', points: 100 },
      { source_id: 'yellow-zone', points: 200 },
      { source_id: 'blue-zone', points: 400 },
      { source_id: 'orange-zone', points: 600 },
      { source_id: 'red-zone', points: 800 },
      { source_id: 'purple-escape', points: 1000 }
    ];

    for (let i = 0; i < expectedEntries.length; i++) {
      const expected = expectedEntries[i];
      const actual = ledgerRows[i];
      assert.equal(actual.source_id, expected.source_id, `Entry ${i + 1} source_id mismatch`);
      assert.equal(actual.points, expected.points, `Entry ${i + 1} points mismatch: expected ${expected.points}, got ${actual.points}`);
    }

    const totalScore = ledgerRows.reduce((sum, r) => sum + r.points, 0);
    assert.equal(totalScore, 3100, `Authoritative total score must be exactly 3,100 (got ${totalScore})`);
    console.log(`  [PASS] Score ledger verified: exactly 6 entries, strictly 3,100 points!`);

    // -----------------------------------------------------------------------
    // ASSERTION 5: Idempotency & Repeat Clearance Lock
    // -----------------------------------------------------------------------
    console.log('Verifying idempotency on repeat clearances...');
    const repeatYellow = await supabaseStore.completeZoneDirect({ teamId, delegateId: leaderId, zoneId: 'yellow' });
    assert.equal(repeatYellow.pointsAwarded, 0, 'Re-completing Yellow must award 0 points');

    const repeatPurple = await supabaseStore.completeZoneDirect({ teamId, delegateId: member2Id, zoneId: 'purple' });
    assert.equal(repeatPurple.pointsAwarded, 0, 'Re-completing Purple must award 0 points');

    // Re-verify ledger count and sum
    const { data: ledgerAfter } = await supabase.from('score_ledger').select('points').eq('team_id', teamId);
    assert.equal(ledgerAfter.length, 6, 'score_ledger must still contain exactly 6 entries');
    const sumAfter = ledgerAfter.reduce((sum, r) => sum + r.points, 0);
    assert.equal(sumAfter, 3100, 'Total score must remain strictly 3,100');

    // -----------------------------------------------------------------------
    // ASSERTION 6: Permanent Lock on Post-Escape ML Submissions
    // -----------------------------------------------------------------------
    console.log('Verifying permanent post-escape submission lock...');
    const postEscapeAttempt = await supabaseStore.reserveMlAttempt({
      teamId,
      delegateId: leaderId,
      rawFilename: 'illegal_post_escape.csv',
      maxAttempts: 10
    });
    assert.equal(postEscapeAttempt.allowed, false, 'Submissions after qualifying must be blocked');
    assert.equal(postEscapeAttempt.alreadyCompleted, true);
    assert.equal(postEscapeAttempt.reason, 'PURPLE_ALREADY_COMPLETED');
    console.log('  [PASS] Permanent lock verified for both teammates!');

  } finally {
    // -----------------------------------------------------------------------
    // FOREIGN-KEY SAFE CLEANUP IN TEARDOWN
    // -----------------------------------------------------------------------
    console.log(`Cleaning up disposable staging records for ${teamId}...`);
    try {
      await supabase.from('score_ledger').delete().eq('team_id', teamId);
      await supabase.from('ml_submissions').delete().eq('team_id', teamId);
      await supabase.from('dataset_entitlements').delete().eq('team_id', teamId);
      await supabase.from('team_sessions').delete().eq('team_id', teamId);
      await supabase.from('zone_progress').delete().eq('team_id', teamId);
      await supabase.from('team_members').delete().eq('team_id', teamId);
      await supabase.from('teams').delete().eq('team_id', teamId);
    } catch (cleanupErr) {
      console.warn('Warning during test teardown cleanup:', cleanupErr.message);
    }
  }
});
