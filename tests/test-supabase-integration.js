const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

async function runTests() {
  console.log('====================================================');
  console.log('STARTING THE LAST DATASET END-TO-END SYSTEM TESTS');
  console.log('====================================================');

  const server = createHubServer();
  await new Promise((resolve) => server.listen(4199, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:4199';
  console.log(`Test server running at ${baseUrl}`);

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_INTEGRATION_TEST_IN_PROD !== 'true') {
    console.error('REFUSING to run destructive integration test in production environment without ALLOW_INTEGRATION_TEST_IN_PROD=true');
    process.exit(1);
  }

  // Test state isolation: Clean up previous test run data for TECHTEAM10328
  const { supabase } = require('../lib/supabaseClient');
  if (!supabase) {
    console.error('Supabase client is not configured. Skipping integration tests.');
    return;
  }
  await supabase.from('score_ledger').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('dataset_entitlements').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('ml_submissions').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('zone_progress').delete().eq('team_id', 'TECHTEAM10328');
  await supabase.from('zone_progress').insert([
    { team_id: 'TECHTEAM10328', zone_id: 'sanctuary', status: 'available', unlocked_at: new Date().toISOString() },
    { team_id: 'TECHTEAM10328', zone_id: 'yellow', status: 'locked', unlocked_at: null }
  ]);

  let testPassed = 0;
  let testFailed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      testPassed++;
    } else {
      console.error(`  [FAIL] ${message}`);
      testFailed++;
    }
  }

  let sessionCookie = '';

  try {
    // 1. Test Health Endpoint
    console.log('\n--- 1. Testing /api/health ---');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = await healthRes.json();
    assert(healthRes.status === 200, 'Health endpoint returns 200');
    assert(healthJson.database === 'supabase-postgresql', 'Health reports supabase-postgresql database');

    // 2. Test Unauthenticated Bootstrap
    console.log('\n--- 2. Testing /api/bootstrap (Unauthenticated) ---');
    const unauthRes = await fetch(`${baseUrl}/api/bootstrap`);
    const unauthJson = await unauthRes.json();
    assert(unauthJson.authenticated === false, 'Unauthenticated user gets authenticated=false');
    assert(unauthJson.zones.length === 5, 'Returns 5 zones definition');

    // 3. Test Invalid Login Attempts
    console.log('\n--- 3. Testing Authentication Security Boundaries ---');
    // Wrong team
    const badTeamRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM99999', delegateId: '12331', passcode: 'MAHE2026!' })
    });
    assert(badTeamRes.status === 401, 'Non-existent Team ID returns 401');

    // Wrong passcode
    const badPassRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM10328', delegateId: '12331', passcode: 'WRONG_PASS' })
    });
    assert(badPassRes.status === 401, 'Wrong password returns 401');

    // Wrong delegate
    const badDelRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM10328', delegateId: '99999', passcode: 'MAHE2026!' })
    });
    assert(badDelRes.status === 401, 'Unregistered delegate ID returns 401');

    // 4. Test Valid Player Login (Player 1: 12331)
    console.log('\n--- 4. Testing Valid Player Login (Player 1) ---');
    const validLoginRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'TECHTEAM10328', delegateId: '12331', passcode: 'MAHE2026!' })
    });
    const loginJson = await validLoginRes.json();
    assert(validLoginRes.status === 200, 'Valid login returns 200');
    assert(loginJson.authenticated === true, 'Returns authenticated=true');
    assert(loginJson.team.id === 'TECHTEAM10328', 'Returns team ID TECHTEAM10328');
    assert(loginJson.team.name === 'Alpha Protocol', 'Returns verified team name Alpha Protocol');
    assert(loginJson.player.delegateId === '12331', 'Identifies active operator 12331');

    const rawCookie = validLoginRes.headers.get('set-cookie');
    assert(!!rawCookie && rawCookie.includes('td_session='), 'Sets HttpOnly td_session cookie');
    sessionCookie = rawCookie.split(';')[0];

    // 5. Test Authenticated Bootstrap with Cookie
    console.log('\n--- 5. Testing Authenticated /api/bootstrap ---');
    const authBootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Cookie: sessionCookie }
    });
    const authBootJson = await authBootRes.json();
    assert(authBootJson.authenticated === true, 'Session cookie restores authentication');
    assert(authBootJson.score !== undefined, 'Returns authoritative score');
    assert(authBootJson.zones[0].unlocked === false, 'Yellow zone is initially locked until Sanctuary is completed');
    assert(authBootJson.zones.every((z) => z.unlocked === false), 'All quarantine zones are initially locked upon login');

    // 5.1 Test Sanctuary Completion unlocks Yellow Zone
    console.log('\n--- 5.1 Testing Sanctuary Storyline Completion ---');
    const sancRes = await fetch(`${baseUrl}/api/sanctuary/complete`, {
      method: 'POST',
      headers: { Cookie: sessionCookie }
    });
    assert(sancRes.status === 200, 'Sanctuary completion endpoint returns 200');
    const sancBoot = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: sessionCookie } })).json();
    assert(sancBoot.zones[0].unlocked === true, 'Yellow zone is unlocked after Sanctuary storyline completion');

    // 6. Test Dataset Entitlement Security (Before Solve)
    console.log('\n--- 6. Testing Dataset Entitlement Gate (Before Clearing Zone) ---');
    // Training set should NOT be accessible until Purple Zone is unlocked
    const trainRes = await fetch(`${baseUrl}/api/dataset/train`, {
      headers: { Cookie: sessionCookie }
    });
    assert(trainRes.status === 403, 'train.csv is 403 Forbidden until Purple Zone is unlocked');

    // Yellow reward (community_final) should NOT be accessible yet
    const lockedDatasetRes = await fetch(`${baseUrl}/api/dataset/community_final`, {
      headers: { Cookie: sessionCookie }
    });
    assert(lockedDatasetRes.status === 403, 'community_final.csv is 403 Forbidden before zone is cleared');

    // 7. Test Concurrency & Idempotency (Atomic Multi-Player Challenge Solve)
    console.log('\n--- 7. Testing Atomic Multi-Player Concurrency & Idempotency ---');
    // Simulate both teammates solving yellow-01 concurrently
    const [solve1, solve2] = await Promise.all([
      fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ ctfId: 'yellow-01' })
      }),
      fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ ctfId: 'yellow-01' })
      })
    ]);

    const solve1Json = await solve1.json();
    const solve2Json = await solve2.json();

    assert(solve1.status === 200 && solve2.status === 200, 'Both concurrent solve requests return 200');
    const newSolveCount = (solve1Json.rpcResult?.newlySolved ? 1 : 0) + (solve2Json.rpcResult?.newlySolved ? 1 : 0);
    assert(newSolveCount === 1, `Points were awarded exactly once (newlySolved=true on only 1 request, got ${newSolveCount})`);

    // 8. Verify Zone Completion & Dataset Entitlement Unlock (Yellow Zone cleared on yellow-01)
    console.log('\n--- 8. Testing Zone Completion & Dataset Entitlement Unlock ---');

    // Now community_final dataset should be unlocked and downloadable!
    const unlockedDatasetRes = await fetch(`${baseUrl}/api/dataset/community_final`, {
      headers: { Cookie: sessionCookie }
    });
    assert(unlockedDatasetRes.status === 200, 'community_final.csv is now 200 OK after Yellow Zone clear');
    const datasetCsv = await unlockedDatasetRes.text();
    assert(datasetCsv.includes('Sanctuary_ID') && datasetCsv.includes('SANC-0001'), 'Downloaded CSV contains valid survivor data');

    // Verify Blue Zone is now unlocked
    const nextBootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Cookie: sessionCookie }
    });
    const nextBootJson = await nextBootRes.json();
    assert(nextBootJson.zones[1].unlocked === true, 'Blue Zone is unlocked automatically following Yellow Zone clear');
    assert(nextBootJson.score.total >= 20, `Team score updated accurately (Total: ${nextBootJson.score.total} pts)`);

    // 9. Test Purple Zone Server-Side ML Evaluator
    console.log('\n--- 9. Testing Purple Zone Server-Side ML Evaluator ---');
    const samplePredsPath = path.join(__dirname, 'fixtures', 'sample_predictions.csv');
    const samplePreds = fs.existsSync(samplePredsPath)
      ? fs.readFileSync(samplePredsPath, 'utf8')
      : fs.readFileSync(path.resolve(__dirname, '..', 'tests', 'fixtures', 'sample_predictions.csv'), 'utf8');

    const evalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ csvContent: samplePreds, rawFilename: 'catboost_test.csv' })
    });
    const evalJson = await evalRes.json();
    assert(evalRes.status === 200, 'ML evaluation endpoint returns 200 for valid predictions');
    assert(evalJson.r2Score === 0.7754, `Calculated accurate R² score against hidden ground truth (R² = ${evalJson.r2Score})`);
    assert(evalJson.qualifiesForEscape === false, '0.7754 does not unlock escape gate (< 0.80)');

    const privateKeyPath = process.env.GROUND_TRUTH_PATH || process.env.PRIVATE_ANSWERS_PATH || path.resolve(__dirname, '..', 'server_data', 'private_answers.csv');
    let perfectKey = '';
    if (fs.existsSync(privateKeyPath)) {
      perfectKey = fs.readFileSync(privateKeyPath, 'utf8');
    } else if (process.env.PRIVATE_ANSWERS_BASE64) {
      perfectKey = Buffer.from(process.env.PRIVATE_ANSWERS_BASE64, 'base64').toString('utf8');
    } else {
      const fixturePath = path.resolve(__dirname, 'fixtures', 'sample_predictions.csv');
      if (fs.existsSync(fixturePath)) {
        perfectKey = fs.readFileSync(fixturePath, 'utf8');
      }
    }
    const perfectRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ csvContent: perfectKey, rawFilename: 'perfect.csv' })
    });
    const perfectJson = await perfectRes.json();
    assert(perfectJson.r2Score === 1.0, 'Perfect answers score R² = 1.0');
    assert(perfectJson.qualifiesForEscape === true, 'R² >= 0.80 unlocks the Escape Gate (qualifiesForEscape=true)');

    // 10. Test Leaderboard
    console.log('\n--- 10. Testing Live Leaderboard ---');
    const leadRes = await fetch(`${baseUrl}/api/leaderboard`);
    const leadJson = await leadRes.json();
    assert(leadRes.status === 200, 'Leaderboard endpoint returns 200');
    assert(Array.isArray(leadJson.leaderboard), 'Returns leaderboard array');
    const topTeam = leadJson.leaderboard.find((t) => t.team_id === 'TECHTEAM10328');
    assert(!!topTeam && topTeam.escape_unlocked === true, 'Leaderboard accurately reflects team score and escape status');

    // 11. Test Purple Zone Static Route, Sample Submission Download, and Submissions History
    console.log('\n--- 11. Testing Purple Zone Integration Endpoints ---');
    const purplePageRes = await fetch(`${baseUrl}/purple`);
    assert(purplePageRes.status === 200, 'GET /purple returns 200 OK');
    const purpleHtml = await purplePageRes.text();
    assert(purpleHtml.includes('PRALAYA CORE') && purpleHtml.includes('SURVIVAL EVALUATOR'), 'GET /purple serves Purple Zone HTML');

    const sampleSubRes = await fetch(`${baseUrl}/api/dataset/sample_submission`, {
      headers: { Cookie: sessionCookie }
    });
    assert(sampleSubRes.status === 200, 'GET /api/dataset/sample_submission returns 200 OK');
    const sampleSubCsv = await sampleSubRes.text();
    assert(sampleSubCsv.includes('Sanctuary_ID,Survival_Probability') && sampleSubCsv.includes('SANC-0091'), 'sample_submission.csv has valid headers and rows');

    const subsRes = await fetch(`${baseUrl}/api/ml/submissions`, {
      headers: { Cookie: sessionCookie }
    });
    assert(subsRes.status === 200, 'GET /api/ml/submissions returns 200 OK');
    const subsJson = await subsRes.json();
    assert(Array.isArray(subsJson.submissions) && subsJson.submissions.length >= 2, `Returns team submissions history (count: ${subsJson.submissions?.length})`);
    assert(subsJson.submissions.some((s) => s.qualifies_for_escape === true), 'Submission history records qualified escape submission');
    assert(subsJson.maxAllowed === 10, 'Max allowed submissions is strictly 10');
    assert(subsJson.submissionsRemaining <= 8, 'Accurately computes submissions remaining out of 10');

    // 12. Test Strict 10 Submission Quota Limit
    console.log('\n--- 12. Testing Strict 10 Submission Quota Limit ---');
    const currentCount = subsJson.submissions.length;
    for (let i = currentCount; i < 10; i++) {
      const fillRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ csvContent: samplePreds, rawFilename: `quota_test_${i}.csv` })
      });
      assert(fillRes.status === 200, `Submission ${i + 1}/10 allowed`);
    }

    // Attempt 11th submission (must be strictly blocked)
    const blockedRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ csvContent: samplePreds, rawFilename: 'attempt_11_forbidden.csv' })
    });
    assert(blockedRes.status === 429, '11th submission is rejected with HTTP 429');
    const blockedJson = await blockedRes.json();
    assert(blockedJson.error === 'SUBMISSION_LIMIT_EXCEEDED', 'Returns SUBMISSION_LIMIT_EXCEEDED error code');
    assert(blockedJson.maxAllowed === 10, 'Reflects maxAllowed = 10 limit');

    // 13. Verify Helicopter & Helipad Assets in Purple Zone HTML
    console.log('\n--- 13. Verifying Helicopter & Helipad Components ---');
    assert(purpleHtml.includes('extraction-modal'), 'Purple Zone contains tactical extraction modal');
    assert(purpleHtml.includes('helicopter-rig'), 'Purple Zone contains animated vector helicopter rig');
    assert(purpleHtml.includes('helipad-platform'), 'Purple Zone contains tactical helipad deck');
    assert(purpleHtml.includes('helicopter-active-banner'), 'Purple Zone contains persistent helicopter notification banner');
    assert(purpleHtml.includes('EX-09 PROTOCOL'), 'Helicopter contains EX-09 tactical protocol markings');

    // 14. Testing Reload State Persistence, Cross-Origin Headers & Progression Endpoints
    console.log('\n--- 14. Testing Reload Persistence & Cross-Origin Progression ---');

    // 14.1 Unauthenticated request with ?team= cannot access private session
    const reloadUrlRes = await fetch(`${baseUrl}/api/bootstrap?team=TECHTEAM10328`);
    assert(reloadUrlRes.status === 200, 'GET /api/bootstrap?team=TECHTEAM10328 returns 200');
    const reloadUrlJson = await reloadUrlRes.json();
    assert(reloadUrlJson.authenticated === false, 'URL parameter ?team= without session returns authenticated=false');
    assert(Array.isArray(reloadUrlJson.zones) && reloadUrlJson.zones.length === 5, 'Bootstrap returns all 5 quarantine zones');

    // 14.2 Spoofed x-team-id header without session does not authenticate
    const reloadHeaderRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { 'x-team-id': 'TECHTEAM10328' }
    });
    assert(reloadHeaderRes.status === 200, 'GET /api/bootstrap with x-team-id header returns 200');
    const reloadHeaderJson = await reloadHeaderRes.json();
    assert(reloadHeaderJson.authenticated === false, 'Header x-team-id without session returns authenticated=false');

    // 14.2b Session cookie rehydration restores authenticated state
    const authRehydrateRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Cookie: sessionCookie }
    });
    assert(authRehydrateRes.status === 200, 'GET /api/bootstrap with session cookie returns 200');
    const authRehydrateJson = await authRehydrateRes.json();
    assert(authRehydrateJson.authenticated === true, 'Session cookie restores authenticated status');
    assert((authRehydrateJson.teamId || authRehydrateJson.team?.id) === 'TECHTEAM10328', 'Session cookie returns correct team ID');

    // 14.3 Cross-Origin Preflight (OPTIONS)
    const optionsRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://yellowzone-xi.vercel.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization, x-session-id'
      }
    });
    assert(optionsRes.status === 204, 'OPTIONS preflight returns 204 No Content');
    assert(optionsRes.headers.get('access-control-allow-origin') === 'https://yellowzone-xi.vercel.app', 'Preflight returns Access-Control-Allow-Origin matching caller origin');

    // 14.4 Cross-Origin Progress Query with Session Cookie
    const progressRes = await fetch(`${baseUrl}/api/team/progress`, {
      headers: {
        'Origin': 'https://bluezone-three.vercel.app',
        Cookie: sessionCookie
      }
    });
    assert(progressRes.status === 200, 'GET /api/team/progress returns 200 OK with session');
    const progressJson = await progressRes.json();
    assert((progressJson.teamId || progressJson.team?.id) === 'TECHTEAM10328', 'Progress query returns correct team ID');
    assert(progressJson.zones?.some(z => z.id === 'yellow'), 'Progress contains yellow zone');

    // 14.5 Cross-Zone Direct Progression: Complete Blue & Orange Zones in sequence
    const blueCompleteRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://bluezone-three.vercel.app',
        Cookie: sessionCookie
      },
      body: JSON.stringify({ zoneId: 'blue' })
    });
    assert(blueCompleteRes.status === 200, 'POST /api/zone/complete for Blue Zone returns 200 OK');
    const blueCompleteJson = await blueCompleteRes.json();
    assert(blueCompleteJson.ok === true, 'Blue Zone completion acknowledged');
    const orangeZoneState = blueCompleteJson.bootstrap?.zones?.find(z => z.id === 'orange');
    assert(orangeZoneState?.unlocked === true, 'Orange Zone unlocked following Blue Zone completion');

    // Complete Orange Zone before Red
    const orangeCompleteRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://or-light-gamma.vercel.app',
        Cookie: sessionCookie
      },
      body: JSON.stringify({ zoneId: 'orange' })
    });
    assert(orangeCompleteRes.status === 200, 'POST /api/zone/complete for Orange Zone returns 200 OK');

    // 14.6 Red Zone completion via /api/red/complete
    const redCompleteRes = await fetch(`${baseUrl}/api/red/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://red-five-liart.vercel.app',
        Cookie: sessionCookie
      }
    });
    assert(redCompleteRes.status === 200, 'POST /api/red/complete returns 200 OK');
    const redCompleteJson = await redCompleteRes.json();
    assert(redCompleteJson.ok === true, 'Red completion acknowledged');
    const purpleZoneState = redCompleteJson.bootstrap?.zones?.find(z => z.id === 'purple');
    assert(purpleZoneState?.unlocked === true, 'Purple Zone unlocked following Red Zone completion');

  } catch (err) {
    console.error('Test Suite Exception:', err);
    testFailed++;
  } finally {
    // Reset TECHTEAM10328 back to pristine starting state
    await supabase.from('score_ledger').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('dataset_entitlements').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('ml_submissions').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('team_sessions').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('zone_progress').delete().eq('team_id', 'TECHTEAM10328');
    await supabase.from('zone_progress').insert([
      { team_id: 'TECHTEAM10328', zone_id: 'sanctuary', status: 'completed', unlocked_at: new Date().toISOString() },
      { team_id: 'TECHTEAM10328', zone_id: 'yellow', status: 'available', unlocked_at: new Date().toISOString() },
      { team_id: 'TECHTEAM10328', zone_id: 'blue', status: 'locked' },
      { team_id: 'TECHTEAM10328', zone_id: 'orange', status: 'locked' },
      { team_id: 'TECHTEAM10328', zone_id: 'red', status: 'locked' },
      { team_id: 'TECHTEAM10328', zone_id: 'purple', status: 'locked' }
    ]);
    server.close();
    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${testPassed} PASSED, ${testFailed} FAILED`);
    console.log('====================================================');
    process.exit(testFailed > 0 ? 1 : 0);
  }
}

runTests();
