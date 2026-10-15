process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'security-audit-secret-key-that-is-at-least-32-chars';

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

function getPerfectCsv() {
  const answersPath = process.env.GROUND_TRUTH_PATH || process.env.PRIVATE_ANSWERS_PATH || path.join(ROOT, 'server_data', 'private_answers.csv');
  if (fs.existsSync(answersPath)) {
    return fs.readFileSync(answersPath, 'utf8');
  }
  const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'sample_predictions.csv');
  if (fs.existsSync(fixturePath)) {
    return fs.readFileSync(fixturePath, 'utf8');
  }
  return getSampleCsv(0.85);
}

async function withAuditServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-sec-audit-'));
  const dataFile = path.join(dir, 'progress.json');
  const server = createHubServer({
    baseDir: ROOT,
    dataFile,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET,
      DISABLE_SUPABASE: 'true',
      ENABLE_DEV_TOOLS: 'true',
      ADMIN_KEY: 'test-admin-secret-key-2026'
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { baseUrl, server };
}

test('Security Audit 1: Spoofed x-team-id without session returns 401 on evaluate and zone complete', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // 1. Evaluate with spoofed header
  const evalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-team-id': 'VICTIM_TEAM'
    },
    body: JSON.stringify({ csvContent: getSampleCsv() })
  });
  assert.equal(evalRes.status, 401, 'Unauthenticated eval with x-team-id header must return 401');
  const evalData = await evalRes.json();
  assert.equal(evalData.error, 'AUTH_REQUIRED');

  // 2. Zone completion with spoofed header
  const zoneRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-team-id': 'VICTIM_TEAM'
    },
    body: JSON.stringify({ zoneId: 'yellow' })
  });
  assert.equal(zoneRes.status, 401, 'Unauthenticated zone completion with x-team-id must return 401');

  // 3. Submissions query with spoofed header
  const subsRes = await fetch(`${baseUrl}/api/ml/submissions`, {
    headers: { 'x-team-id': 'VICTIM_TEAM' }
  });
  assert.equal(subsRes.status, 401, 'Unauthenticated ml submissions query must return 401');

  // 4. Team progress query with spoofed header
  const progRes = await fetch(`${baseUrl}/api/team/progress?team=VICTIM_TEAM`, {
    headers: { 'x-team-id': 'VICTIM_TEAM' }
  });
  assert.equal(progRes.status, 401, 'Unauthenticated team progress query must return 401');
});

test('Security Audit 2: Authenticated Team A cannot pass body.teamId or x-team-id to consume Team B quota', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // Register Team A
  const regARes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'ATTACKER-A', teamName: 'Attacker Team' })
  });
  assert.equal(regARes.status, 200);
  const cookieA = regARes.headers.get('set-cookie')?.split(';')[0];

  // Register Team B
  const regBRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'VICTIM-B', teamName: 'Victim Team' })
  });
  assert.equal(regBRes.status, 200);
  const cookieB = regBRes.headers.get('set-cookie')?.split(';')[0];

  // Team A submits but passes body.teamId = 'VICTIM-B' and header x-team-id: VICTIM-B
  const evalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-team-id': 'VICTIM-B',
      Cookie: cookieA
    },
    body: JSON.stringify({
      teamId: 'VICTIM-B',
      csvContent: getSampleCsv()
    })
  });
  assert.equal(evalRes.status, 200);
  const evalJson = await evalRes.json();
  assert.equal(evalJson.submissionsUsed, 1, 'Team A used 1 attempt');

  // Verify Team B's submission count is STILL 0
  const subBRes = await fetch(`${baseUrl}/api/ml/submissions`, {
    headers: { Cookie: cookieB }
  });
  assert.equal(subBRes.status, 200);
  const subBJson = await subBRes.json();
  assert.equal(subBJson.submissionsUsed, 0, "Victim Team B quota must remain untouched (0/10)");
  assert.equal(subBJson.submissionsRemaining, 10);
});

test('Security Audit 3: Parallel quota race: 5 simultaneous submissions at attempt 9 result in exactly 1 success and 4 rejections with 429', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // Register Team
  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'CONCURRENCY-TEAM', teamName: 'Speed Racers' })
  });
  assert.equal(regRes.status, 200);
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  const validCsv = getSampleCsv();

  // Burn 9 attempts sequentially
  for (let i = 1; i <= 9; i++) {
    const res = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ csvContent: validCsv })
    });
    assert.equal(res.status, 200, `Sequential attempt ${i}/10 must succeed`);
  }

  // Now 1 attempt remains. Send 5 simultaneous requests in parallel!
  const parallelRequests = Array.from({ length: 5 }, () =>
    fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ csvContent: validCsv })
    })
  );

  const responses = await Promise.all(parallelRequests);
  const statuses = responses.map((r) => r.status);
  const successes = statuses.filter((s) => s === 200).length;
  const rejected429 = statuses.filter((s) => s === 429).length;

  assert.equal(successes, 1, 'Exactly ONE parallel submission must succeed when 1 slot remains');
  assert.equal(rejected429, 4, 'Exactly FOUR parallel submissions must be rejected with HTTP 429');

  // Verify total submissions in store is exactly 10
  const historyRes = await fetch(`${baseUrl}/api/ml/submissions`, {
    headers: { Cookie: cookie }
  });
  const historyJson = await historyRes.json();
  assert.equal(historyJson.submissionsUsed, 10, 'Submissions used must be strictly 10');
  assert.equal(historyJson.submissionsRemaining, 0, 'Submissions remaining must be strictly 0');
});

test('Security Audit 4: Static file traversal to /server_data/private_answers.csv and /.env returns 404/403', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const pathsToTest = [
    '/server_data/private_answers.csv',
    '/.env',
    '/package.json',
    '/../server_data/private_answers.csv',
    '/..%2fserver_data%2fprivate_answers.csv',
    '/lib/hub.js'
  ];

  for (const testPath of pathsToTest) {
    const res = await fetch(baseUrl + testPath);
    assert.ok(
      res.status === 404 || res.status === 403,
      `Request to sensitive path ${testPath} must return 404 or 403 (got ${res.status})`
    );
    const text = await res.text();
    assert.ok(
      !text.includes('Sanctuary_ID,Survival_Probability') && !text.includes('SUPABASE_SERVICE_ROLE_KEY'),
      `Sensitive path ${testPath} must never disclose server content`
    );
  }
});

test('Security Audit 5: Direct zone completion bypass without prerequisite returns 403', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'BYPASS-TEAM', teamName: 'Bypass Crew' })
  });
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  // Try to complete Blue directly without completing Sanctuary or Yellow first
  const blueBypass = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'blue' })
  });
  assert.equal(blueBypass.status, 403, 'Clearing Blue zone before Yellow must return 403');
  const blueJson = await blueBypass.json();
  assert.equal(blueJson.error, 'PREREQUISITE_NOT_MET');

  // Try to complete Red directly without completing Orange first
  const redBypass = await fetch(`${baseUrl}/api/red/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }
  });
  assert.equal(redBypass.status, 403, 'Clearing Red zone before Orange must return 403');
  const redJson = await redBypass.json();
  assert.equal(redJson.error, 'PREREQUISITE_NOT_MET');
});

test('Security Audit 6: Purple zone completion without qualifying R2 >= 0.80 ML submission returns 403', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'PURPLE-TEAM', teamName: 'Purple Aspirants' })
  });
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  // Clear Sanctuary legitimately (no challenges required)
  const sancRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'sanctuary' })
  });
  assert.equal(sancRes.status, 200, 'Clearing Sanctuary must succeed');

  // Verify that attempting to clear Yellow without yellow-01 returns 403 CHALLENGES_INCOMPLETE
  const yellowIncompleteRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'yellow' })
  });
  assert.equal(yellowIncompleteRes.status, 403, 'Yellow zone clear without solving yellow-01 must return 403');
  const yellowIncompleteJson = await yellowIncompleteRes.json();
  assert.equal(yellowIncompleteJson.error, 'CHALLENGES_INCOMPLETE');

  // Solve Yellow
  await fetch(`${baseUrl}/api/dev/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ctfId: 'yellow-01' })
  });
  await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'yellow' })
  });

  // Verify Blue requires all 4 CTFs: solve only 3 of 4
  for (const ctfId of ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03']) {
    const sRes = await fetch(`${baseUrl}/api/dev/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ctfId })
    });
    assert.equal(sRes.status, 200, `Solving ${ctfId} must succeed`);
  }
  const blueIncomplete = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'blue' })
  });
  assert.equal(blueIncomplete.status, 403, 'Blue must remain incomplete when only 3 of 4 CTFs are solved');
  const blueIncompleteJson = await blueIncomplete.json();
  assert.equal(blueIncompleteJson.error, 'CHALLENGES_INCOMPLETE');

  // Solve 4th CTF and clear Blue
  const s4Res = await fetch(`${baseUrl}/api/dev/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ctfId: 'blue-zone-ctf-04' })
  });
  assert.equal(s4Res.status, 200, 'Solving blue-zone-ctf-04 must succeed');
  const blueClear = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'blue' })
  });
  assert.equal(blueClear.status, 200, 'Blue must clear after all 4 CTFs are solved');

  // Clear Orange and Red
  for (const [zone, ctfId] of [
    ['orange', 'orange-01'],
    ['red', 'red-01']
  ]) {
    const solveRes = await fetch(`${baseUrl}/api/dev/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ctfId })
    });
    assert.equal(solveRes.status, 200, `Solving ${ctfId} must succeed`);

    const clearRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ zoneId: zone })
    });
    assert.equal(clearRes.status, 200, `Clearing sector ${zone} must succeed`);
  }

  // Now Red is complete. Attempt to clear Purple directly without an approved ML submission
  const purpleDirectRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'purple' })
  });
  assert.equal(purpleDirectRes.status, 403, 'Purple zone complete without qualifying submission must return 403');
  const purpleJson = await purpleDirectRes.json();
  assert.equal(purpleJson.error, 'PREREQUISITE_NOT_MET');

  // Now submit an ML submission with poor score (R2 ~ 0.50 < 0.80)
  const lowScoreRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: getSampleCsv(0.5) })
  });
  assert.equal(lowScoreRes.status, 200);
  const lowScoreJson = await lowScoreRes.json();
  assert.equal(lowScoreJson.qualifiesForEscape, false);

  // Still cannot clear Purple
  const purpleAfterLowRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'purple' })
  });
  assert.equal(purpleAfterLowRes.status, 403, 'Purple zone complete with non-qualifying submission must return 403');

  // Submit winning ML submission
  const winningCsv = getPerfectCsv();
  const winScoreRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: winningCsv })
  });
  assert.equal(winScoreRes.status, 200);
  const winScoreJson = await winScoreRes.json();
  assert.ok(winScoreJson.qualifiesForEscape, 'Winning model qualifies for escape');

  // Purple zone can now be verified complete
  const bootRes = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { Cookie: cookie }
  });
  const bootJson = await bootRes.json();
  assert.ok(bootJson.ml.escapeUnlocked, 'Escape Gate must be unlocked');
});

test('Security Audit 7: Permanent ML submission lock: once qualified for escape, future submissions return 429 PURPLE_ALREADY_COMPLETED', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'LOCKED-TEAM', teamName: 'Locked Out' })
  });
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  // Submit qualifying winning ML submission
  const winningCsv = getPerfectCsv();
  const winRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: winningCsv })
  });
  assert.equal(winRes.status, 200);

  // Subsequent submission attempt must be rejected with 429 PURPLE_ALREADY_COMPLETED
  const secondRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: winningCsv })
  });
  assert.equal(secondRes.status, 429, 'Further submissions after escape must return 429');
  const secondJson = await secondRes.json();
  assert.equal(secondJson.error, 'PURPLE_ALREADY_COMPLETED');
});

test('Security Audit 8: Hard 2-player team cap prevents 3rd member registration with 400 TEAM_CAP_EXCEEDED', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // Player 1 registers
  const p1Res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'ROSTER-TEAM', delegateId: 'PLAYER-1', teamName: 'Duo Squad' })
  });
  assert.equal(p1Res.status, 200);

  // Player 2 registers
  const p2Res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'ROSTER-TEAM', delegateId: 'PLAYER-2' })
  });
  assert.equal(p2Res.status, 200);

  // Player 3 attempts to register to the same team
  const p3Res = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'ROSTER-TEAM', delegateId: 'PLAYER-3' })
  });
  assert.equal(p3Res.status, 400, '3rd member must be rejected with 400');
  const p3Json = await p3Res.json();
  assert.equal(p3Json.error, 'TEAM_CAP_EXCEEDED');
});

test('Security Audit 9: Canonical 3,100 points audit: total score matches exactly 3,100 points after full game clear', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'PERFECT-TEAM', teamName: 'Grand Champions' })
  });
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  // 1. Clear Sanctuary -> 100 pts
  await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'sanctuary' })
  });

  // 2. Solve & Clear Yellow (200), Blue (4x100 = 400), Orange (600), Red (800)
  for (const item of [
    { zone: 'yellow', ctfs: ['yellow-01'] },
    { zone: 'blue', ctfs: ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04'] },
    { zone: 'orange', ctfs: ['orange-01'] },
    { zone: 'red', ctfs: ['red-01'] }
  ]) {
    for (const ctf of item.ctfs) {
      await fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ ctfId: ctf })
      });
    }
    await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ zoneId: item.zone })
    });
  }

  // 3. Clear Purple -> 1,000 pts
  await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: getPerfectCsv() })
  });

  // Check authoritative score
  const bootRes = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { Cookie: cookie }
  });
  const bootJson = await bootRes.json();
  assert.equal(bootJson.score.total, 3100, 'Total score must equal exactly 3,100 points (100+200+400+600+800+1000)');
});

test('Security Audit 10: Admin overview route requires x-admin-key authentication and returns full team matrix', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // 1. Without admin key -> 401
  const unauthRes = await fetch(`${baseUrl}/api/admin/overview`);
  assert.equal(unauthRes.status, 401, 'Admin overview without key must return 401');

  // 2. With wrong key -> 401
  const wrongKeyRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { 'x-admin-key': 'incorrect-key' }
  });
  assert.equal(wrongKeyRes.status, 401, 'Admin overview with wrong key must return 401');

  // 3. With valid key -> 200
  const adminRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { 'x-admin-key': 'test-admin-secret-key-2026' }
  });
  assert.equal(adminRes.status, 200, 'Admin overview with valid key must return 200');
  const adminJson = await adminRes.json();
  assert.equal(adminJson.ok, true);
  assert.equal(adminJson.totalPointsPossible, 3100);
  assert.ok(Array.isArray(adminJson.teams));
});

test('Security Audit 11: End-to-end qualifying ML submission -> permanent lock -> purple completion -> idempotent 1,000 pt award', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'E2E-CHAMPS', teamName: 'End To End Champions' })
  });
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  // 1. Clear Sanctuary (100)
  await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'sanctuary' })
  });

  // 2. Solve & Clear Yellow (200), Blue (4x100 = 400), Orange (600), Red (800)
  for (const item of [
    { zone: 'yellow', ctfs: ['yellow-01'] },
    { zone: 'blue', ctfs: ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04'] },
    { zone: 'orange', ctfs: ['orange-01'] },
    { zone: 'red', ctfs: ['red-01'] }
  ]) {
    for (const ctf of item.ctfs) {
      await fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ ctfId: ctf })
      });
    }
    await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ zoneId: item.zone })
    });
  }

  // Pre-Purple state check: score must be exactly 2,100 pts
  let bootRes = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } });
  let bootJson = await bootRes.json();
  assert.equal(bootJson.score.total, 2100, 'Score before purple must be exactly 2,100 pts');
  assert.equal(bootJson.ml.escapeUnlocked, false, 'Escape gate must not be unlocked before qualifying ML');
  const purpleZoneBefore = bootJson.zones.find((z) => z.id === 'purple');
  assert.notEqual(purpleZoneBefore?.state, 'cleared', 'Purple must not be cleared before qualifying ML');

  // 3. Submit winning ML model (R2 >= 0.80)
  const evalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: getPerfectCsv() })
  });
  assert.equal(evalRes.status, 200);
  const evalJson = await evalRes.json();
  assert.ok(evalJson.qualifiesForEscape, 'Winning model must qualify for escape');
  const evalId = evalJson.evaluationId;

  // 4. Server authoritative state: purple complete, escape unlocked, exactly 3,100 pts
  bootRes = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } });
  bootJson = await bootRes.json();
  assert.equal(bootJson.score.total, 3100, 'Total score must equal exactly 3,100 pts (2100 + 1000)');
  assert.equal(bootJson.ml.escapeUnlocked, true, 'Escape gate must be authoritatively unlocked');
  const purpleZoneAfter = bootJson.zones.find((z) => z.id === 'purple');
  assert.equal(purpleZoneAfter?.state, 'cleared', 'Purple zone must be authoritatively marked cleared');

  // 5. Permanent submission lock: subsequent attempt MUST return 429 PURPLE_ALREADY_COMPLETED
  const secondEvalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: getSampleCsv() })
  });
  assert.equal(secondEvalRes.status, 429, 'Submissions after qualification must be permanently locked');
  const secondEvalJson = await secondEvalRes.json();
  assert.equal(secondEvalJson.error, 'PURPLE_ALREADY_COMPLETED');

  // 6. Idempotency test: manual duplicate call to /api/zone/complete for purple cannot double-award
  await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'purple' })
  });
  bootRes = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } });
  bootJson = await bootRes.json();
  assert.equal(bootJson.score.total, 3100, 'Duplicate zone complete must not increase score beyond 3,100');

  // 7. Idempotency test: reconcile call cannot double-award points
  const reconcileRes = await fetch(`${baseUrl}/api/ml/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ evaluationId: evalId })
  });
  assert.equal(reconcileRes.status, 200);
  bootRes = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } });
  bootJson = await bootRes.json();
  assert.equal(bootJson.score.total, 3100, 'Reconcile must preserve canonical 3,100 total score');
});

test('Security Audit 12: Production evaluator strictly fails closed without fixture fallback when ground truth is absent', async (t) => {
  const { evaluateSubmission, _resetGroundTruth } = require('../lib/evaluator');
  const prevEnv = process.env.NODE_ENV;
  const prevBase64 = process.env.PRIVATE_ANSWERS_BASE64;
  const prevPath = process.env.PRIVATE_ANSWERS_PATH;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PRIVATE_ANSWERS_BASE64;
    process.env.PRIVATE_ANSWERS_PATH = '/path/to/missing/private_answers.csv';
    _resetGroundTruth();

    const result = evaluateSubmission('Sanctuary_ID,Survival_Probability\nSANC-0091,0.5');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('SCORING_ARBITER_UNAVAILABLE'), 'Must return SCORING_ARBITER_UNAVAILABLE in production without fixture fallback');
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevBase64) process.env.PRIVATE_ANSWERS_BASE64 = prevBase64;
    else delete process.env.PRIVATE_ANSWERS_BASE64;
    if (prevPath) process.env.PRIVATE_ANSWERS_PATH = prevPath;
    else delete process.env.PRIVATE_ANSWERS_PATH;
    _resetGroundTruth();
  }
});

test('Security Audit 13: CORS allowlist strictly rejects unapproved origins including spoofed Vercel hostnames', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const unapprovedOrigins = [
    'https://attacker-yellow.vercel.app',
    'https://evil-manu.vercel.app',
    'https://yellow-attacker.vercel.app',
    'https://phishing.com',
    'https://random.vercel.app'
  ];

  for (const origin of unapprovedOrigins) {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: origin }
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null, `Must not send CORS allow header to ${origin}`);

    // State-changing requests must be strictly rejected with 403 ORIGIN_REJECTED
    const postRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoneId: 'yellow' })
    });
    assert.equal(postRes.status, 403, `Must reject state-changing request from ${origin} with 403`);
    const json = await postRes.json();
    assert.equal(json.error, 'ORIGIN_REJECTED');
  }

  // Approved origin receives CORS headers and is allowed
  const approvedRes = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://purplezone-frontend.vercel.app' }
  });
  assert.equal(approvedRes.headers.get('access-control-allow-origin'), 'https://purplezone-frontend.vercel.app');
  assert.equal(approvedRes.headers.get('access-control-allow-credentials'), 'true');
});

test('Security Audit 14: Trusted zone launch token requires authentication, validates unlock state, and signs verifiable token', async (t) => {
  const { baseUrl } = await withAuditServer(t);
  const { verifyLaunchToken } = require('../lib/security');

  // 1. Unauthenticated request must return 401
  const unauthRes = await fetch(`${baseUrl}/api/zone/launch?zoneId=yellow`);
  assert.equal(unauthRes.status, 401, 'Unauthenticated zone launch must return 401');

  // 2. Register team
  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'LAUNCH-TEST-01', teamName: 'Launch Team', delegateId: 'OP1' })
  });
  assert.equal(regRes.status, 200);
  const cookie = regRes.headers.get('set-cookie');

  // 3. Request launch for locked zone (Blue is locked before Yellow completes)
  const lockedRes = await fetch(`${baseUrl}/api/zone/launch?zoneId=blue`, {
    headers: { Cookie: cookie }
  });
  assert.equal(lockedRes.status, 403, 'Requesting launch token for locked zone must return 403');
  const lockedJson = await lockedRes.json();
  assert.equal(lockedJson.error, 'ZONE_LOCKED');

  // 4. Request launch for available zone (Yellow)
  const yellowRes = await fetch(`${baseUrl}/api/zone/launch?zoneId=yellow`, {
    headers: { Cookie: cookie }
  });
  assert.equal(yellowRes.status, 200, 'Requesting launch token for unlocked zone must return 200');
  const yellowJson = await yellowRes.json();
  assert.equal(yellowJson.ok, true);
  assert.ok(yellowJson.launchToken, 'Must return signed launchToken');
  assert.ok(yellowJson.targetUrl.includes(encodeURIComponent(yellowJson.launchToken)), 'Target URL must include encoded launchToken');

  // 5. Verify cryptographic validity of launchToken
  const verified = verifyLaunchToken(yellowJson.launchToken, SESSION_SECRET);
  assert.ok(verified, 'Launch token must verify with SESSION_SECRET');
  assert.equal(verified.teamId, 'LAUNCH-TEST-01');
  assert.equal(verified.delegateId, 'LEADER');
  assert.equal(verified.zoneId, 'yellow');
  assert.ok(verified.exp > Date.now(), 'Token exp must be in the future');

  // 6. Token with forged payload must fail verification
  const parts = yellowJson.launchToken.split('.');
  const forgedToken = `${parts[0]} forged.${parts[1]}`;
  assert.equal(verifyLaunchToken(forgedToken, SESSION_SECRET), null, 'Forged token must fail verification');
});


