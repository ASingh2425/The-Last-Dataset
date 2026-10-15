process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHubServer } = require('../lib/hub');
const { verifyLaunchToken, signLaunchToken } = require('../lib/security');

const ROOT = path.resolve(__dirname, '..');
const BLUEZONE_DIR = path.join(ROOT, 'repos', 'bluezone');
const SESSION_SECRET = 'the-last-dataset-2026-production-super-secret-key-32chars';

async function withHubAndBlueServers(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-bz-test-'));
  const dataFile = path.join(dir, 'progress.json');

  // 1. Start Hub Server
  const hubServer = createHubServer({
    baseDir: ROOT,
    dataFile,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET,
      DISABLE_SUPABASE: 'true',
      ENABLE_DEV_TOOLS: 'true',
      ADMIN_KEY: 'test-admin-secret-key-2026',
      CTF_SECRET_BLUE_01: 'manu_ctf_secret_blue_server_01_secure_key',
      CTF_SECRET_BLUE_02: 'manu_ctf_secret_blue_relay_02_secure_key',
      CTF_SECRET_BLUE_03: 'manu_ctf_secret_blue_vault_03_secure_key',
      CTF_SECRET_BLUE_04: 'manu_ctf_secret_blue_carrier_04_secure_key'
    }
  });

  await new Promise((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
  const hubPort = hubServer.address().port;
  const hubUrl = `http://127.0.0.1:${hubPort}`;

  // 2. Start Blue Zone Server via `next start`
  const bluePort = hubPort + 10;
  const blueEnv = {
    ...process.env,
    PORT: String(bluePort),
    CENTRAL_HUB_URL: hubUrl,
    SESSION_SECRET,
    CTF_SECRET_BLUE_01: 'manu_ctf_secret_blue_server_01_secure_key',
    CTF_SECRET_BLUE_02: 'manu_ctf_secret_blue_relay_02_secure_key',
    CTF_SECRET_BLUE_03: 'manu_ctf_secret_blue_vault_03_secure_key',
    CTF_SECRET_BLUE_04: 'manu_ctf_secret_blue_carrier_04_secure_key',
  };

  const blueProc = spawn('npx', ['next', 'start', '-p', String(bluePort)], {
    cwd: BLUEZONE_DIR,
    env: blueEnv,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const blueUrl = `http://127.0.0.1:${bluePort}`;

  // Wait for Blue Zone server to become ready
  let isReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${blueUrl}/api/session/verify`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 401 || res.status === 200) {
        isReady = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  assert.ok(isReady, 'Blue Zone Next.js server must become ready');

  t.after(async () => {
    try {
      if (process.platform === 'win32' && blueProc.pid) {
        require('node:child_process').execSync(`taskkill /pid ${blueProc.pid} /T /F`, { stdio: 'ignore' });
      } else {
        blueProc.kill('SIGKILL');
      }
    } catch {}
    await new Promise((resolve) => hubServer.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { hubUrl, blueUrl };
}

test('Blue Zone E2E: Trusted launch, server-side CTF verification, live sync & atomic scoring', async (t) => {
  const { hubUrl, blueUrl } = await withHubAndBlueServers(t);

  // 1. Unauthenticated flag submission to Blue Zone MUST be rejected with 401
  const unauthSubmit = await fetch(`${blueUrl}/api/ctf/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: 'blue-zone-ctf-01',
      answer: 'BLUEZONE{BLACKOUT-17}'
    })
  });
  assert.equal(unauthSubmit.status, 401, 'Unauthenticated CTF submission must return 401');

  // 2. Register team in Central Hub
  const regRes = await fetch(`${hubUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'TEST-BLUE-TEAM', teamName: 'Blue Remediators', delegateId: 'PLAYER_1' })
  });
  assert.equal(regRes.status, 200);
  const hubCookie = regRes.headers.get('set-cookie');

  // 2.5 Complete Sanctuary
  const sancRes = await fetch(`${hubUrl}/api/sanctuary/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: hubCookie }
  });
  assert.equal(sancRes.status, 200, 'Sanctuary must complete');

  // 3. Complete Yellow zone so Blue unlocks
  const ySolve = await fetch(`${hubUrl}/api/dev/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: hubCookie },
    body: JSON.stringify({ ctfId: 'yellow-01' })
  });
  assert.equal(ySolve.status, 200);

  const yClear = await fetch(`${hubUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: hubCookie },
    body: JSON.stringify({ zoneId: 'yellow' })
  });
  assert.equal(yClear.status, 200, 'Yellow zone must clear');

  // 4. Request trusted launch token from Hub for Blue Zone
  const launchRes = await fetch(`${hubUrl}/api/zone/launch?zoneId=blue`, {
    headers: { Cookie: hubCookie }
  });
  assert.equal(launchRes.status, 200, 'Hub must issue launch token for Blue');
  const launchData = await launchRes.json();
  assert.ok(launchData.launchToken, 'Must receive signed launchToken');

  // 5. Establish authenticated Blue Zone session using launchToken
  const sessionRes = await fetch(`${blueUrl}/api/session/verify?launchToken=${encodeURIComponent(launchData.launchToken)}`);
  assert.equal(sessionRes.status, 200, 'Blue Zone session verification must succeed');
  const sessionData = await sessionRes.json();
  assert.equal(sessionData.authenticated, true);
  assert.equal(sessionData.teamId, 'TEST-BLUE-TEAM');
  const blueCookie = sessionRes.headers.get('set-cookie');
  assert.ok(blueCookie, 'Blue Zone must set bz_session cookie');

  // 6. Test tampered / forged token is rejected
  const parts = launchData.launchToken.split('.');
  const forgedToken = `${parts[0]}.forged_sig_00000000000000000000000000000000`;
  const forgedRes = await fetch(`${blueUrl}/api/session/verify?launchToken=${encodeURIComponent(forgedToken)}`);
  assert.equal(forgedRes.status, 401, 'Forged launch token must return 401');

  // 7. Test wrong flag submission returns 200 with correct: false
  const wrongSubmit = await fetch(`${blueUrl}/api/ctf/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: blueCookie },
    body: JSON.stringify({
      challengeId: 'blue-zone-ctf-01',
      answer: 'BLUEZONE{WRONG-GUESS}'
    })
  });
  assert.equal(wrongSubmit.status, 200);
  const wrongJson = await wrongSubmit.json();
  assert.equal(wrongJson.correct, false);
  assert.ok(wrongJson.message.includes('ROUTE REJECTED'), 'Must return specific feedback');

  // 8. Verify each of the 4 canonical CTFs in order
  const canonicalSolves = [
    { id: 'blue-zone-ctf-01', flag: 'BLUEZONE{BLACKOUT-17}', rewardProp: 'recoveredFragment' },
    { id: 'blue-zone-ctf-02', flag: 'BLUEZONE{SILENT_RELAY}', rewardProp: 'route' },
    { id: 'blue-zone-ctf-03', flag: 'BLUEZONE{NORTHLIGHT}', rewardProp: 'recoveredFragment' },
    { id: 'blue-zone-ctf-04', flag: 'BLUEZONE{KAPU_LIGHTHOUSE}', rewardProp: 'recoveredFragment' }
  ];

  for (const { id, flag, rewardProp } of canonicalSolves) {
    const solveRes = await fetch(`${blueUrl}/api/ctf/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: blueCookie },
      body: JSON.stringify({ challengeId: id, answer: flag })
    });
    assert.equal(solveRes.status, 200, `Solving ${id} must succeed`);
    const solveJson = await solveRes.json();
    assert.equal(solveJson.correct, true, `${id} must be verified as correct`);
    assert.ok(solveJson.reward, `${id} must return reward`);
    assert.ok(solveJson.reward[rewardProp], `${id} reward must contain expected properties`);
  }

  // 9. Teammate live sync: Player 2 checks progress on Blue Zone
  const progressRes = await fetch(`${blueUrl}/api/progress`, {
    headers: { Cookie: blueCookie }
  });
  assert.equal(progressRes.status, 200);
  const progressData = await progressRes.json();
  assert.equal(progressData.solvedChallenges.length, 4, 'All 4 CTFs must be solved in progress sync');
  assert.ok(progressData.solvedChallenges.includes('blue-zone-ctf-01'));
  assert.ok(progressData.solvedChallenges.includes('blue-zone-ctf-02'));
  assert.ok(progressData.solvedChallenges.includes('blue-zone-ctf-03'));
  assert.ok(progressData.solvedChallenges.includes('blue-zone-ctf-04'));

  // 10. Check Central Hub score: 4 CTFs x 100 pts = 400 pts (Sanctuary 100 + Yellow 200 + Blue 400 = 700 pts total)
  const bootstrapRes = await fetch(`${hubUrl}/api/bootstrap`, {
    headers: { Cookie: hubCookie }
  });
  const bootstrap = await bootstrapRes.json();
  assert.equal(bootstrap.score.total, 700, 'Team score must be 700 (Sanctuary 100 + Yellow 200 + Blue 400)');

  // 11. Final Emergency Broadcast answer verification
  const wrongBroadcast = await fetch(`${blueUrl}/api/broadcast/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: blueCookie },
    body: JSON.stringify({ answer: 'WRONG' })
  });
  assert.equal(wrongBroadcast.status, 200);
  const wrongBcJson = await wrongBroadcast.json();
  assert.equal(wrongBcJson.correct, false);

  const correctBroadcast = await fetch(`${blueUrl}/api/broadcast/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: blueCookie },
    body: JSON.stringify({ answer: 'BLUEZONE' })
  });
  assert.equal(correctBroadcast.status, 200);
  const correctBcJson = await correctBroadcast.json();
  assert.equal(correctBcJson.correct, true);

  // 12. Dataset download is now accessible
  const datasetRes = await fetch(`${blueUrl}/api/broadcast/dataset`, {
    headers: { Cookie: blueCookie }
  });
  assert.equal(datasetRes.status, 200, 'Dataset download must succeed');
  assert.equal(datasetRes.headers.get('content-type'), 'text/csv; charset=utf-8');
  const csvContent = await datasetRes.text();
  assert.ok(csvContent.includes('Sanctuary_ID'), 'Dataset must contain Sanctuary_ID header');

  // 13. Verify Central Hub unlocked Orange Zone
  const postClearBootstrapRes = await fetch(`${hubUrl}/api/bootstrap`, {
    headers: { Cookie: hubCookie }
  });
  const postClear = await postClearBootstrapRes.json();
  const orangeZone = postClear.zones.find((z) => z.id === 'orange');
  assert.ok(orangeZone, 'Orange Zone entry must exist');
  assert.equal(orangeZone.state, 'available', 'Orange Zone must be unlocked after Blue completes');
});
