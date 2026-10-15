/**
 * =========================================================================
 * REALISTIC 800-PARTICIPANT CONCURRENCY & LOAD TEST
 * The Last Dataset | MAHE Manipal
 * =========================================================================
 *
 * Simulates 800 participants (400 teams of 2 players) running concurrent:
 * - 2-player team registrations & 3rd player cap rejection
 * - Sanctuary clearance (100 pts)
 * - Sector clearances (Yellow 200, Blue 400, Orange 600, Red 800)
 * - Dataset downloads
 * - ML submissions (non-qualifying, qualifying 1,000 pts, permanent lock 429)
 * - Concurrent live leaderboard polling
 * - Score ledger audit (strictly 3,100 points)
 *
 * Usage:
 *   node scripts/load-test.js [--teams 400] [--concurrency 40] [--production-rate-limits] [--supabase] [--report path.json]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'load-test-secret-key-that-is-at-least-32-chars-long';

function parseArgs() {
  const args = process.argv.slice(2);
  let teams = 400; // 400 teams = 800 participants
  let concurrency = 40;
  let useSupabase = args.includes('--supabase');
  let productionRateLimits = args.includes('--production-rate-limits');
  let reportPath = path.join(ROOT, 'tests', 'load-test-report.json');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--teams' && args[i + 1]) teams = parseInt(args[++i], 10);
    if (args[i] === '--concurrency' && args[i + 1]) concurrency = parseInt(args[++i], 10);
    if (args[i] === '--report' && args[i + 1]) reportPath = path.resolve(args[++i]);
  }
  return { teams, concurrency, useSupabase, productionRateLimits, reportPath };
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
  return getLowCsv();
}

function getLowCsv() {
  const samplePath = path.join(ROOT, 'server_data', 'sample_submission.csv');
  const lines = fs.readFileSync(samplePath, 'utf8').trim().split(/\r?\n/);
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 2) {
      out.push(`${parts[0].trim()},0.5000`);
    }
  }
  return out.join('\n');
}

class Metrics {
  constructor() {
    this.latencies = [];
    this.totalRequests = 0;
    this.errors = [];
    this.statusCodes = {};
    this.endpointStats = {};
    this.startTime = Date.now();
  }

  record(route, status, latencyMs, isError = false, errorMsg = '') {
    this.latencies.push(latencyMs);
    this.totalRequests++;

    this.statusCodes[status] = (this.statusCodes[status] || 0) + 1;

    const ep = route.split('?')[0];
    if (!this.endpointStats[ep]) {
      this.endpointStats[ep] = { requests: 0, successes: 0, failures: 0, latencies: [] };
    }
    this.endpointStats[ep].requests++;
    this.endpointStats[ep].latencies.push(latencyMs);
    if (isError) {
      this.endpointStats[ep].failures++;
      this.errors.push(`${status} on ${route}: ${errorMsg}`);
    } else {
      this.endpointStats[ep].successes++;
    }
  }

  summary() {
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    this.latencies.sort((a, b) => a - b);
    const n = this.latencies.length;
    const p50 = n ? this.latencies[Math.floor(n * 0.50)] : 0;
    const p90 = n ? this.latencies[Math.floor(n * 0.90)] : 0;
    const p95 = n ? this.latencies[Math.floor(n * 0.95)] : 0;
    const p99 = n ? this.latencies[Math.floor(n * 0.99)] : 0;
    const min = n ? this.latencies[0] : 0;
    const max = n ? this.latencies[n - 1] : 0;
    const avg = n ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / n) : 0;
    const reqPerSec = Math.round(this.totalRequests / elapsedSec);

    // Compute endpoint summaries
    const endpointSummary = {};
    for (const [ep, stats] of Object.entries(this.endpointStats)) {
      stats.latencies.sort((a, b) => a - b);
      const epLen = stats.latencies.length;
      endpointSummary[ep] = {
        requests: stats.requests,
        successes: stats.successes,
        failures: stats.failures,
        p50: epLen ? stats.latencies[Math.floor(epLen * 0.5)] : 0,
        p99: epLen ? stats.latencies[Math.floor(epLen * 0.99)] : 0
      };
    }

    const http429 = this.statusCodes[429] || 0;
    const http5xx = Object.entries(this.statusCodes)
      .filter(([code]) => code >= 500)
      .reduce((sum, [, count]) => sum + count, 0);

    return {
      elapsedSec: elapsedSec.toFixed(2),
      totalRequests: this.totalRequests,
      reqPerSec,
      errorCount: this.errors.length,
      statusCodes: this.statusCodes,
      http429Count: http429,
      http5xxCount: http5xx,
      latencies: { min, avg, p50, p90, p95, p99, max },
      endpoints: endpointSummary
    };
  }
}

async function request(baseUrl, route, options = {}, metrics) {
  const start = Date.now();
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(`${baseUrl}${route}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const latency = Date.now() - start;
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    const isErr = !res.ok && !options.expectedError;
    if (metrics) metrics.record(route, res.status, latency, isErr, typeof data === 'object' ? data.error : '');
    return {
      status: res.status,
      data,
      cookie: res.headers.get('set-cookie')?.split(';')[0]
    };
  } catch (err) {
    const latency = Date.now() - start;
    if (metrics) metrics.record(route, 0, latency, true, err.message);
    throw err;
  }
}

async function simulateTeamJourney(teamIndex, baseUrl, metrics, winningCsv, lowCsv) {
  const teamId = `BENCH-TEAM-${String(teamIndex).padStart(4, '0')}`;
  const teamName = `Benchmark Squad ${teamIndex}`;

  // 1. Player 1 registers
  const p1Reg = await request(baseUrl, '/api/register', {
    method: 'POST',
    body: { teamId, teamName, delegateId: `DEL-${teamIndex}-1` }
  }, metrics);
  if (p1Reg.status !== 200) throw new Error(`P1 Registration failed: ${p1Reg.status}`);
  const cookie1 = p1Reg.cookie;

  // 2. Player 2 registers on same team
  const p2Reg = await request(baseUrl, '/api/register', {
    method: 'POST',
    body: { teamId, teamName, delegateId: `DEL-${teamIndex}-2` }
  }, metrics);
  if (p2Reg.status !== 200) throw new Error(`P2 Registration failed: ${p2Reg.status}`);
  const cookie2 = p2Reg.cookie;

  // 3. Player 3 attempt is rejected (400 TEAM_CAP_EXCEEDED)
  const p3Reg = await request(baseUrl, '/api/register', {
    method: 'POST',
    body: { teamId, teamName, delegateId: `DEL-${teamIndex}-3` },
    expectedError: true
  }, metrics);
  if (p3Reg.status !== 400 || p3Reg.data.error !== 'TEAM_CAP_EXCEEDED') {
    throw new Error(`P3 Cap expected 400 TEAM_CAP_EXCEEDED, got ${p3Reg.status}`);
  }

  // 4. Sanctuary departure (100 pts)
  const sancRes = await request(baseUrl, '/api/zone/complete', {
    method: 'POST',
    headers: { Cookie: cookie1 },
    body: { zoneId: 'sanctuary' }
  }, metrics);
  if (sancRes.status !== 200) throw new Error(`Sanctuary completion failed: ${sancRes.status}`);

  // 5. Yellow Sector: solve yellow-01, then clear Yellow (200 pts)
  const solveY = await request(baseUrl, '/api/dev/solve', {
    method: 'POST',
    headers: { Cookie: cookie2 },
    body: { ctfId: 'yellow-01' }
  }, metrics);
  if (solveY.status !== 200) throw new Error(`Yellow solve failed: ${solveY.status}`);

  const yellowRes = await request(baseUrl, '/api/zone/complete', {
    method: 'POST',
    headers: { Cookie: cookie2 },
    body: { zoneId: 'yellow' }
  }, metrics);
  if (yellowRes.status !== 200) throw new Error(`Yellow completion failed: ${yellowRes.status}`);

  // 6. Dataset download: community_final
  const ds1Res = await request(baseUrl, '/api/dataset/community_final', {
    headers: { Cookie: cookie1 }
  }, metrics);
  if (ds1Res.status !== 200) throw new Error(`Dataset community_final failed: ${ds1Res.status}`);

  // 7. Blue Sector: solve all 4 Blue CTFs (100 pts each = 400 pts), then clear Blue
  for (const blueCtfId of ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04']) {
    const solveB = await request(baseUrl, '/api/dev/solve', {
      method: 'POST',
      headers: { Cookie: cookie1 },
      body: { ctfId: blueCtfId }
    }, metrics);
    if (solveB.status !== 200) throw new Error(`Blue solve (${blueCtfId}) failed: ${solveB.status}`);
  }

  const blueRes = await request(baseUrl, '/api/zone/complete', {
    method: 'POST',
    headers: { Cookie: cookie1 },
    body: { zoneId: 'blue' }
  }, metrics);
  if (blueRes.status !== 200) throw new Error(`Blue completion failed: ${blueRes.status}`);

  // 8. Dataset download: radio_final
  const ds2Res = await request(baseUrl, '/api/dataset/radio_final', {
    headers: { Cookie: cookie2 }
  }, metrics);
  if (ds2Res.status !== 200) throw new Error(`Dataset radio_final failed: ${ds2Res.status}`);

  // 9. Orange Sector: solve orange-01, then clear Orange (600 pts)
  const solveO = await request(baseUrl, '/api/dev/solve', {
    method: 'POST',
    headers: { Cookie: cookie2 },
    body: { ctfId: 'orange-01' }
  }, metrics);
  if (solveO.status !== 200) throw new Error(`Orange solve failed: ${solveO.status}`);

  const orangeRes = await request(baseUrl, '/api/zone/complete', {
    method: 'POST',
    headers: { Cookie: cookie2 },
    body: { zoneId: 'orange' }
  }, metrics);
  if (orangeRes.status !== 200) throw new Error(`Orange completion failed: ${orangeRes.status}`);

  // 10. Dataset download: forensics_final
  const ds3Res = await request(baseUrl, '/api/dataset/forensics_final', {
    headers: { Cookie: cookie1 }
  }, metrics);
  if (ds3Res.status !== 200) throw new Error(`Dataset forensics_final failed: ${ds3Res.status}`);

  // 11. Red Sector: solve red-01, then clear Red (800 pts)
  const solveR = await request(baseUrl, '/api/dev/solve', {
    method: 'POST',
    headers: { Cookie: cookie1 },
    body: { ctfId: 'red-01' }
  }, metrics);
  if (solveR.status !== 200) throw new Error(`Red solve failed: ${solveR.status}`);

  const redRes = await request(baseUrl, '/api/zone/complete', {
    method: 'POST',
    headers: { Cookie: cookie1 },
    body: { zoneId: 'red' }
  }, metrics);
  if (redRes.status !== 200) throw new Error(`Red completion failed: ${redRes.status}`);

  // 12. Dataset download: train.csv
  const trainRes = await request(baseUrl, '/api/dataset/train', {
    headers: { Cookie: cookie2 }
  }, metrics);
  if (trainRes.status !== 200) throw new Error(`Dataset train.csv failed: ${trainRes.status}`);

  // 13. Non-qualifying submission (attempt 1/10)
  const sub1 = await request(baseUrl, '/api/ml/evaluate', {
    method: 'POST',
    headers: { Cookie: cookie2 },
    body: { csvContent: lowCsv, rawFilename: 'submission_low.csv' }
  }, metrics);
  if (sub1.status !== 200) throw new Error(`ML submission 1 failed: ${sub1.status}`);

  // 14. Qualifying ML submission (awards 1,000 pts -> 3,100 pts total)
  const sub2 = await request(baseUrl, '/api/ml/evaluate', {
    method: 'POST',
    headers: { Cookie: cookie1 },
    body: { csvContent: winningCsv, rawFilename: 'submission_win.csv' }
  }, metrics);
  if (sub2.status !== 200 || !sub2.data.qualifiesForEscape) {
    throw new Error(`ML submission 2 qualifying failed: ${sub2.status}`);
  }

  // 15. Permanent submission lock verification (429 PURPLE_ALREADY_COMPLETED)
  const lockedSub = await request(baseUrl, '/api/ml/evaluate', {
    method: 'POST',
    headers: { Cookie: cookie1 },
    body: { csvContent: winningCsv, rawFilename: 'submission_blocked.csv' },
    expectedError: true
  }, metrics);
  if (lockedSub.status !== 429 || lockedSub.data.error !== 'PURPLE_ALREADY_COMPLETED') {
    throw new Error(`Permanent ML lock expected 429 PURPLE_ALREADY_COMPLETED, got ${lockedSub.status}`);
  }

  // 16. Verify bootstrap state across both teammates
  const [boot1, boot2] = await Promise.all([
    request(baseUrl, '/api/bootstrap', { headers: { Cookie: cookie1 } }, metrics),
    request(baseUrl, '/api/bootstrap', { headers: { Cookie: cookie2 } }, metrics)
  ]);

  if (boot1.data.score.total !== 3100 || boot2.data.score.total !== 3100) {
    throw new Error(`Canonical score mismatch: expected 3,100 pts, got P1=${boot1.data.score.total}, P2=${boot2.data.score.total}`);
  }
  if (!boot1.data.ml.escapeUnlocked || !boot2.data.ml.escapeUnlocked) {
    throw new Error('Escape gate not unlocked for both players');
  }
}

async function main() {
  const { teams, concurrency, useSupabase, productionRateLimits, reportPath } = parseArgs();
  const participants = teams * 2;

  console.log('========================================================');
  console.log(`THE LAST DATASET — REALISTIC ${participants}-PARTICIPANT LOAD TEST`);
  console.log(`Teams: ${teams} | Players: ${participants} | Concurrency: ${concurrency}`);
  console.log(`Backend Mode: ${useSupabase ? 'Live Supabase PostgreSQL' : 'Fast Atomic File Store'}`);
  console.log(`Rate Limits:  ${productionRateLimits ? 'Active Production Gateway Rules' : 'Disabled for Benchmark Concurrency'}`);
  console.log('========================================================\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-load-test-'));
  const dataFile = path.join(dir, 'progress.json');

  const serverEnv = {
    NODE_ENV: 'test',
    SESSION_SECRET,
    DISABLE_SUPABASE: useSupabase ? 'false' : 'true',
    ENABLE_DEV_TOOLS: 'true',
    DISABLE_RATE_LIMIT: productionRateLimits ? 'false' : 'true'
  };

  if (useSupabase) {
    serverEnv.SUPABASE_URL = process.env.SUPABASE_URL;
    serverEnv.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  if (productionRateLimits) {
    serverEnv.API_RATE_LIMIT_MAX = '10000';
    serverEnv.LOGIN_RATE_LIMIT_MAX = '5000';
  }

  const server = createHubServer({
    baseDir: ROOT,
    dataFile,
    env: serverEnv
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`Hub server listening at ${baseUrl}\n`);

  const metrics = new Metrics();
  const winningCsv = getWinningCsv();
  const lowCsv = getLowCsv();

  // Background Leaderboard Polling simulation
  let stopPolling = false;
  const pollPromise = (async () => {
    while (!stopPolling) {
      await request(baseUrl, '/api/leaderboard', {}, metrics).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  // Concurrent team simulation pool
  let activeIndex = 1;
  const teamPromises = [];

  for (let c = 0; c < concurrency; c++) {
    teamPromises.push((async () => {
      while (true) {
        const idx = activeIndex++;
        if (idx > teams) break;
        await simulateTeamJourney(idx, baseUrl, metrics, winningCsv, lowCsv);
      }
    })());
  }

  console.log(`Executing ${teams} concurrent team user journeys (${participants} players)...`);
  const startTs = Date.now();
  await Promise.all(teamPromises);
  stopPolling = true;
  await pollPromise;
  const duration = ((Date.now() - startTs) / 1000).toFixed(2);

  // Final leaderboard verification
  const finalLeaderboard = await request(baseUrl, '/api/leaderboard');
  const board = finalLeaderboard.data.leaderboard || [];

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const summary = metrics.summary();
  console.log('\n========================================================');
  console.log('LOAD TEST RESULTS SUMMARY');
  console.log('========================================================');
  console.log(`Simulated Players:       ${participants} players across ${teams} teams`);
  console.log(`Total HTTP Requests:     ${summary.totalRequests}`);
  console.log(`Elapsed Execution Time:  ${duration}s`);
  console.log(`Average Throughput:      ${summary.reqPerSec} req/sec`);
  console.log(`Total Errors Encountered: ${summary.errorCount}`);
  console.log(`HTTP 429 Count:          ${summary.http429Count}`);
  console.log(`HTTP 5xx Count:          ${summary.http5xxCount}`);
  console.log(`Latency Min:             ${summary.latencies.min}ms`);
  console.log(`Latency Avg:             ${summary.latencies.avg}ms`);
  console.log(`Latency p50:             ${summary.latencies.p50}ms`);
  console.log(`Latency p90:             ${summary.latencies.p90}ms`);
  console.log(`Latency p95:             ${summary.latencies.p95}ms`);
  console.log(`Latency p99:             ${summary.latencies.p99}ms`);
  console.log(`Latency Max:             ${summary.latencies.max}ms`);
  console.log('--------------------------------------------------------');
  console.log(`Leaderboard Qualified Teams: ${board.length} / ${teams}`);

  const all3100 = board.every((t) => t.total_score === 3100);
  console.log(`All Completed Teams At Exactly 3,100 pts: ${all3100 ? 'YES (100% PASS)' : 'FAIL'}`);
  console.log('========================================================\n');

  // Save detailed report
  const reportData = {
    timestamp: new Date().toISOString(),
    config: {
      teams,
      participants,
      concurrency,
      storageMode: useSupabase ? 'supabase-postgresql' : 'local-filesystem',
      productionRateLimitsActive: productionRateLimits,
      rateLimits: productionRateLimits ? { apiMax: 10000, loginMax: 5000 } : 'disabled'
    },
    results: {
      totalRequests: summary.totalRequests,
      durationSeconds: parseFloat(duration),
      throughputReqSec: summary.reqPerSec,
      errorCount: summary.errorCount,
      http429Count: summary.http429Count,
      http5xxCount: summary.http5xxCount,
      statusCodes: summary.statusCodes,
      latencies: summary.latencies,
      endpoints: summary.endpoints,
      leaderboardQualifiedTeams: board.length,
      allTeamsAtCanonical3100: all3100,
      passed: summary.errorCount === 0 && all3100
    }
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf8');
  console.log(`Saved benchmark report to: ${reportPath}\n`);

  if (summary.errorCount > 0 || !all3100) {
    console.error('LOAD TEST FAILED!');
    process.exit(1);
  } else {
    console.log('LOAD TEST PASSED WITH ZERO ERRORS AND PERFECT 3,100-POINT AUDIT!');
  }
}

main().catch((err) => {
  console.error('Fatal load test exception:', err);
  process.exit(1);
});
