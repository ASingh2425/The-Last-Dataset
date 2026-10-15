process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'two-player-e2e-session-secret-key-min-32-chars';

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
  const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'sample_predictions.csv');
  if (fs.existsSync(fixturePath)) {
    return fs.readFileSync(fixturePath, 'utf8');
  }
  return getSampleCsv(0.85);
}

test('Two-Player Synchronized End-to-End Game Lifecycle: 3,100 pts & Permanent Lock', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-2p-e2e-'));
  const dataFile = path.join(dir, 'progress.json');
  const server = createHubServer({
    baseDir: ROOT,
    dataFile,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET,
      DISABLE_SUPABASE: 'true',
      ENABLE_DEV_TOOLS: 'true'
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const teamId = 'DUO-TEAM-01';
  const teamName = 'Duo Survivors';

  // 1. Player 1 registers
  const p1Reg = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, teamName, delegateId: 'OPERATOR-ALPHA' })
  });
  assert.equal(p1Reg.status, 200, 'Player 1 registration succeeds');
  const cookie1 = p1Reg.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie1, 'Player 1 receives session cookie');

  // 2. Player 2 registers on the same team from a distinct browser
  const p2Reg = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, teamName, delegateId: 'OPERATOR-BETA' })
  });
  assert.equal(p2Reg.status, 200, 'Player 2 registration succeeds');
  const cookie2 = p2Reg.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie2, 'Player 2 receives distinct session cookie');
  assert.notEqual(cookie1, cookie2, 'Player 1 and Player 2 have distinct session cookies');

  // 3. Player 3 attempts registration -> rejected by team cap (400 TEAM_CAP_EXCEEDED)
  const p3Reg = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, teamName, delegateId: 'OPERATOR-GAMMA' })
  });
  assert.equal(p3Reg.status, 400, 'Player 3 registration rejected');
  const p3Json = await p3Reg.json();
  assert.equal(p3Json.error, 'TEAM_CAP_EXCEEDED');

  // 4. Player 1 clears Sanctuary safe zone (100 pts)
  const sancRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
    body: JSON.stringify({ zoneId: 'sanctuary' })
  });
  assert.equal(sancRes.status, 200, 'Sanctuary clearance succeeds');
  const sancJson = await sancRes.json();
  assert.equal(sancJson.bootstrap.score.total, 100, 'Sanctuary awards canonical 100 points');

  // Verify Player 2 immediately sees 100 points upon refresh
  const bootP2AfterSanc = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie2 } });
  const p2JsonAfterSanc = await bootP2AfterSanc.json();
  assert.equal(p2JsonAfterSanc.score.total, 100, 'Player 2 sees 100 points after Player 1 clears Sanctuary');
  assert.equal(p2JsonAfterSanc.zones.find(z => z.id === 'yellow').unlocked, true, 'Yellow zone is unlocked for Player 2');

  // 5. Progression through Yellow (200), Blue (4x100 = 400), Orange (600), Red (800)
  // Players alternate solves to prove true multiplayer state synchronization
  const stages = [
    { zone: 'yellow', ctfs: [{ id: 'yellow-01', cookie: cookie1 }], clearCookie: cookie1, expectedScore: 300 },
    {
      zone: 'blue',
      ctfs: [
        { id: 'blue-zone-ctf-01', cookie: cookie1 },
        { id: 'blue-zone-ctf-02', cookie: cookie2 },
        { id: 'blue-zone-ctf-03', cookie: cookie1 },
        { id: 'blue-zone-ctf-04', cookie: cookie2 }
      ],
      clearCookie: cookie2,
      expectedScore: 700
    },
    { zone: 'orange', ctfs: [{ id: 'orange-01', cookie: cookie1 }], clearCookie: cookie1, expectedScore: 1300 },
    { zone: 'red', ctfs: [{ id: 'red-01', cookie: cookie2 }], clearCookie: cookie2, expectedScore: 2100 }
  ];

  for (const stage of stages) {
    for (const ctf of stage.ctfs) {
      const solveRes = await fetch(`${baseUrl}/api/dev/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ctf.cookie },
        body: JSON.stringify({ ctfId: ctf.id })
      });
      assert.equal(solveRes.status, 200, `Solve ${ctf.id} succeeds`);
    }

    const clearRes = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: stage.clearCookie },
      body: JSON.stringify({ zoneId: stage.zone })
    });
    assert.equal(clearRes.status, 200, `Clear ${stage.zone} succeeds`);
    const clearJson = await clearRes.json();
    assert.equal(clearJson.bootstrap.score.total, stage.expectedScore, `Score equals ${stage.expectedScore} after ${stage.zone}`);
  }

  // 6. Pre-Purple Check: Score is exactly 2,100 points across both players
  const p1BootPrePurple = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie1 } })).json();
  const p2BootPrePurple = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie2 } })).json();
  assert.equal(p1BootPrePurple.score.total, 2100, 'Player 1 has exactly 2,100 pts entering Purple');
  assert.equal(p2BootPrePurple.score.total, 2100, 'Player 2 has exactly 2,100 pts entering Purple');
  assert.equal(p1BootPrePurple.ml.escapeUnlocked, false, 'Escape gate locked');
  assert.equal(p2BootPrePurple.ml.escapeUnlocked, false, 'Escape gate locked');

  // Verify all 4 sector datasets are in earned datasets
  const allEarnedDatasets = ['community_final', 'radio_final', 'forensics_final', 'research_final'];
  for (const ds of allEarnedDatasets) {
    assert.ok(p1BootPrePurple.datasets.includes(ds), `Dataset ${ds} must be earned after clearing all 4 zones`);
  }

  // 7. Verify all 6 datasets are downloadable in Purple zone and on the central main page after clearing yellow, blue, orange, and red zones
  const datasetsToVerify = [
    'community_final',
    'radio_final',
    'forensics_final',
    'research_final',
    'train',
    'sample_submission'
  ];
  for (const dsKey of datasetsToVerify) {
    const dsRes = await fetch(`${baseUrl}/api/dataset/${dsKey}`, { headers: { Cookie: cookie1 } });
    assert.equal(dsRes.status, 200, `Dataset ${dsKey} is downloadable via session cookie`);
    const content = await dsRes.text();
    assert.ok(content.length > 50, `Dataset ${dsKey} has non-empty content`);

    // Also verify downloading via team query param as used when navigating to purple zone
    const dsParamRes = await fetch(`${baseUrl}/api/dataset/${dsKey}?team=${p1BootPrePurple.team.id}`);
    assert.equal(dsParamRes.status, 200, `Dataset ${dsKey} is downloadable via team parameter in Purple Zone`);
  }

  // 8. Player 1 submits non-qualifying predictions (R² ~ 0.50 < 0.80)
  const lowEval = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
    body: JSON.stringify({ csvContent: getSampleCsv(0.5) })
  });
  assert.equal(lowEval.status, 200);
  const lowJson = await lowEval.json();
  assert.equal(lowJson.qualifiesForEscape, false, 'Low model does not qualify');
  assert.equal(lowJson.submissionsUsed, 1, '1 submission attempt recorded');
  assert.equal(lowJson.submissionsRemaining, 9, '9 attempts remaining');

  // Player 2 checks submissions and quota -> synchronized!
  const p2SubRes = await fetch(`${baseUrl}/api/ml/submissions`, { headers: { Cookie: cookie2 } });
  const p2SubJson = await p2SubRes.json();
  assert.equal(p2SubJson.submissionsUsed, 1, 'Player 2 observes attempt used by Player 1');
  assert.equal(p2SubJson.submissionsRemaining, 9);

  // 9. Player 2 submits winning predictions (R² >= 0.80)
  const winEval = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
    body: JSON.stringify({ csvContent: getWinningCsv() })
  });
  assert.equal(winEval.status, 200);
  const winJson = await winEval.json();
  assert.equal(winJson.qualifiesForEscape, true, 'Winning model qualifies for escape');
  assert.equal(winJson.submissionsUsed, 2, '2 attempts used total');

  // 10. Post-Qualification Authority Check: Both players verified at strictly 3,100 pts
  const p1Final = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie1 } })).json();
  const p2Final = await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie2 } })).json();

  assert.equal(p1Final.score.total, 3100, 'Player 1 has exactly 3,100 points (2,100 + 1,000)');
  assert.equal(p2Final.score.total, 3100, 'Player 2 has exactly 3,100 points (2,100 + 1,000)');
  assert.equal(p1Final.ml.escapeUnlocked, true, 'Escape unlocked for Player 1');
  assert.equal(p2Final.ml.escapeUnlocked, true, 'Escape unlocked for Player 2');
  assert.equal(p1Final.zones.find(z => z.id === 'purple').state, 'cleared');
  assert.equal(p2Final.zones.find(z => z.id === 'purple').state, 'cleared');

  // 11. Permanent Submission Lock: Future submissions by EITHER teammate are blocked (429 PURPLE_ALREADY_COMPLETED)
  const p1LockAttempt = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
    body: JSON.stringify({ csvContent: getWinningCsv() })
  });
  assert.equal(p1LockAttempt.status, 429, 'Player 1 permanently locked from further ML submissions');
  assert.equal((await p1LockAttempt.json()).error, 'PURPLE_ALREADY_COMPLETED');

  const p2LockAttempt = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
    body: JSON.stringify({ csvContent: getWinningCsv() })
  });
  assert.equal(p2LockAttempt.status, 429, 'Player 2 permanently locked from further ML submissions');
  assert.equal((await p2LockAttempt.json()).error, 'PURPLE_ALREADY_COMPLETED');

  // 12. Leaderboard Audit
  const leadRes = await fetch(`${baseUrl}/api/leaderboard`);
  const leadJson = await leadRes.json();
  const teamOnBoard = leadJson.leaderboard.find(t => t.team_id === teamId);
  assert.ok(teamOnBoard, 'Team is listed on leaderboard');
  assert.equal(teamOnBoard.total_score, 3100, 'Team recorded with exactly 3,100 points on live leaderboard');
  assert.equal(teamOnBoard.escape_unlocked, true, 'Team marked escape_unlocked on live leaderboard');
});
