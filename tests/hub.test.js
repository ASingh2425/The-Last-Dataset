process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');
const { hmac } = require('../lib/security');
const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'test-session-secret-that-is-long-enough-to-pass-32';
const CTF_SECRET = 'test-yellow-03-ctf-secret-never-use-in-production';

async function withServer(t, configMode = 'open') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-hub-test-'));
  fs.cpSync(path.join(ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  const mockZones = {
    zones: [
      { id: 'yellow', name: 'YELLOW ZONE', color: '#f5c518', order: 1, tagline: 'INDUSTRIAL', terrain: '', position: { x: 29, y: 27 }, ctfs: [
        { id: 'yellow-01', title: 'T1', briefing: '', url: '/mock/ctf/yellow-01', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'yellow-02', title: 'T2', briefing: '', url: '/mock/ctf/yellow-02', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'yellow-03', title: 'T3', briefing: '', url: '/mock/ctf/yellow-03', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } }
      ]},
      { id: 'blue', name: 'BLUE ZONE', color: '#56c8ff', order: 2, tagline: 'SERVERS', terrain: '', position: { x: 73, y: 24 }, ctfs: [
        { id: 'blue-01', title: 'B1', briefing: '', url: '/mock/ctf/blue-01', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'blue-02', title: 'B2', briefing: '', url: '/mock/ctf/blue-02', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'blue-03', title: 'B3', briefing: '', url: '/mock/ctf/blue-03', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } }
      ]},
      { id: 'orange', name: 'ORANGE ZONE', color: '#ff8b3d', order: 3, tagline: 'REFINERY', terrain: '', position: { x: 77, y: 68 }, ctfs: [
        { id: 'orange-01', title: 'O1', briefing: '', url: '/mock/ctf/orange-01', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'orange-02', title: 'O2', briefing: '', url: '/mock/ctf/orange-02', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'orange-03', title: 'O3', briefing: '', url: '/mock/ctf/orange-03', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } }
      ]},
      { id: 'red', name: 'RED ZONE', color: '#ff4058', order: 4, tagline: 'INFECTION', terrain: '', position: { x: 26, y: 70 }, ctfs: [
        { id: 'red-01', title: 'R1', briefing: '', url: '/mock/ctf/red-01', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'red-02', title: 'R2', briefing: '', url: '/mock/ctf/red-02', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'red-03', title: 'R3', briefing: '', url: '/mock/ctf/red-03', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } }
      ]},
      { id: 'purple', name: 'PURPLE ZONE', color: '#bc8cff', order: 5, tagline: 'CORE', terrain: '', position: { x: 51, y: 10 }, ctfs: [
        { id: 'purple-01', title: 'P1', briefing: '', url: '/purple', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'purple-02', title: 'P2', briefing: '', url: '/purple', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } },
        { id: 'purple-03', title: 'P3', briefing: '', url: '/purple', completion: { method: 'hmac-sha256', secretEnv: 'CTF_SECRET_YELLOW_03' } }
      ]}
    ]
  };
  fs.writeFileSync(path.join(dir, 'config', 'zones.json'), JSON.stringify(mockZones, null, 2));
  const teamsFile = path.join(dir, 'config', 'teams.json');
  const teams = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
  teams.mode = configMode;
  if (configMode === 'whitelist') teams.allowedIds = ['ALLOW-01'];
  fs.writeFileSync(teamsFile, JSON.stringify(teams, null, 2));
  const env = { NODE_ENV: 'test', ENABLE_DEV_TOOLS: 'true', SESSION_SECRET, CTF_SECRET_YELLOW_03: CTF_SECRET };
  const server = createHubServer({ baseDir: dir, dataFile: path.join(dir, 'data', 'progress.json'), env });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  async function req(route, { method = 'GET', body, cookie, headers: customHeaders } = {}) {
    const headers = { Accept: 'application/json', ...(customHeaders || {}) };
    if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  }
  return { server, baseUrl, req, dir };
}

test('registration, team-name locking, locked-zone enforcement, and ordered unlock', async (t) => {
  const { req } = await withServer(t);
  let result = await req('/api/bootstrap');
  assert.equal(result.payload.authenticated, false);
  result = await req('/api/bootstrap', { cookie: 'td_session=%E0%A4%A' });
  assert.equal(result.response.status, 200, 'malformed percent escapes in cookies must not crash the request handler');
  assert.equal(result.payload.authenticated, false);
  assert.equal(JSON.stringify(result.payload).includes('yellow-01'), false, 'CTF IDs should not be in public bootstrap');
  result = await req('/api/register', { method: 'POST', body: { teamId: 'TEAM-007', teamName: '<script>alert(1)</script>' } });
  assert.equal(result.response.status, 400, 'XSS markup should be rejected by name validation');
  result = await req('/api/register', { method: 'POST', body: { teamId: 'TEAM-007', teamName: 'Signal Wardens' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.authenticated, true);
  const cookie = result.cookie;
  assert.match(cookie, /^td_session=[a-f0-9]{64}\.[a-f0-9]{64}$/);
  result = await req('/api/register', { method: 'POST', cookie, body: { teamId: 'TEAM-007', teamName: 'Not The Same Team' } });
  assert.equal(result.response.status, 409, 'existing name must not be overwritten');
  result = await req('/api/zones/blue', { cookie });
  assert.equal(result.response.status, 403);
  result = await req('/api/ctfs/blue-01/open', { method: 'POST', body: {}, cookie });
  assert.equal(result.response.status, 403);
  result = await req('/api/bootstrap', { cookie });
  assert.equal(result.payload.zones.find((zone) => zone.id === 'blue').unlocked, false);
  assert.equal(JSON.stringify(result.payload).includes('/mock/ctf/blue-01'), false, 'locked URLs must not be sent to the client');
  for (const ctfId of ['yellow-01', 'yellow-02']) {
    result = await req('/api/dev/solve', { method: 'POST', body: { ctfId }, cookie });
    assert.equal(result.response.status, 200);
  }
  result = await req('/api/zones/blue', { cookie });
  assert.equal(result.response.status, 403, 'partial zone completion must not unlock next zone');
});

test('signed completion verifies HMAC, expires timestamps, rejects replay, and unlocks in sequence', async (t) => {
  const { req } = await withServer(t);
  let registered = await req('/api/register', { method: 'POST', body: { teamId: 'TEAM-03', teamName: 'Archive Keepers' } });
  const cookie = registered.cookie;
  for (const ctfId of ['yellow-01', 'yellow-02']) await req('/api/dev/solve', { method: 'POST', body: { ctfId }, cookie });
  const now = Math.floor(Date.now() / 1000);
  const baseBody = { teamId: 'team-03', ctfId: 'yellow-03', timestamp: now };
  let response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature: '0'.repeat(64) } });
  assert.equal(response.response.status, 401);
  const expired = now - 900;
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, timestamp: expired, signature: hmac(CTF_SECRET, `TEAM-03.yellow-03.${expired}`) } });
  assert.equal(response.response.status, 401);
  const wrongSecretSignature = hmac('completely-wrong-secret-that-is-long-enough', `TEAM-03.yellow-03.${now}`);
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature: wrongSecretSignature } });
  assert.equal(response.response.status, 401, 'a signature from the wrong secret must be rejected');
  const signature = hmac(CTF_SECRET, `TEAM-03.yellow-03.${now}`);
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature } });
  assert.equal(response.response.status, 200);
  assert.equal(response.payload.newlySolved, true);
  const nextTimestamp = now + 1;
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, timestamp: nextTimestamp, signature: hmac(CTF_SECRET, `TEAM-03.yellow-03.${nextTimestamp}`) } });
  assert.equal(response.response.status, 200, 'freshly signed duplicate completions should be idempotent');
  assert.equal(response.payload.newlySolved, false);
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature } });
  assert.equal(response.response.status, 409, 'exact signed request replay must be rejected');
  response = await req('/api/zones/blue', { cookie });
  assert.equal(response.response.status, 200, 'Blue unlocks after all Yellow challenges are complete');
  assert.equal(response.payload.ctfs.length, 3);
});

test('whitelist mode rejects unlisted IDs and allows listed IDs', async (t) => {
  const { req } = await withServer(t, 'whitelist');
  let result = await req('/api/register', { method: 'POST', body: { teamId: 'BLOCK-01', teamName: 'Field Team' } });
  assert.equal(result.response.status, 403);
  result = await req('/api/register', { method: 'POST', body: { teamId: 'ALLOW-01', teamName: 'Field Team' } });
  assert.equal(result.response.status, 200);
});

test('dev simulation route is absent in production', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-prod-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { NODE_ENV: 'production', SESSION_SECRET: 'production-test-secret-is-long-and-not-default', ENABLE_DEV_TOOLS: 'true', COOKIE_SECURE: 'false' };
  const server = createHubServer({ baseDir: ROOT, dataFile: path.join(dir, 'progress.json'), env });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dev/solve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ctfId: 'yellow-01' }) });
  assert.equal(response.status, 404);
  assert.equal(server.hub.devToolsEnabled, false);
});


test('returning teams restore server-side progress under the original name', async (t) => {
  const { req } = await withServer(t);
  let result = await req('/api/register', { method: 'POST', body: { teamId: 'RESUME-01', teamName: 'Signal Keepers' } });
  assert.equal(result.response.status, 200);
  const firstCookie = result.cookie;
  result = await req('/api/dev/solve', { method: 'POST', body: { ctfId: 'yellow-01' }, cookie: firstCookie });
  assert.equal(result.response.status, 200);
  result = await req('/api/register', { method: 'POST', body: { teamId: 'resume-01', teamName: 'Signal Keepers' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.team.id, 'RESUME-01');
  assert.equal(result.payload.progress.solved, 1);
  assert.equal(result.payload.zones.find((zone) => zone.id === 'yellow').state, 'in-progress');
});

test('all five zones clear in strict order and produce survivor-complete progress', async (t) => {
  const { req, dir } = await withServer(t);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'zones.json'), 'utf8'));
  let result = await req('/api/register', { method: 'POST', body: { teamId: 'FULL-RUN-01', teamName: 'The Last Archive' } });
  const cookie = result.cookie;
  for (const zone of config.zones) {
    result = await req(`/api/zones/${zone.id}`, { cookie });
    assert.equal(result.response.status, 200, `${zone.id} should unlock after the previous zone clears`);
    for (const ctf of zone.ctfs) {
      result = await req('/api/dev/solve', { method: 'POST', body: { ctfId: ctf.id }, cookie });
      assert.equal(result.response.status, 200, `${ctf.id} should be completable when its zone is open`);
    }
  }
  result = await req('/api/bootstrap', { cookie });
  assert.equal(result.payload.progress.solved, 15);
  assert.equal(result.payload.progress.complete, true);
  assert.ok(result.payload.zones.every((zone) => zone.state === 'cleared'));
});

test('ML reconcile endpoint requires authentication, valid evaluationId, and recovers submission state', async (t) => {
  const { req } = await withServer(t);

  // 1. Unauthenticated request to /api/ml/reconcile is rejected
  let res = await req('/api/ml/reconcile', { method: 'POST', body: { evaluationId: 'some-eval-id' } });
  assert.equal(res.response.status, 401);
  assert.equal(res.payload.error, 'AUTH_REQUIRED');

  // 2. Register team
  let reg = await req('/api/register', { method: 'POST', body: { teamId: 'RECON-01', teamName: 'Reconciliation Squad' } });
  assert.equal(reg.response.status, 200);
  const cookie = reg.cookie;

  // 3. Authenticated request with missing evaluationId returns 400
  res = await req('/api/ml/reconcile', { method: 'POST', body: {}, cookie });
  assert.equal(res.response.status, 400);
  assert.equal(res.payload.error, 'MISSING_EVALUATION_ID');

  // 4. Authenticated request with non-existent evaluationId returns 404
  res = await req('/api/ml/reconcile', { method: 'POST', body: { evaluationId: 'non-existent-uuid' }, cookie });
  assert.equal(res.response.status, 404);
  assert.equal(res.payload.error, 'NOT_FOUND');

  // 5. Submit valid predictions to create a submission record
  const sampleCsv = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'sample_predictions.csv'), 'utf8');
  const evalRes = await req('/api/ml/evaluate', {
    method: 'POST',
    body: { csvContent: sampleCsv, rawFilename: 'reconcile_test.csv' },
    cookie
  });
  assert.equal(evalRes.response.status, 200);
  const evalId = evalRes.payload.evaluationId;
  assert.ok(evalId, 'Evaluation ID returned on evaluation');

  // 6. Reconcile the already evaluated submission returns 200 with idempotent state
  const reconRes = await req('/api/ml/reconcile', {
    method: 'POST',
    body: { evaluationId: evalId },
    cookie
  });
  assert.equal(reconRes.response.status, 200);
  assert.equal(reconRes.payload.success, true);
  assert.equal(reconRes.payload.reconciled, true);
  assert.equal(reconRes.payload.evaluationId, evalId);
  assert.equal(reconRes.payload.submissionsUsed, 1);
  assert.equal(reconRes.payload.submissionsRemaining, 9);
});

test('Orange Zone completion unlocks Red Zone and forensics dataset via POST, GET, and service integration', async (t) => {
  const { req } = await withServer(t);

  // 0. Unauthenticated GET /api/orange/complete returns 401
  let unauthRes = await req('/api/orange/complete', { method: 'GET' });
  assert.equal(unauthRes.response.status, 401);
  assert.equal(unauthRes.payload.error, 'AUTH_REQUIRED');

  // 1. Register team
  let reg = await req('/api/register', { method: 'POST', body: { teamId: 'ORANGE-TEST-01', teamName: 'Orange Pioneers' } });
  assert.equal(reg.response.status, 200);
  const cookie = reg.cookie;

  // 2. Clear Sanctuary, Yellow, and Blue
  await req('/api/dev/solve', { method: 'POST', body: { ctfId: 'yellow-01' }, cookie });
  await req('/api/zone/complete', { method: 'POST', body: { zoneId: 'yellow' }, cookie });
  await req('/api/zone/complete', { method: 'POST', body: { zoneId: 'blue' }, cookie });

  // 3. Complete Orange via POST /api/orange/complete
  let orangeRes = await req('/api/orange/complete', { method: 'POST', body: { teamId: 'ORANGE-TEST-01' }, cookie });
  assert.equal(orangeRes.response.status, 200);
  assert.equal(orangeRes.payload.ok, true);
  assert.equal(orangeRes.payload.zoneId, 'orange');

  // Verify bootstrap has Red unlocked and forensics_final awarded
  let boot = await req('/api/bootstrap', { cookie });
  assert.ok(boot.payload.datasets.includes('forensics_final'), 'forensics_final should be awarded');
  const orangeZone = boot.payload.zones.find((z) => z.id === 'orange');
  assert.equal(orangeZone.state, 'cleared');
  const redZone = boot.payload.zones.find((z) => z.id === 'red');
  assert.equal(redZone.unlocked, true);

  // 4. Verify GET /api/orange/complete works idempotently
  let getRes = await req('/api/orange/complete?teamId=ORANGE-TEST-01', { method: 'GET', cookie });
  assert.equal(getRes.response.status, 200);
  assert.equal(getRes.payload.ok, true);

  // 5. Test service integration with service token (Bearer)
  const serviceRes = await req('/api/integrations/orange-complete', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer the-last-dataset-2026-production-service-token-manipal',
      'x-service-token': 'the-last-dataset-2026-production-service-token-manipal'
    },
    body: { teamId: 'ORANGE-TEST-01' }
  });
  assert.equal(serviceRes.response.status, 200);
  assert.equal(serviceRes.payload.ok, true);
});

test('Blue Zone completion unlocks Orange Zone and radio_final dataset via POST, GET, and service integration', async (t) => {
  const { req } = await withServer(t);

  // 0. Unauthenticated GET /api/blue/complete returns 401
  let unauthRes = await req('/api/blue/complete', { method: 'GET' });
  assert.equal(unauthRes.response.status, 401);
  assert.equal(unauthRes.payload.error, 'AUTH_REQUIRED');

  // 1. Register team
  let reg = await req('/api/register', { method: 'POST', body: { teamId: 'BLUE-TEST-01', teamName: 'Blue Signals' } });
  assert.equal(reg.response.status, 200);
  const cookie = reg.cookie;

  // 2. Clear Sanctuary and Yellow
  await req('/api/dev/solve', { method: 'POST', body: { ctfId: 'yellow-01' }, cookie });
  await req('/api/zone/complete', { method: 'POST', body: { zoneId: 'yellow' }, cookie });

  // 3. Complete Blue via POST /api/blue/complete
  let blueRes = await req('/api/blue/complete', { method: 'POST', body: { teamId: 'BLUE-TEST-01' }, cookie });
  assert.equal(blueRes.response.status, 200);
  assert.equal(blueRes.payload.ok, true);
  assert.equal(blueRes.payload.zoneId, 'blue');

  // Verify bootstrap has Orange unlocked and radio_final awarded
  let boot = await req('/api/bootstrap', { cookie });
  assert.ok(boot.payload.datasets.includes('radio_final'), 'radio_final should be awarded');
  const blueZone = boot.payload.zones.find((z) => z.id === 'blue');
  assert.equal(blueZone.state, 'cleared');
  const orangeZone = boot.payload.zones.find((z) => z.id === 'orange');
  assert.equal(orangeZone.unlocked, true);

  // 4. Verify GET /api/blue/complete works idempotently
  let getRes = await req('/api/blue/complete?teamId=BLUE-TEST-01', { method: 'GET', cookie });
  assert.equal(getRes.response.status, 200);
  assert.equal(getRes.payload.ok, true);

  // 5. Test service integration with service token (Bearer)
  const serviceRes = await req('/api/integrations/blue-complete', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer the-last-dataset-2026-production-service-token-manipal',
      'x-service-token': 'the-last-dataset-2026-production-service-token-manipal'
    },
    body: { teamId: 'BLUE-TEST-01' }
  });
  assert.equal(serviceRes.response.status, 200);
  assert.equal(serviceRes.payload.ok, true);
});

