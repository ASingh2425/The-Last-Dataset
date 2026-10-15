process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'admin-audit-secret-key-that-is-at-least-32-chars';
const ADMIN_KEY = 'super-secret-admin-key-2026';

async function withTestServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-admin-test-'));
  const dataFile = path.join(dir, 'progress.json');
  const server = createHubServer({
    baseDir: ROOT,
    dataFile,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET,
      DISABLE_SUPABASE: 'true',
      ENABLE_DEV_TOOLS: 'true',
      ADMIN_KEY
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

test('Admin Auth: session check returns false when unauthenticated', async (t) => {
  const { baseUrl } = await withTestServer(t);
  const res = await fetch(`${baseUrl}/api/admin/session`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.authenticated, false);
});

test('Admin Auth: login rejects invalid admin key with 401', async (t) => {
  const { baseUrl } = await withTestServer(t);
  const res = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminKey: 'wrong-key-value' })
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'INVALID_ADMIN_KEY');
});

test('Admin Auth: login succeeds with correct key, sets session cookie, allows overview access and logs out', async (t) => {
  const { baseUrl } = await withTestServer(t);

  // 1. Login
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminKey: ADMIN_KEY })
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.equal(loginData.ok, true);

  const cookieHeader = loginRes.headers.get('set-cookie');
  assert.ok(cookieHeader, 'Must set td_admin_session cookie');
  assert.ok(cookieHeader.includes('td_admin_session='), 'Cookie name must be td_admin_session');
  assert.ok(cookieHeader.includes('HttpOnly'), 'Cookie must be HttpOnly');

  const adminCookie = cookieHeader.split(';')[0];

  // 2. Check session endpoint with cookie
  const sessionRes = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(sessionRes.status, 200);
  const sessionData = await sessionRes.json();
  assert.equal(sessionData.authenticated, true);

  // 3. Access overview with cookie (no x-admin-key header required)
  const overviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(overviewRes.status, 200);
  const overviewData = await overviewRes.json();
  assert.equal(overviewData.ok, true);
  assert.equal(overviewData.totalPointsPossible, 3100);
  assert.equal(typeof overviewData.totalTeams, 'number');
  assert.equal(typeof overviewData.activeTeams, 'number');
  assert.equal(typeof overviewData.completedTeams, 'number');
  assert.equal(typeof overviewData.pointsAwarded, 'number');
  assert.ok(Array.isArray(overviewData.teams));

  // 4. Logout
  const logoutRes = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { Cookie: adminCookie }
  });
  assert.equal(logoutRes.status, 200);
  const clearCookieHeader = logoutRes.headers.get('set-cookie');
  assert.ok(clearCookieHeader && clearCookieHeader.includes('Max-Age=0'), 'Must clear session cookie on logout');

  // 5. Subsequent request without valid session returns 401
  const afterLogoutRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Cookie: 'td_admin_session=invalid-or-cleared' }
  });
  assert.equal(afterLogoutRes.status, 401);
});

test('Admin Overview: returns rich team fields, normalized zones, and progression audit', async (t) => {
  const { baseUrl } = await withTestServer(t);

  // Register a test team
  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'ADMIN-TEST-TEAM', teamName: 'Admin Verification Squad' })
  });
  assert.equal(regRes.status, 200);

  // Query overview with x-admin-key
  const res = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.totalTeams, 1);
  assert.equal(data.totalPointsPossible, 3100);
  const team = data.teams[0];
  assert.equal(team.id, 'ADMIN-TEST-TEAM');
  assert.equal(team.name, 'Admin Verification Squad');
  assert.equal(team.currentStage, 'sanctuary');
  assert.equal(team.purpleStatus, 'locked');
  assert.equal(team.totalStagesCount, 6);
  assert.equal(typeof team.hasInconsistencies, 'boolean');
  assert.ok(team.zones.sanctuary, 'Sanctuary zone must exist');
  assert.ok(team.zones.yellow, 'Yellow zone must exist');
  assert.ok(team.zones.blue, 'Blue zone must exist');
  assert.ok(team.zones.orange, 'Orange zone must exist');
  assert.ok(team.zones.red, 'Red zone must exist');
  assert.ok(team.zones.purple, 'Purple zone must exist');
  assert.ok(Array.isArray(team.ml.submissions));
});

test('Admin UI Routes: /admin, /admin/, and /admin.html serve dashboard HTML and static assets', async (t) => {
  const { baseUrl } = await withTestServer(t);

  const resAdmin = await fetch(`${baseUrl}/admin`);
  assert.equal(resAdmin.status, 200);
  assert.ok(resAdmin.headers.get('content-type').includes('text/html'));
  const html = await resAdmin.text();
  assert.ok(html.includes('COMMAND DECK'), 'HTML must include COMMAND DECK title');
  assert.ok(html.includes('admin.js'), 'HTML must script admin.js');

  const resAdminSlash = await fetch(`${baseUrl}/admin/`);
  assert.equal(resAdminSlash.status, 200);

  const resAdminHtml = await fetch(`${baseUrl}/admin.html`);
  assert.equal(resAdminHtml.status, 200);

  const resCss = await fetch(`${baseUrl}/admin/admin.css`);
  assert.equal(resCss.status, 200);
  assert.ok(resCss.headers.get('content-type').includes('text/css'));

  const resJs = await fetch(`${baseUrl}/admin/admin.js`);
  assert.equal(resJs.status, 200);
  assert.ok(resJs.headers.get('content-type').includes('javascript'));
});

test('Security Audit: Client JavaScript contains no hardcoded admin secret keys', async (t) => {
  const jsContent = fs.readFileSync(path.join(ROOT, 'public', 'admin', 'admin.js'), 'utf8');
  assert.ok(!jsContent.includes('tld-admin-master-key-2026'), 'admin.js must not contain default admin key');
  assert.ok(!jsContent.includes(ADMIN_KEY), 'admin.js must not contain runtime admin key');
  assert.ok(!jsContent.includes('process.env'), 'admin.js must not reference process.env');
});

