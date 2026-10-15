const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { loadConfig } = require('./config');
const { createStore, createUpstashStore } = require('./store');
const { supabaseStore } = require('./supabaseStore');
const { supabase } = require('./supabaseClient');
const { evaluateSubmission } = require('./evaluator');
const {
  hmac, safeEqual, signSession, verifySessionCookie, randomId,
  validateTeamId, validateTeamName, canonicalTeamId, sanitizeTeamName, validCtfSignature,
  signLaunchToken, verifyLaunchToken
} = require('./security');
const {
  CANONICAL_STAGE_SCORES,
  TOTAL_COMPETITION_POINTS,
  ZONE_REQUIRED_CHALLENGES,
  CHALLENGE_SCORES,
  ZONE_PREREQUISITES,
  ZONE_NEXT_MAP,
  ZONE_REWARD_DATASETS
} = require('../config/scoring');
const {
  buildEnrichedTeamOverview,
  buildAdminMetrics,
  ALL_ZONE_IDS
} = require('./adminOverview');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
};
const MAX_BODY = 10 * 1024 * 1024; // 10MB to accommodate ML submission uploads

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function createHubServer(options = {}) {
  const baseDir = options.baseDir || path.resolve(__dirname, '..');
  const publicDir = path.join(baseDir, 'public');
  const serverDataDir = path.join(baseDir, 'server_data');
  const config = loadConfig(baseDir);
  const env = { ...process.env, ...(options.env || {}) };
  const envFile = path.join(baseDir, '.env');

  if (!options.env && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }

  const isProduction = env.NODE_ENV === 'production' || !!env.VERCEL;
  const devToolsEnabled = !isProduction && env.ENABLE_DEV_TOOLS === 'true';
  const supabaseUrl = (options.dataFile || env.DISABLE_SUPABASE === 'true') ? (options.env?.SUPABASE_URL || '') : (env.SUPABASE_URL || '');
  const supabaseKey = (options.dataFile || env.DISABLE_SUPABASE === 'true') ? (options.env?.SUPABASE_SERVICE_ROLE_KEY || '') : (env.SUPABASE_SERVICE_ROLE_KEY || '');
  const hasSupabase = env.DISABLE_SUPABASE !== 'true' && !!(supabaseUrl && supabaseKey);

  if (isProduction && !options.dataFile && !options.store && env.DISABLE_SUPABASE !== 'true' && (!supabaseUrl || !supabaseKey)) {
    console.warn('[hub] WARNING: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured. Live database sync requires these in Vercel Project Settings.');
  }

  const sessionSecret = (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32)
    ? env.SESSION_SECRET
    : 'the-last-dataset-2026-production-super-secret-key-32chars';

  // Fallback file/redis store for offline testing
  let inMemoryFallback = null;
  function getFallbackStore() {
    if (options.store) return options.store;
    if (options.dataFile) return createStore(options.dataFile);
    const storePath = env.VERCEL
      ? path.join(require('node:os').tmpdir(), 'progress.json')
      : (env.DATA_FILE || path.join(baseDir, 'data', 'progress.json'));
    if (fs.existsSync(storePath)) {
      return createStore(storePath);
    }
    if (hasSupabase) {
      if (!inMemoryFallback) {
        let memoryState = { teams: {}, sessions: {}, usedSignatures: [] };
        inMemoryFallback = {
          filePath: 'memory',
          read: async () => memoryState,
          write: async (state) => { memoryState = state; },
          acquireLock: async () => () => {},
          initialState: () => memoryState
        };
      }
      return inMemoryFallback;
    }
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      return createUpstashStore(env);
    }
    return createStore(storePath);
  }
  const fallbackStore = getFallbackStore();
  const rates = new Map();
  const disableRateLimit = env.DISABLE_RATE_LIMIT === 'true';
  const apiRateLimitMax = parseInt(env.API_RATE_LIMIT_MAX || '6000', 10);
  const sessionRateLimitMax = parseInt(env.SESSION_RATE_LIMIT_MAX || '3000', 10);
  const loginRateLimitMax = parseInt(env.LOGIN_RATE_LIMIT_MAX || '2000', 10);
  const staticRoot = path.resolve(publicDir) + path.sep;

  function publicBootstrap() {
    return {
      authenticated: false,
      progress: {
        solved: 0,
        total: 4,
        ratio: 0,
        complete: false
      },
      zones: config.zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        color: zone.color,
        order: zone.order,
        tagline: zone.tagline,
        terrain: zone.terrain,
        position: zone.position,
        ctfTotal: zone.ctfs.length,
        solved: 0,
        state: zone.order === 1 ? 'available' : 'locked',
        unlocked: zone.order === 1
      })),
      event: config.event,
      devToolsEnabled,
      hasSupabase,
      serverTime: new Date().toISOString()
    };
  }

  function buildFallbackBootstrap(team) {
    const solvedSet = new Set(team?.solvedCtfs || []);
    const completedZonesSet = new Set(team?.completedZones || []);
    const unlockedZonesSet = new Set(team?.unlockedZones || []);
    const isPurpleUnlocked = unlockedZonesSet.has('purple') || completedZonesSet.has('red') || completedZonesSet.has('purple');
    const earnedDatasets = Array.from(new Set([
      ...(team?.datasets || []),
      ...(completedZonesSet.has('yellow') || isPurpleUnlocked ? ['community_final'] : []),
      ...(completedZonesSet.has('blue') || isPurpleUnlocked ? ['radio_final'] : []),
      ...(completedZonesSet.has('orange') || isPurpleUnlocked ? ['forensics_final'] : []),
      ...(completedZonesSet.has('red') || isPurpleUnlocked ? ['research_final'] : [])
    ]));

    const zones = config.zones.map((zone, idx) => {
      const solved = zone.ctfs.filter((c) => solvedSet.has(c.id)).length;
      const prevCleared = idx === 0 || completedZonesSet.has(config.zones[idx - 1].id) || config.zones[idx - 1].ctfs.every((c) => solvedSet.has(c.id));
      const isCleared = completedZonesSet.has(zone.id) || (zone.ctfs.length > 0 && solved === zone.ctfs.length);
      const isUnlocked = isCleared || unlockedZonesSet.has(zone.id) || prevCleared;
      const state = isCleared ? 'cleared' : isUnlocked ? (solved > 0 ? 'in-progress' : 'available') : 'locked';
      return {
        id: zone.id,
        name: zone.name,
        color: zone.color,
        order: zone.order,
        tagline: zone.tagline,
        terrain: zone.terrain,
        position: zone.position,
        ctfTotal: zone.ctfs.length,
        solved,
        solvedCtfs: zone.ctfs.filter((c) => solvedSet.has(c.id)).map((c) => c.id),
        unlocked: isUnlocked,
        state,
        ctfs: isUnlocked ? zone.ctfs.map((c) => ({ id: c.id, title: c.title, briefing: c.briefing, solved: solvedSet.has(c.id) })) : []
      };
    });
    const totalCtfs = config.zones.reduce((s, z) => s + z.ctfs.length, 0);
    const totalFragments = 4;
    const recoveredFragments = earnedDatasets.length;

    return {
      authenticated: true,
      teamId: team?.id,
      team: {
        id: team?.id,
        name: team?.name || team?.id,
        createdAt: team?.createdAt,
        solvedCtfs: team?.solvedCtfs || []
      },
      player: {
        delegateId: team?.delegateId || 'LEADER'
      },
      score: {
        total: team?.score || (solvedSet.size * 20)
      },
      sanctuaryCompleted: team?.sanctuaryCompleted ?? true,
      datasets: earnedDatasets,
      ml: {
        bestR2: team?.bestR2 || null,
        escapeUnlocked: !!team?.escapeUnlocked || (team?.mlSubmissions || []).some((s) => s.qualifies_for_escape)
      },
      zones,
      progress: {
        solved: recoveredFragments > 0 ? recoveredFragments : solvedSet.size,
        total: recoveredFragments > 0 ? totalFragments : totalCtfs,
        ratio: (recoveredFragments > 0 ? recoveredFragments / totalFragments : (totalCtfs ? solvedSet.size / totalCtfs : 0)),
        complete: (recoveredFragments >= totalFragments) || (totalCtfs > 0 && solvedSet.size >= totalCtfs)
      },
      events: team?.events || [],
      event: config.event,
      serverTime: new Date().toISOString()
    };
  }

  function buildFallbackAdminOverview(state) {
    const teams = Object.values(state.teams || {}).filter((t) => !t.id?.startsWith('TECHTEAM99')).map((t) => {
      const completedZones = t.completedZones || [];
      const solvedCtfs = t.solvedCtfs || [];
      const rawZones = {};

      for (const zoneId of ALL_ZONE_IDS) {
        const isCompleted = completedZones.includes(zoneId);
        const prereq = ZONE_PREREQUISITES[zoneId];
        const isAvailable = zoneId === 'sanctuary' || (prereq && completedZones.includes(prereq));
        const zoneConfig = config.zones.find((z) => z.id === zoneId);
        const zoneCtfIds = zoneConfig ? zoneConfig.ctfs.map((c) => c.id) : [];
        const solvedInZone = solvedCtfs.filter((c) => zoneCtfIds.includes(c));

        rawZones[zoneId] = {
          status: isCompleted ? 'completed' : (isAvailable ? 'available' : 'locked'),
          solvedChallenges: solvedInZone,
          completedAt: isCompleted ? (t.events?.find((e) => e.zoneId === zoneId || e.type === `zone_${zoneId}`)?.timestamp || t.createdAt || null) : null
        };
      }

      const rawScores = (t.events || [])
        .filter((e) => e.points)
        .map((e, idx) => ({
          id: idx + 1,
          delegateId: e.delegateId || 'LEADER',
          points: e.points,
          sourceType: e.type || e.source || 'zone_clear',
          sourceId: e.zoneId || e.sourceId || null,
          idempotencyKey: `${t.id}:${e.zoneId || idx}`,
          createdAt: e.timestamp || t.createdAt
        }));

      return buildEnrichedTeamOverview({
        team: t,
        members: t.memberDetails || t.members || [],
        rawZones,
        rawSubmissions: t.mlSubmissions || [],
        rawScores
      });
    });

    const totalMlSubmissions = Object.values(state.teams || {}).reduce((acc, t) => acc + (t.mlSubmissions || []).length, 0);
    const metrics = buildAdminMetrics(teams, totalMlSubmissions);

    return {
      ...metrics,
      teams
    };
  }

  function getExpectedAdminKey() {
    return env.ADMIN_KEY || env.ADMIN_SECRET || 'tld-admin-master-key-2026';
  }

  function getAdminSessionId() {
    const expectedKey = getExpectedAdminKey();
    return expectedKey ? crypto.createHash('sha256').update('admin_session:' + expectedKey).digest('hex') : null;
  }

  function setAdminSessionCookie(res) {
    const sid = getAdminSessionId();
    if (!sid) return;
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_admin_session=${signSession(sid, sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`);
  }

  function clearAdminSessionCookie(res) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  }

  function isAuthorizedAdmin(req, url) {
    const expectedKey = getExpectedAdminKey();
    if (!expectedKey) return false;

    // 1. Header check
    const adminKeyHeader = req.headers['x-admin-key'];
    if (adminKeyHeader && safeEqual(crypto.createHash('sha256').update(String(adminKeyHeader)).digest('hex'), crypto.createHash('sha256').update(String(expectedKey)).digest('hex'))) {
      return true;
    }

    // 2. Query param check
    const adminKeyParam = url && url.searchParams ? url.searchParams.get('adminKey') : null;
    if (adminKeyParam && safeEqual(crypto.createHash('sha256').update(String(adminKeyParam)).digest('hex'), crypto.createHash('sha256').update(String(expectedKey)).digest('hex'))) {
      return true;
    }

    // 3. Cookie check
    const cookies = Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const index = part.indexOf('=');
          return index < 0 ? ['', ''] : [part.slice(0, index), part.slice(index + 1)];
        })
        .filter(([name]) => name)
    );
    if (cookies.td_admin_session) {
      const adminVal = verifySessionCookie(cookies.td_admin_session, sessionSecret);
      const expectedSid = getAdminSessionId();
      if (adminVal && expectedSid && safeEqual(adminVal, expectedSid)) return true;
    }

    return false;
  }

  function isAuthorizedService(req, body, ctx) {
    const targetTeam = body && (body.teamId || body.team_id);
    const defaultTokens = [
      'the-last-dataset-2026-production-service-token-manipal',
      'dev-service-token'
    ];
    if (env.CTF_SERVICE_TOKEN) defaultTokens.push(env.CTF_SERVICE_TOKEN);
    if (env.CENTRAL_HUB_SERVICE_TOKEN) defaultTokens.push(env.CENTRAL_HUB_SERVICE_TOKEN);

    function checkToken(val) {
      if (!val || typeof val !== 'string') return false;
      const cleanVal = val.trim();
      if (!cleanVal) return false;
      const valHash = crypto.createHash('sha256').update(cleanVal).digest('hex');
      return defaultTokens.some((t) => safeEqual(valHash, crypto.createHash('sha256').update(t).digest('hex')));
    }

    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer /i.test(authHeader)) {
      const bToken = authHeader.slice(7).trim();
      if (checkToken(bToken)) return true;
      const bPayload = verifyLaunchToken(bToken, sessionSecret);
      if (bPayload && (!targetTeam || canonicalTeamId(targetTeam) === bPayload.teamId)) return true;
    }

    const xServiceToken = req.headers['x-service-token'];
    if (xServiceToken && checkToken(String(xServiceToken))) {
      return true;
    }

    if (body && typeof body.serviceToken === 'string' && checkToken(body.serviceToken)) {
      return true;
    }

    if (ctx && ctx.teamId && (!targetTeam || canonicalTeamId(targetTeam) === ctx.teamId)) {
      return true;
    }

    const launchToken = req.headers['x-launch-token'] || (body && body.launchToken);
    if (launchToken) {
      const payload = verifyLaunchToken(String(launchToken).trim(), sessionSecret);
      if (payload && (!targetTeam || canonicalTeamId(targetTeam) === payload.teamId)) {
        return true;
      }
    }

    return false;
  }

  function setSessionCookie(res, sessionId) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=${signSession(sessionId, sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`);
  }

  function clearSessionCookie(res) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  }

  async function sessionContext(req) {
    const cookies = Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const index = part.indexOf('=');
          return index < 0 ? ['', ''] : [part.slice(0, index), part.slice(index + 1)];
        })
        .filter(([name]) => name)
    );

    let sid = verifySessionCookie(cookies.td_session || cookies.tld_session_id, sessionSecret) ||
              (cookies.td_session && cookies.td_session.length >= 32 ? cookies.td_session : null) ||
              (cookies.tld_session_id && cookies.tld_session_id.length >= 32 ? cookies.tld_session_id : null);
    let launchPayload = null;
    const launchTokenHeader = req.headers['x-launch-token'];
    if (launchTokenHeader) {
      launchPayload = verifyLaunchToken(String(launchTokenHeader).trim(), sessionSecret);
    }
    if (!sid && !launchPayload) {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        launchPayload = verifyLaunchToken(token, sessionSecret);
        if (!launchPayload) {
          sid = verifySessionCookie(token, sessionSecret) || (token.length >= 32 ? token : null);
        }
      } else if (req.headers['x-session-id']) {
        const token = String(req.headers['x-session-id']).trim();
        launchPayload = verifyLaunchToken(token, sessionSecret);
        if (!launchPayload) {
          sid = verifySessionCookie(token, sessionSecret) || (token.length >= 32 ? token : null);
        }
      }
      if (!launchPayload) {
        try {
          const u = new URL(req.url, 'http://localhost');
          const qLaunchToken = u.searchParams.get('launchToken');
          if (qLaunchToken) {
            launchPayload = verifyLaunchToken(qLaunchToken.trim(), sessionSecret);
          }
          if (!sid) {
            const qSid = u.searchParams.get('sessionId') || u.searchParams.get('sid');
            if (qSid) {
              sid = verifySessionCookie(qSid.trim(), sessionSecret) || (qSid.trim().length >= 32 ? qSid.trim() : null);
            }
          }
        } catch (_) {}
      }
    }

    if (launchPayload) {
      if (hasSupabase) {
        return {
          sid: `launch:${launchPayload.teamId}`,
          session: { teamId: launchPayload.teamId, delegateId: launchPayload.delegateId },
          team: { id: launchPayload.teamId },
          teamId: launchPayload.teamId,
          delegateId: launchPayload.delegateId,
          isSupabase: true
        };
      } else {
        const state = await fallbackStore.read();
        const team = state.teams[launchPayload.teamId] || { id: launchPayload.teamId, name: launchPayload.teamId, solvedCtfs: [], events: [] };
        return {
          sid: `launch:${launchPayload.teamId}`,
          session: { teamId: launchPayload.teamId, delegateId: launchPayload.delegateId },
          team,
          teamId: launchPayload.teamId,
          delegateId: launchPayload.delegateId,
          state,
          isSupabase: false
        };
      }
    }

    if (!sid) {
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    }

    if (hasSupabase) {
      const active = await supabaseStore.validateSession(sid);
      if (active) {
        return {
          sid,
          session: active,
          team: active.team,
          teamId: active.teamId,
          delegateId: active.delegateId,
          isSupabase: true
        };
      }
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    } else {
      const state = await fallbackStore.read();
      if (state.sessions[sid] && state.teams[state.sessions[sid].teamId]) {
        const session = state.sessions[sid];
        session.lastSeen = new Date().toISOString();
        return {
          sid,
          session,
          team: state.teams[session.teamId],
          teamId: session.teamId,
          delegateId: session.delegateId || 'LEADER',
          state,
          isSupabase: false
        };
      }
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    }
  }

  function rateLimit(req, key, max, windowMs) {
    if (disableRateLimit) return true;
    const now = Date.now();
    const rawIp = (req.socket?.remoteAddress || req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || 'unknown');
    const ip = String(rawIp).split(',')[0].trim().replace(/^::ffff:/, '');
    const id = `${ip}|${key}`;
    let item = rates.get(id);
    if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
    item.count += 1;
    rates.set(id, item);
    if (rates.size > 10000) for (const [k, v] of rates) if (now - v.start > 60 * 60 * 1000) rates.delete(k);
    return item.count <= max;
  }

  function sessionRateLimit(sid, group, max, windowMs) {
    if (!sid) return true;
    return rateLimit({ socket: { remoteAddress: `session-${sid}` } }, `session:${group}`, max, windowMs);
  }

  const defaultAllowedOrigins = new Set([
    'https://yellow-zone-neon.vercel.app',
    'https://yellowzone-xi.vercel.app',
    'https://yellow-zone.vercel.app',
    'https://yellowzone.vercel.app',
    'https://yellow-zone-asingh2425.vercel.app',
    'https://yellowzone-asingh2425.vercel.app',
    'https://bluezone-xi.vercel.app',
    'https://bluezone-three.vercel.app',
    'https://or-light-gamma.vercel.app',
    'https://red-five-liart.vercel.app',
    'https://intro-stroyline.vercel.app',
    'https://last-dataset-sanc.vercel.app',
    'https://yellow-to-blue-slideshow.vercel.app',
    'https://blue-orange-slideshow-ogib.vercel.app',
    'https://orange-to-red-slideshow.vercel.app',
    'https://red-purple-slideshow.vercel.app',
    'https://purplezone.vercel.app',
    'https://purplezone-frontend.vercel.app'
  ]);
  if (env.ALLOWED_ORIGINS) {
    for (const o of String(env.ALLOWED_ORIGINS).split(',')) {
      if (o.trim()) defaultAllowedOrigins.add(o.trim());
    }
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      if (parsed.host === req.headers.host) return true;
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
      if (defaultAllowedOrigins.has(origin) || defaultAllowedOrigins.has(parsed.origin)) return true;
      return false;
    } catch { return false; }
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    const raw = Buffer.concat(chunks).toString('utf8');
    if (type === 'application/json') {
      try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Malformed JSON'), { status: 400 }); }
    }
    return { raw };
  }

  function commonHeaders(res, req) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; media-src 'self' blob:; frame-src 'self' http: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");

    const origin = req?.headers?.origin;
    if (origin && checkOrigin(req)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-id, x-team-id, x-launch-token, x-admin-key, x-service-token, x-delegate-id, Accept');
    }
  }

  async function reserveAttemptFallback(teamId, delegateId, rawFilename, maxAttempts = 10) {
    const release = fallbackStore.acquireLock ? await fallbackStore.acquireLock() : () => {};
    try {
      const state = await fallbackStore.read();
      let team = state.teams[teamId];
      if (!team) {
        team = { id: teamId, name: teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], mlSubmissions: [] };
        state.teams[teamId] = team;
      }
      team.mlSubmissions = team.mlSubmissions || [];
      const count = team.mlSubmissions.length;

      // Check if team has already qualified or completed purple zone
      const alreadyCompleted =
        Boolean(team.escapeUnlocked) ||
        (team.completedZones || []).includes('purple') ||
        (team.mlSubmissions || []).some((s) => s.qualifies_for_escape || (s.r2_score !== null && s.r2_score >= 0.80));

      if (alreadyCompleted) {
        return {
          allowed: false,
          alreadyCompleted: true,
          reason: 'PURPLE_ALREADY_COMPLETED',
          submissionId: null,
          attemptNumber: count,
          submissionsUsed: count,
          submissionsRemaining: 0
        };
      }

      if (count >= maxAttempts) {
        return {
          allowed: false,
          alreadyCompleted: false,
          reason: 'SUBMISSION_LIMIT_EXCEEDED',
          submissionId: null,
          attemptNumber: count,
          submissionsUsed: count,
          submissionsRemaining: 0
        };
      }
      const subId = 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const now = new Date().toISOString();
      team.mlSubmissions.unshift({
        id: subId,
        team_id: teamId,
        delegate_id: delegateId || 'OPERATOR',
        status: 'pending',
        raw_filename: rawFilename || 'submission.csv',
        submitted_at: now
      });
      await fallbackStore.write(state);
      return {
        allowed: true,
        alreadyCompleted: false,
        submissionId: subId,
        attemptNumber: count + 1,
        submissionsUsed: count + 1,
        submissionsRemaining: Math.max(0, maxAttempts - (count + 1)),
        submittedAt: now
      };
    } finally {
      release();
    }
  }

  async function finalizeAttemptFallback(teamId, submissionId, { r2Score, mseScore, qualifiesForEscape, status, errorMessage }) {
    const release = fallbackStore.acquireLock ? await fallbackStore.acquireLock() : () => {};
    try {
      const state = await fallbackStore.read();
      const team = state.teams[teamId];
      if (team && team.mlSubmissions) {
        const sub = team.mlSubmissions.find((s) => s.id === submissionId);
        if (sub) {
          sub.r2_score = r2Score;
          sub.mse_score = mseScore;
          sub.qualifies_for_escape = qualifiesForEscape;
          sub.status = status;
          sub.error_message = errorMessage || null;
        }
        if (typeof r2Score === 'number' && (team.bestR2 === null || team.bestR2 === undefined || r2Score > team.bestR2)) {
          team.bestR2 = r2Score;
        }
        if (qualifiesForEscape) {
          team.escapeUnlocked = true;
          if (!team.solvedCtfs.includes('purple-01')) {
            team.solvedCtfs.push('purple-01');
          }
          team.completedZones = team.completedZones || [];
          if (!team.completedZones.includes('purple')) {
            team.completedZones.push('purple');
            team.score = (team.score || 0) + (CANONICAL_STAGE_SCORES.purple?.points || 1000);
            team.events = team.events || [];
            team.events.unshift({
              at: new Date().toISOString(),
              message: 'Sector PURPLE completed. Helicopter evacuation authorized!'
            });
          }
        }
        await fallbackStore.write(state);
        return sub;
      }
    } finally {
      release();
    }
  }

  async function executeZoneCompletion(targetTeamId, zoneId, delegateId = 'OPERATOR', options = {}) {
    const cleanTeamId = String(targetTeamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('Team ID required');
    const autoHeal = options.autoHeal === true;

    let bootstrap;
    if (hasSupabase) {
      if (zoneId === 'yellow') {
        try {
          await supabaseStore.completeZoneDirect({
            teamId: cleanTeamId,
            delegateId,
            zoneId: 'sanctuary'
          });
        } catch (_) {}
      }

      if (autoHeal) {
        if (zoneId === 'blue') {
          try {
            await supabaseStore.completeZoneDirect({
              teamId: cleanTeamId,
              delegateId,
              zoneId: 'sanctuary'
            });
          } catch (_) {}
          try {
            await supabaseStore.completeZoneDirect({
              teamId: cleanTeamId,
              delegateId,
              zoneId: 'yellow'
            });
          } catch (_) {}
          const blueChallenges = ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04'];
          for (const ctfId of blueChallenges) {
            try {
              await supabaseStore.completeChallenge({
                teamId: cleanTeamId,
                delegateId,
                zoneId: 'blue',
                challengeId: ctfId,
                points: 100,
                allZoneChallenges: blueChallenges,
                nextZoneId: 'orange',
                rewardDatasetKey: 'radio_final'
              });
            } catch (_) {}
          }
        }

        if (zoneId === 'orange') {
          try {
            await executeZoneCompletion(cleanTeamId, 'blue', delegateId, { autoHeal: true });
          } catch (_) {}
        }
      }

      await supabaseStore.completeZoneDirect({
        teamId: cleanTeamId,
        delegateId,
        zoneId
      });
      bootstrap = await supabaseStore.getTeamBootstrap(cleanTeamId, delegateId, config);
    } else {
      const state = await fallbackStore.read();
      let team = state.teams[cleanTeamId];
      if (!team) {
        team = { id: cleanTeamId, name: cleanTeamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], completedZones: [] };
        state.teams[cleanTeamId] = team;
      }

      if (zoneId === 'yellow' && !(team.completedZones || []).includes('sanctuary')) {
        team.completedZones = Array.from(new Set([...(team.completedZones || []), 'sanctuary']));
        team.sanctuaryCompleted = true;
      }

      if (autoHeal) {
        if (zoneId === 'blue') {
          if (!(team.completedZones || []).includes('sanctuary')) {
            team.completedZones = Array.from(new Set([...(team.completedZones || []), 'sanctuary']));
            team.sanctuaryCompleted = true;
          }
          if (!(team.completedZones || []).includes('yellow')) {
            team.completedZones = Array.from(new Set([...(team.completedZones || []), 'yellow']));
            team.solvedCtfs = Array.from(new Set([...(team.solvedCtfs || []), 'yellow-01']));
            team.scoredChallenges = Array.from(new Set([...(team.scoredChallenges || []), 'yellow-01']));
          }
          const blueChallenges = ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04'];
          team.solvedCtfs = Array.from(new Set([...(team.solvedCtfs || []), ...blueChallenges]));
          team.scoredChallenges = Array.from(new Set([...(team.scoredChallenges || []), ...blueChallenges]));
        }

        if (zoneId === 'orange') {
          if (!(team.completedZones || []).includes('blue')) {
            team.completedZones = Array.from(new Set([...(team.completedZones || []), 'sanctuary', 'yellow', 'blue']));
            team.sanctuaryCompleted = true;
            const blueChallenges = ['blue-zone-ctf-01', 'blue-zone-ctf-02', 'blue-zone-ctf-03', 'blue-zone-ctf-04'];
            team.solvedCtfs = Array.from(new Set([...(team.solvedCtfs || []), 'yellow-01', ...blueChallenges]));
            team.scoredChallenges = Array.from(new Set([...(team.scoredChallenges || []), 'yellow-01', ...blueChallenges]));
            team.datasets = Array.from(new Set([...(team.datasets || []), 'community_final', 'radio_final']));
          }
        }
      }

      const reqPrev = ZONE_PREREQUISITES[zoneId];
      if (reqPrev && !(team.completedZones || []).includes(reqPrev)) {
        throw new Error(`PREREQUISITE_NOT_MET: Previous sector "${reqPrev}" must be completed before "${zoneId}" can be cleared.`);
      }

      if (zoneId === 'purple') {
        const hasQual = (team.mlSubmissions || []).some((s) => s.qualifies_for_escape || (s.r2_score !== null && s.r2_score >= 0.80));
        if (!hasQual) {
          throw new Error('PREREQUISITE_NOT_MET: Purple Zone requires an authoritative ML submission on record with R² ≥ 0.80.');
        }
      }

      const zoneConfig = config.zones.find((z) => z.id === zoneId);
      const zoneCtfIds = zoneConfig ? new Set(zoneConfig.ctfs.map((c) => c.id)) : new Set();
      const rawReqChallenges = ZONE_REQUIRED_CHALLENGES[zoneId] || [];
      const reqChallenges = (zoneCtfIds.size > 0 && rawReqChallenges.length > 0)
        ? rawReqChallenges.filter((c) => zoneCtfIds.has(c))
        : rawReqChallenges;
      const solvedSet = new Set(team.solvedCtfs || []);
      const missingChallenges = reqChallenges.filter((c) => !solvedSet.has(c));
      if (missingChallenges.length > 0) {
        throw new Error(`CHALLENGES_INCOMPLETE: Required challenges [${missingChallenges.join(', ')}] must be solved before sector "${zoneId}" can be cleared.`);
      }

      const alreadyCompleted = (team.completedZones || []).includes(zoneId);
      team.completedZones = Array.from(new Set([...(team.completedZones || []), zoneId]));
      if (zoneId === 'sanctuary') {
        team.sanctuaryCompleted = true;
      }
      const nextZone = ZONE_NEXT_MAP[zoneId];
      if (nextZone) {
        team.unlockedZones = Array.from(new Set([...(team.unlockedZones || []), nextZone]));
      }
      const reward = ZONE_REWARD_DATASETS[zoneId];
      if (reward) {
        team.datasets = Array.from(new Set([...(team.datasets || []), reward]));
      }
      if (!alreadyCompleted) {
        const stageInfo = CANONICAL_STAGE_SCORES[zoneId];
        const zoneChallengeIds = (config.zones.find((z) => z.id === zoneId)?.ctfs || []).map((c) => c.id);
        const awardedChallengePoints = (team.scoredChallenges || [])
          .filter((id) => zoneChallengeIds.includes(id))
          .reduce((sum, id) => sum + (CHALLENGE_SCORES[id] || 0), 0);
        const zonePointsToAward = Math.max(0, (stageInfo ? stageInfo.points : 0) - awardedChallengePoints);
        team.score = (team.score || 0) + zonePointsToAward;
      }
      team.events = team.events || [];
      team.events.unshift({
        at: new Date().toISOString(),
        message: `Sector ${zoneId.toUpperCase()} completed. Next sector: ${nextZone ? nextZone.toUpperCase() : 'ESCAPE'}`
      });
      await fallbackStore.write(state);
      bootstrap = buildFallbackBootstrap(team);
    }
    return bootstrap;
  }

  function findCtf(ctfId) {
    for (const zone of config.zones) {
      const ctf = zone.ctfs.find((item) => item.id === ctfId);
      if (ctf) return { zone, ctf };
    }
    return null;
  }

  function isAllowedZone(team, zoneId) {
    const idx = config.zones.findIndex((z) => z.id === zoneId);
    if (idx <= 0) return true;
    const prev = config.zones[idx - 1];
    return prev.ctfs.every((c) => (team?.solvedCtfs || []).includes(c.id));
  }

  const handler = async (req, res) => {
    commonHeaders(res, req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const initialPath = decodeURIComponent(url.pathname);
      const isApi = initialPath.startsWith('/api/');

      const ctx = isApi ? await sessionContext(req) : { sid: null, session: null, team: null, teamId: null, delegateId: null };
      const pathname = initialPath;

      if (isApi) {
        return json(res, 403, {
          error: 'CHALLENGE_COMPLETED',
          message: 'CHALLENGE COMPLETED. THANK YOU FOR PARTICIPATING IN THE LAST DATASET.',
          challengeCompleted: true,
          frozen: true,
          playingAllowed: false
        });
      }

      // -------------------------------------------------------------------
      // 1. SYSTEM HEALTH
      // -------------------------------------------------------------------
      if (pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, {
          status: 'ok',
          service: 'the-last-dataset-central-hub',
          database: hasSupabase ? 'supabase-postgresql' : 'local-store',
          mode: env.NODE_ENV || 'development',
          at: new Date().toISOString()
        });
      }

      // -------------------------------------------------------------------
      // 2. BOOTSTRAP (Live Team & Progression State)
      // -------------------------------------------------------------------
      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        const queryTeam = url.searchParams.get('team') || url.searchParams.get('teamId');
        const effectiveTeamId = ctx.teamId || (queryTeam ? canonicalTeamId(queryTeam) : null);
        if (!effectiveTeamId) return json(res, 200, publicBootstrap());
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(effectiveTeamId, ctx.delegateId || 'OPERATOR', config);
          return json(res, 200, bootstrap);
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[effectiveTeamId] || ctx.team;
          if (!team) return json(res, 200, publicBootstrap());
          return json(res, 200, buildFallbackBootstrap(team));
        }
      }

      // -------------------------------------------------------------------
      // 2.1 TEAM PROGRESS QUERY (Cross-Zone Client Access)
      // -------------------------------------------------------------------
      if (pathname === '/api/team/progress' && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to view team progress.' });
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId || 'OPERATOR', config);
          return json(res, 200, bootstrap);
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[ctx.teamId] || ctx.team;
          if (!team) return json(res, 404, { error: 'TEAM_NOT_FOUND' });
          return json(res, 200, buildFallbackBootstrap(team));
        }
      }

      // -------------------------------------------------------------------
      // 3. REGISTRATION & LOGIN (Team ID + Delegate ID + Passcode)
      // -------------------------------------------------------------------
      if ((pathname === '/api/register' || pathname === '/api/login') && req.method === 'POST') {
        if (!rateLimit(req, 'login', loginRateLimitMax, 15 * 60_000)) {
          return json(res, 429, { error: 'RATE_LIMITED', message: 'Too many authentication attempts. Please wait.' }, { 'Retry-After': '300' });
        }

        const body = await readBody(req);
        const teamId = String(body.teamId || '').trim();
        const delegateId = String(body.delegateId || '').trim();
        const passcode = String(body.passcode || body.teamPasscode || body.password || '').trim();

        if (hasSupabase) {
          const authResult = await supabaseStore.authenticatePlayer({ teamId, delegateId, passcode });
          if (!authResult.success) {
            return json(res, 401, { error: 'AUTH_FAILED', message: authResult.error });
          }

          setSessionCookie(res, authResult.sessionId);
          const bootstrap = await supabaseStore.getTeamBootstrap(authResult.team.id, authResult.member.delegate_id, config);
          bootstrap.sessionId = authResult.sessionId;
          return json(res, 200, bootstrap);
        } else {
          // Fallback legacy development registration
          const rawId = canonicalTeamId(teamId);
          if (!validateTeamId(rawId, config.teams?.teamIdPattern)) {
            return json(res, 400, { error: 'INVALID_ID' });
          }
          if (body.teamName && !validateTeamName(body.teamName, config.teams?.teamNamePattern)) {
            return json(res, 400, { error: 'INVALID_NAME' });
          }
          if (config.teams?.mode === 'whitelist' && !config.teams.allowedIds?.includes(rawId)) {
            return json(res, 403, { error: 'WHITELIST_REJECTED' });
          }
          const state = await fallbackStore.read();
          let team = state.teams[rawId];
          if (team) {
            if (body.teamName && body.teamName !== team.name) {
              return json(res, 409, { error: 'TEAM_NAME_LOCKED' });
            }
          } else {
            team = { id: rawId, name: body.teamName || rawId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], members: [] };
            state.teams[rawId] = team;
          }
          team.members = team.members || [];
          if (Array.isArray(body.members) && body.members.length > 2) {
            return json(res, 400, { error: 'TEAM_CAP_EXCEEDED', message: 'Maximum 2 players permitted per team.' });
          }
          if (delegateId) {
            const hasMember = team.members.includes(delegateId);
            if (!hasMember) {
              if (team.members.length >= 2) {
                return json(res, 400, { error: 'TEAM_CAP_EXCEEDED', message: 'Maximum 2 players permitted per team.' });
              }
              team.members.push(delegateId);
            }
          }
          const sid = randomId();
          state.sessions[sid] = { teamId: rawId, createdAt: new Date().toISOString(), view: { screen: 'map' } };
          await fallbackStore.write(state);
          setSessionCookie(res, sid);
          const fb = buildFallbackBootstrap(team);
          fb.sessionId = sid;
          return json(res, 200, fb);
        }
      }

      // -------------------------------------------------------------------
      // 4. LOGOUT
      // -------------------------------------------------------------------
      if (pathname === '/api/logout' && req.method === 'POST') {
        if (hasSupabase && ctx.sid) {
          await supabaseStore.destroySession(ctx.sid);
        }
        clearSessionCookie(res);
        return json(res, 200, { authenticated: false });
      }

      // -------------------------------------------------------------------
      // 5. VIEW STATE
      // -------------------------------------------------------------------
      if (pathname === '/api/view' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const body = await readBody(req);
        return json(res, 200, { ok: true, view: body });
      }

      // -------------------------------------------------------------------
      // 6. ZONE DETAIL & CTF OPEN
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/zones/') && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const zoneId = pathname.slice('/api/zones/'.length);
        const zone = config.zones.find((item) => item.id === zoneId);
        if (!zone) return json(res, 404, { error: 'ZONE_NOT_FOUND' });
        if (!hasSupabase && !isAllowedZone(ctx.team, zone.id)) {
          return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'Zone access locked.' });
        }

        return json(res, 200, {
          zone: { id: zone.id, name: zone.name, color: zone.color },
          ctfs: zone.ctfs.map((ctf) => ({ id: ctf.id, title: ctf.title, briefing: ctf.briefing }))
        });
      }

      if (pathname.startsWith('/api/ctfs/') && pathname.endsWith('/open') && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const ctfId = pathname.slice('/api/ctfs/'.length, -'/open'.length);
        const found = findCtf(ctfId);
        if (!found) return json(res, 404, { error: 'CTF_NOT_FOUND' });
        if (!hasSupabase && !isAllowedZone(ctx.team, found.zone.id)) {
          return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'Zone access locked.' });
        }

        return json(res, 200, {
          ctf: { id: found.ctf.id, title: found.ctf.title, briefing: found.ctf.briefing },
          zone: { id: found.zone.id, name: found.zone.name, color: found.zone.color },
          url: found.ctf.url
        });
      }

      // -------------------------------------------------------------------
      // 6.4 RED ZONE EMBEDDED CTF API (Authoritative Server Persistence)
      // -------------------------------------------------------------------
      const CANONICAL_RED_HASHES = {
        1: 'f2ac9d48b87eb075459936031aad374b2d59230a418e24ad6846390d172877f9',
        2: '164163f02dcd0503e995ea3ce93d63fedbe2bacb274506db3fe3ff40b71f18d4',
        3: '3b1d133a0979e041f30dfc122885ae588861d90144cadb775b91af618000a78e',
        4: '1b32adef4a406facb53c501f9d4753a7d01e9d908367df8bba833ef7d5c54897',
        5: 'cf7ade027cd7cfaf13250a58d3ec5c334cf5426e1256ac169e414172c1cc8de2'
      };

      function resolveRedTeamId(req, body, url, ctx) {
        let tid = (body && (body.teamId || body.team || body.team_id)) ||
          url.searchParams.get('team') ||
          url.searchParams.get('teamId') ||
          req.headers['x-team-id'] ||
          ctx.teamId ||
          '';
        if (!tid && req.headers['x-ctf-session']) {
          const sess = String(req.headers['x-ctf-session']).trim();
          if (sess.startsWith('team:')) {
            tid = sess.slice(5).split('.')[0];
          }
        }
        return canonicalTeamId(tid || '');
      }

      function computeRedState(solvedNumbers) {
        const solved = Array.from(new Set(solvedNumbers)).sort((a, b) => a - b);
        const unlocked = [1];
        if (solved.includes(1)) unlocked.push(2);
        if (solved.includes(1) && solved.includes(2)) unlocked.push(3);
        if (solved.includes(1) && solved.includes(2) && solved.includes(3)) unlocked.push(4, 5);
        const isAllDone = [1, 2, 3, 5].every(id => solved.includes(id));
        return {
          solved,
          unlocked,
          finalExitUnlocked: isAllDone || solved.includes(5),
          bonusUnlocked: solved.includes(4)
        };
      }

      async function getRedSolvedFragments(teamId) {
        const solved = new Set();
        if (hasSupabase) {
          try {
            if (supabase) {
              const { data } = await supabase
                .from('challenge_solves')
                .select('challenge_id')
                .eq('team_id', teamId)
                .eq('zone_id', 'red');
              if (data) {
                for (const row of data) {
                  const cid = String(row.challenge_id || '').toLowerCase();
                  if (cid === 'red-01' || cid === '1' || cid === 'zone_bridge') solved.add(1);
                  if (cid === 'red-02' || cid === '2' || cid === 'zone_vault') solved.add(2);
                  if (cid === 'red-03' || cid === '3' || cid === 'zone_ai') solved.add(3);
                  if (cid === 'red-04' || cid === '4' || cid === 'zone_atrium') solved.add(4);
                  if (cid === 'red-05' || cid === '5' || cid === 'zone_bio') solved.add(5);
                  if (cid === 'red' || cid === 'red-zone') [1, 2, 3, 4, 5].forEach(n => solved.add(n));
                }
              }
              const { data: zp } = await supabase
                .from('zone_progress')
                .select('status')
                .eq('team_id', teamId)
                .eq('zone_id', 'red')
                .maybeSingle();
              if (zp && (zp.status === 'cleared' || zp.status === 'completed')) {
                solved.add(1);
              }
            }
          } catch (_) {}
        } else {
          try {
            const state = await fallbackStore.read();
            const team = state.teams[teamId];
            if (team && Array.isArray(team.solvedCtfs)) {
              for (const cid of team.solvedCtfs) {
                const c = String(cid || '').toLowerCase();
                if (c === 'red-01' || c === '1') solved.add(1);
                if (c === 'red-02' || c === '2') solved.add(2);
                if (c === 'red-03' || c === '3') solved.add(3);
                if (c === 'red-04' || c === '4') solved.add(4);
                if (c === 'red-05' || c === '5') solved.add(5);
              }
            }
          } catch (_) {}
        }
        return Array.from(solved).sort((a, b) => a - b);
      }

      if (pathname === '/api/ctf/session' && req.method === 'POST') {
        const body = await readBody(req);
        const teamId = resolveRedTeamId(req, body, url, ctx);
        const solved = await getRedSolvedFragments(teamId);
        const state = computeRedState(solved);
        const sessionToken = `team:${teamId}.${hmac(sessionSecret, `red-session:${teamId}`)}`;
        return json(res, 201, {
          session: sessionToken,
          state
        });
      }

      if (pathname === '/api/ctf/state' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const teamId = resolveRedTeamId(req, body, url, ctx);
        const solved = await getRedSolvedFragments(teamId);
        const state = computeRedState(solved);
        return json(res, 200, { state });
      }

      if (pathname === '/api/ctf/links' && req.method === 'GET') {
        return json(res, 200, {
          links: {
            1: env.CTF_URL_1 || "https://red-zone-ctf1.onrender.com/",
            2: env.CTF_URL_2 || "https://red-zone-ctf2.onrender.com/",
            3: env.CTF_URL_3 || "https://red-zone-ctf3.onrender.com/",
            4: env.CTF_URL_4 || "https://bonus-ctf4.onrender.com/",
            5: env.CTF_URL_5 || "https://red-zone-ctf5.onrender.com/"
          }
        });
      }

      if (pathname === '/api/ctf/verify' && req.method === 'POST') {
        const body = await readBody(req);
        const teamId = resolveRedTeamId(req, body, url, ctx);
        const ctf = Number(body.ctf);
        const flag = String(body.flag || '').trim();
        const candidateHash = crypto.createHash('sha256').update(flag, 'utf8').digest('hex');
        const expectedHash = CANONICAL_RED_HASHES[ctf];

        if (!expectedHash || candidateHash !== expectedHash) {
          const solved = await getRedSolvedFragments(teamId);
          return json(res, 200, {
            accepted: false,
            code: 'invalid_flag',
            message: 'ACCESS DENIED — INVALID FLAG',
            state: computeRedState(solved)
          });
        }

        // Flag matches! Record solve authoritatively in Supabase / team store
        if (hasSupabase) {
          try {
            await supabaseStore.completeChallenge({
              teamId,
              delegateId: 'OPERATOR',
              zoneId: 'red',
              challengeId: `red-0${ctf}`,
              points: 0,
              allZoneChallenges: ['red-01', 'red-02', 'red-03', 'red-04', 'red-05'],
              nextZoneId: 'purple',
              rewardDatasetKey: 'research_final'
            });
          } catch (_) {}
        } else {
          try {
            const state = await fallbackStore.read();
            let team = state.teams[teamId];
            if (team) {
              if (!team.solvedCtfs) team.solvedCtfs = [];
              if (!team.solvedCtfs.includes(`red-0${ctf}`)) team.solvedCtfs.push(`red-0${ctf}`);
              await fallbackStore.write(state);
            }
          } catch (_) {}
        }

        const currentSolved = await getRedSolvedFragments(teamId);
        if (!currentSolved.includes(ctf)) currentSolved.push(ctf);
        const state = computeRedState(currentSolved);

        // If CTF 5 is solved, complete Red Zone
        if (state.finalExitUnlocked) {
          try {
            await executeZoneCompletion(teamId, 'red', 'OPERATOR');
          } catch (_) {}
        }

        return json(res, 200, {
          accepted: true,
          code: 'flag_accepted',
          message: 'FLAG ACCEPTED',
          fragment: ctf,
          state
        });
      }

      // -------------------------------------------------------------------
      // 6.5 TRUSTED ZONE LAUNCH TOKEN (Cryptographically bound session)
      // -------------------------------------------------------------------
      if (pathname === '/api/zone/launch' && (req.method === 'GET' || req.method === 'POST')) {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });
        const queryZoneId = req.method === 'GET' ? url.searchParams.get('zoneId') : (await readBody(req)).zoneId;
        const targetZone = config.zones.find((z) => z.id === queryZoneId);
        if (!targetZone) return json(res, 404, { error: 'ZONE_NOT_FOUND', message: 'Unknown zone.' });

        // Verify zone is unlocked for this team
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
          const zoneEntry = bootstrap.zones.find((z) => z.id === targetZone.id);
          if (!zoneEntry || (zoneEntry.state !== 'available' && zoneEntry.state !== 'active' && zoneEntry.state !== 'cleared')) {
            return json(res, 403, { error: 'ZONE_LOCKED', message: `Zone ${targetZone.name} is locked.` });
          }
        } else {
          if (!isAllowedZone(ctx.team, targetZone.id)) {
            return json(res, 403, { error: 'ZONE_LOCKED', message: `Zone ${targetZone.name} is locked.` });
          }
        }

        const now = Date.now();
        const payload = {
          teamId: ctx.teamId,
          delegateId: ctx.delegateId || 'OPERATOR',
          zoneId: targetZone.id,
          iat: now,
          exp: now + 24 * 60 * 60 * 1000 // 24 hours
        };
        const launchToken = signLaunchToken(payload, sessionSecret);

        const baseTargetUrl = targetZone.url;
        const separator = baseTargetUrl.includes('?') ? '&' : '?';
        const targetUrl = `${baseTargetUrl}${separator}launchToken=${encodeURIComponent(launchToken)}&team=${encodeURIComponent(ctx.teamId)}`;

        return json(res, 200, {
          ok: true,
          launchToken,
          teamId: ctx.teamId,
          zoneId: targetZone.id,
          targetUrl
        });
      }

      // -------------------------------------------------------------------
      // 6.6 PUBLIC ZONE STATUS & PREREQUISITE GATEKEEPER
      // -------------------------------------------------------------------
      if (pathname === '/api/zone/status' && (req.method === 'GET' || req.method === 'POST')) {
        const queryZoneId = req.method === 'GET' ? url.searchParams.get('zoneId') : (await readBody(req)).zoneId;
        const queryTeamId = req.method === 'GET' ? (url.searchParams.get('team') || url.searchParams.get('teamId')) : (await readBody(req)).teamId;
        const effectiveTeamId = ctx.teamId || (queryTeamId ? String(queryTeamId).trim().toUpperCase() : null);

        if (!effectiveTeamId) {
          return json(res, 200, {
            ok: false,
            unlocked: false,
            error: 'AUTH_REQUIRED',
            message: 'No team specified. Please register at Central Command.',
            hubUrl: '/'
          });
        }

        const targetZoneId = String(queryZoneId || 'yellow').trim().toLowerCase();
        const targetZone = config.zones.find((z) => z.id === targetZoneId);
        const prereq = ZONE_PREREQUISITES[targetZoneId];

        if (hasSupabase) {
          try {
            const bootstrap = await supabaseStore.getTeamBootstrap(effectiveTeamId, null, config);
            const zoneEntry = bootstrap.zones.find((z) => z.id === targetZoneId);
            const isUnlocked = targetZoneId === 'sanctuary'
              ? true
              : Boolean(zoneEntry && (zoneEntry.state === 'available' || zoneEntry.state === 'in-progress' || zoneEntry.state === 'cleared' || zoneEntry.unlocked));

            return json(res, 200, {
              ok: true,
              unlocked: isUnlocked,
              zoneId: targetZoneId,
              zoneName: targetZone?.name || targetZoneId,
              teamId: bootstrap.team.id,
              teamName: bootstrap.team.name,
              totalScore: bootstrap.score?.total || 0,
              prerequisite: prereq,
              state: zoneEntry?.state || (isUnlocked ? 'available' : 'locked'),
              hubUrl: `/?team=${encodeURIComponent(effectiveTeamId)}`
            });
          } catch (err) {
            return json(res, 200, {
              ok: false,
              unlocked: false,
              error: 'TEAM_NOT_FOUND',
              message: `Team "${effectiveTeamId}" not found in registry.`,
              hubUrl: '/'
            });
          }
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[effectiveTeamId];
          if (!team) {
            return json(res, 200, {
              ok: false,
              unlocked: false,
              error: 'TEAM_NOT_FOUND',
              message: `Team "${effectiveTeamId}" not found.`,
              hubUrl: '/'
            });
          }
          const isUnlocked = isAllowedZone(team, targetZoneId);
          return json(res, 200, {
            ok: true,
            unlocked: isUnlocked,
            zoneId: targetZoneId,
            zoneName: targetZone?.name || targetZoneId,
            teamId: team.id,
            teamName: team.name,
            totalScore: team.score || 0,
            prerequisite: prereq,
            state: isUnlocked ? 'available' : 'locked',
            hubUrl: `/?team=${encodeURIComponent(effectiveTeamId)}`
          });
        }
      }

      // -------------------------------------------------------------------
      // 7. SECURE DATASET DOWNLOAD (Entitlement-Checked)
      // -------------------------------------------------------------------
      // 7.1 SANCTUARY COMPLETION (Unlocks Yellow Zone after storyline)
      // -------------------------------------------------------------------
      if (pathname === '/api/sanctuary/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const teamId = canonicalTeamId(ctx.teamId || req.headers['x-team-id'] || (body && (body.teamId || body.team_id)) || url.searchParams.get('team') || url.searchParams.get('teamId'));
        if (!teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first or provide valid team identity.' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'sanctuary', body.delegateId || ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.15 YELLOW COMPLETION (Unlocks Blue Zone & community_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/yellow/complete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!ctx.teamId && !isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first or provide valid service credentials.' });
        }
        const teamId = canonicalTeamId(ctx.teamId || (body && (body.teamId || body.team_id)) || url.searchParams.get('team') || url.searchParams.get('teamId'));
        if (!teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must provide a valid teamId or log in.' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'yellow', body.delegateId || ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, zoneId: 'yellow', teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.16 BLUE COMPLETION (Unlocks Orange Zone & radio_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/blue/complete' && (req.method === 'POST' || req.method === 'GET')) {
        let body = {};
        if (req.method === 'POST') {
          try { body = await readBody(req); } catch (_) { body = {}; }
        }
        const headerTeam = req.headers['x-team-id'] ? canonicalTeamId(req.headers['x-team-id']) : null;
        const queryTeam = url.searchParams.get('team') || url.searchParams.get('teamId') || url.searchParams.get('team_id');
        const resolvedTeam = canonicalTeamId(ctx.teamId || headerTeam || (body && (body.teamId || body.team_id)) || queryTeam);

        const isSelfAuth = ctx.teamId && (!resolvedTeam || resolvedTeam === ctx.teamId);
        const isServiceAuth = isAuthorizedService(req, body, ctx) || isAuthorizedAdmin(req, url);

        if (!isSelfAuth && !isServiceAuth && !headerTeam) {
          return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first or provide valid service credentials.' });
        }
        const teamId = resolvedTeam || ctx.teamId;
        if (!teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must provide a valid teamId or log in.' });

        const delegateId = (body && body.delegateId) || url.searchParams.get('delegateId') || ctx.delegateId || 'OPERATOR';

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'blue', delegateId, { autoHeal: true });
          if (req.method === 'GET' && (url.searchParams.get('redirect') === 'true' || req.headers.accept?.includes('text/html'))) {
            res.setHeader('Location', `/?sync=blue_success&team=${encodeURIComponent(teamId)}`);
            res.writeHead(302);
            return res.end();
          }
          return json(res, 200, { ok: true, zoneId: 'blue', teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          if (req.method === 'GET' && (url.searchParams.get('redirect') === 'true' || req.headers.accept?.includes('text/html'))) {
            res.setHeader('Location', `/?sync=blue_error&message=${encodeURIComponent(err.message)}`);
            res.writeHead(302);
            return res.end();
          }
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.17 ORANGE COMPLETION (Unlocks Red Zone & forensics_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/orange/complete' && (req.method === 'POST' || req.method === 'GET')) {
        let body = {};
        if (req.method === 'POST') {
          try { body = await readBody(req); } catch (_) { body = {}; }
        }
        const headerTeam = req.headers['x-team-id'] ? canonicalTeamId(req.headers['x-team-id']) : null;
        const queryTeam = url.searchParams.get('team') || url.searchParams.get('teamId') || url.searchParams.get('team_id');
        const resolvedTeam = canonicalTeamId(ctx.teamId || headerTeam || (body && (body.teamId || body.team_id)) || queryTeam);
        
        const isSelfAuth = ctx.teamId && (!resolvedTeam || resolvedTeam === ctx.teamId);
        const isServiceAuth = isAuthorizedService(req, body, ctx) || isAuthorizedAdmin(req, url);
        
        if (!isSelfAuth && !isServiceAuth && !headerTeam) {
          return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first or provide valid service credentials.' });
        }
        const teamId = resolvedTeam || ctx.teamId;
        if (!teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must provide a valid teamId or log in.' });

        const delegateId = (body && body.delegateId) || url.searchParams.get('delegateId') || ctx.delegateId || 'OPERATOR';

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'orange', delegateId, { autoHeal: true });
          if (req.method === 'GET' && (url.searchParams.get('redirect') === 'true' || req.headers.accept?.includes('text/html'))) {
            res.setHeader('Location', `/?sync=orange_success&team=${encodeURIComponent(teamId)}`);
            res.writeHead(302);
            return res.end();
          }
          return json(res, 200, { ok: true, zoneId: 'orange', teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          if (req.method === 'GET' && (url.searchParams.get('redirect') === 'true' || req.headers.accept?.includes('text/html'))) {
            res.setHeader('Location', `/?sync=orange_error&message=${encodeURIComponent(err.message)}`);
            res.writeHead(302);
            return res.end();
          }
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.18 RED COMPLETION (Unlocks Purple Zone & research_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/red/complete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!ctx.teamId && !isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first or provide valid service credentials.' });
        }
        const teamId = canonicalTeamId(ctx.teamId || (body && (body.teamId || body.team_id)) || url.searchParams.get('team') || url.searchParams.get('teamId'));
        if (!teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must provide a valid teamId or log in.' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'red', body.delegateId || ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, zoneId: 'red', teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.19 UNIFIED ZONE COMPLETION (Direct Cross-Zone Access)
      // -------------------------------------------------------------------
      if (pathname === '/api/zone/complete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!ctx.teamId && !isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first or provide valid service credentials.' });
        }
        const teamId = canonicalTeamId(ctx.teamId || (body && (body.teamId || body.team_id)) || url.searchParams.get('team') || url.searchParams.get('teamId'));
        if (!teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must provide a valid teamId or log in.' });

        const zoneId = String(body.zoneId || '').trim().toLowerCase();
        if (!['sanctuary', 'yellow', 'blue', 'orange', 'red', 'purple'].includes(zoneId)) {
          return json(res, 400, { error: 'INVALID_ZONE', message: `Unknown zone: ${zoneId}` });
        }

        try {
          const bootstrap = await executeZoneCompletion(teamId, zoneId, body.delegateId || ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, zoneId, teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.195 SERVICE INTEGRATION ENDPOINTS (Inter-Zone RPC & State Sync)
      // -------------------------------------------------------------------
      if (pathname === '/api/integrations/sanctuary-complete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token, launch token, or session required.' });
        }
        const teamId = canonicalTeamId(body.teamId || body.team_id || ctx.teamId);
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'sanctuary', body.delegateId || ctx.delegateId || 'SERVICE');
          return json(res, 200, { ok: true, zoneId: 'sanctuary', teamId, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      if ((pathname === '/api/integrations/yellow-complete' || pathname === '/api/yellow/complete') && req.method === 'POST') {
        const body = await readBody(req);
        if (!isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token, launch token, or session required.' });
        }
        const teamId = canonicalTeamId(body.teamId || body.team_id || ctx.teamId || url.searchParams.get('team') || url.searchParams.get('teamId'));
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'yellow', body.delegateId || ctx.delegateId || 'SERVICE');
          return json(res, 200, { ok: true, zoneId: 'yellow', teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      if (pathname === '/api/integrations/blue-complete' && (req.method === 'POST' || req.method === 'GET')) {
        let body = {};
        if (req.method === 'POST') {
          try { body = await readBody(req); } catch (_) { body = {}; }
        }
        const queryTeam = url.searchParams.get('team') || url.searchParams.get('teamId') || url.searchParams.get('team_id');
        const resolvedTeam = canonicalTeamId((body && (body.teamId || body.team_id)) || queryTeam || ctx.teamId || req.headers['x-team-id']);
        if (!isAuthorizedService(req, body, ctx) && !isAuthorizedAdmin(req, url) && !(ctx.teamId && ctx.teamId === resolvedTeam)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token, launch token, or session required.' });
        }
        const teamId = resolvedTeam;
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'blue', (body && body.delegateId) || url.searchParams.get('delegateId') || ctx.delegateId || 'SERVICE', { autoHeal: true });
          return json(res, 200, { ok: true, zoneId: 'blue', teamId, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      if (pathname === '/api/integrations/orange-complete' && (req.method === 'POST' || req.method === 'GET')) {
        let body = {};
        if (req.method === 'POST') {
          try { body = await readBody(req); } catch (_) { body = {}; }
        }
        const queryTeam = url.searchParams.get('team') || url.searchParams.get('teamId') || url.searchParams.get('team_id');
        const resolvedTeam = canonicalTeamId((body && (body.teamId || body.team_id)) || queryTeam || ctx.teamId || req.headers['x-team-id']);
        if (!isAuthorizedService(req, body, ctx) && !isAuthorizedAdmin(req, url) && !(ctx.teamId && ctx.teamId === resolvedTeam)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token, launch token, or session required.' });
        }
        const teamId = resolvedTeam;
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'orange', (body && body.delegateId) || url.searchParams.get('delegateId') || ctx.delegateId || 'SERVICE', { autoHeal: true });
          return json(res, 200, { ok: true, zoneId: 'orange', teamId, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }
      if (pathname === '/api/integrations/red-complete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token, launch token, or session required.' });
        }
        const teamId = canonicalTeamId(body.teamId || body.team_id || ctx.teamId);
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'red', body.delegateId || ctx.delegateId || 'SERVICE');
          return json(res, 200, { ok: true, zoneId: 'red', teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      if ((pathname === '/api/integrations/purple-complete' || pathname === '/api/purple/complete') && req.method === 'POST') {
        const body = await readBody(req);
        if (!isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token, launch token, or session required.' });
        }
        const teamId = canonicalTeamId(body.teamId || body.team_id || ctx.teamId || url.searchParams.get('team') || url.searchParams.get('teamId'));
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        try {
          const bootstrap = await executeZoneCompletion(teamId, 'purple', body.delegateId || ctx.delegateId || 'SERVICE');
          return json(res, 200, { ok: true, zoneId: 'purple', teamId, score: bootstrap.score?.total || 0, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      if (pathname === '/api/integrations/reset-team-submissions' && req.method === 'POST') {
        const body = await readBody(req);
        if (!isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token required.' });
        }
        const teamId = canonicalTeamId(body.teamId || body.team_id || ctx.teamId);
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        if (hasSupabase && supabase) {
          await supabase.from('ml_submissions').delete().eq('team_id', teamId);
        } else {
          const state = await fallbackStore.read();
          if (state.teams[teamId]) {
            state.teams[teamId].mlSubmissions = [];
            delete state.teams[teamId].bestR2;
            await fallbackStore.write(state);
          }
        }
        return json(res, 200, { ok: true, teamId, message: 'Submissions successfully reset to 0/10' });
      }

      if ((pathname === '/api/integrations/zone-ctf-complete' || pathname === '/api/zone-ctf-complete' || pathname === '/api/integrations/ctf-complete' || pathname === '/api/ctf-complete') && req.method === 'POST') {
        const body = await readBody(req);
        if (!isAuthorizedService(req, body, ctx)) {
          return json(res, 401, { error: 'UNAUTHORIZED_SERVICE', message: 'Valid service token, launch token, or session required.' });
        }
        const teamId = canonicalTeamId(body.teamId || body.team_id || ctx.teamId);
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED', message: 'TEAM ID REQUIRED: Please provide your Team ID (e.g. ?team=TECHTEAM...) or launch through Central Command.' });
        const ctfId = String(body.ctfId || body.challengeId || '').trim();
        const found = ctfId ? findCtf(ctfId) : null;
        const zoneId = String(body.zoneId || '').trim().toLowerCase() || (found?.zone?.id || null);
        const delegateId = body.delegateId || ctx.delegateId || 'SERVICE';

        const stagePoints = ctfId ? (CHALLENGE_SCORES[ctfId] || 0) : 0;
        const allZoneIds = found ? found.zone.ctfs.map((c) => c.id) : (ctfId ? [ctfId] : []);
        const effectiveZone = zoneId || found?.zone?.id;

        if (hasSupabase) {
          if (effectiveZone === 'yellow') {
            try {
              await supabaseStore.completeZoneDirect({ teamId, delegateId, zoneId: 'sanctuary' });
            } catch (_) {}
          }
          let challengeResult = null;
          if (ctfId && effectiveZone) {
            challengeResult = await supabaseStore.completeChallenge({
              teamId,
              delegateId,
              zoneId: effectiveZone,
              challengeId: ctfId,
              points: stagePoints,
              allZoneChallenges: allZoneIds,
              nextZoneId: effectiveZone ? ZONE_NEXT_MAP[effectiveZone] : null,
              rewardDatasetKey: effectiveZone ? ZONE_REWARD_DATASETS[effectiveZone] : null
            });
          }
          if (effectiveZone === 'yellow' || (allZoneIds.length === 1 && ctfId)) {
            try {
              await supabaseStore.completeZoneDirect({ teamId, delegateId, zoneId: effectiveZone });
            } catch (_) {}
          }
          const bootstrap = await supabaseStore.getTeamBootstrap(teamId, delegateId, config);
          return json(res, 200, { ok: true, teamId, ctfId, zoneId: effectiveZone, score: bootstrap.score?.total || 0, challengeResult, bootstrap });
        } else {
          const state = await fallbackStore.read();
          let team = state.teams[teamId];
          if (!team) {
            team = { id: teamId, name: teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], completedZones: [] };
            state.teams[teamId] = team;
          }
          team.solvedCtfs = team.solvedCtfs || [];
          if (ctfId && !team.solvedCtfs.includes(ctfId)) {
            team.solvedCtfs.push(ctfId);
            if (stagePoints > 0) {
              team.scoredChallenges = team.scoredChallenges || [];
              if (!team.scoredChallenges.includes(ctfId)) {
                team.scoredChallenges.push(ctfId);
                team.score = (team.score || 0) + stagePoints;
              }
            }
          }
          await fallbackStore.write(state);

          if (effectiveZone === 'yellow' || (allZoneIds.length === 1 && ctfId)) {
            try {
              await executeZoneCompletion(teamId, effectiveZone, delegateId);
            } catch (_) {}
          }
          const bootstrap = buildFallbackBootstrap(team);
          return json(res, 200, { ok: true, teamId, ctfId, zoneId: effectiveZone, score: bootstrap.score?.total || 0, bootstrap });
        }
      }

      if ((pathname === '/api/integrations/team-state' || pathname === '/api/team-state') && (req.method === 'GET' || req.method === 'POST')) {
        const queryTeam = req.method === 'GET' ? (url.searchParams.get('teamId') || url.searchParams.get('team')) : null;
        const body = req.method === 'POST' ? await readBody(req) : {};
        const teamId = canonicalTeamId(queryTeam || body.teamId || body.team_id || ctx.teamId);
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        if (hasSupabase) {
          try {
            const bootstrap = await supabaseStore.getTeamBootstrap(teamId, ctx.delegateId, config);
            return json(res, 200, { ok: true, teamId, bootstrap });
          } catch (err) {
            return json(res, 404, { error: 'TEAM_NOT_FOUND', message: err.message });
          }
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[teamId];
          if (!team) return json(res, 404, { error: 'TEAM_NOT_FOUND' });
          const bootstrap = buildFallbackBootstrap(team);
          return json(res, 200, { ok: true, teamId, bootstrap });
        }
      }

      if (pathname === '/api/integrations/launch-verify' && (req.method === 'GET' || req.method === 'POST')) {
        const queryToken = req.method === 'GET' ? url.searchParams.get('launchToken') : null;
        const body = req.method === 'POST' ? await readBody(req) : {};
        const token = String(queryToken || body.launchToken || req.headers['x-launch-token'] || '').trim();
        if (!token) return json(res, 400, { ok: false, valid: false, error: 'TOKEN_REQUIRED' });

        const payload = verifyLaunchToken(token, sessionSecret);
        if (!payload) return json(res, 401, { ok: false, valid: false, error: 'INVALID_OR_EXPIRED_TOKEN' });

        return json(res, 200, { ok: true, valid: true, payload });
      }

      // -------------------------------------------------------------------
      // 7.2 DATASET ENTITLEMENTS & DOWNLOAD (Strict Server-Side Gate)
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/dataset/') && req.method === 'GET') {
        const queryTeam = url.searchParams.get('teamId') || url.searchParams.get('team');
        const effectiveTeamId = ctx.teamId || (queryTeam ? canonicalTeamId(queryTeam) : null);
        if (!effectiveTeamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to download datasets.' });
        const datasetKey = pathname.slice('/api/dataset/'.length).replace(/\.csv$/, '');

        const validDatasets = ['community_final', 'radio_final', 'forensics_final', 'research_final', 'train', 'sample_submission'];
        if (!validDatasets.includes(datasetKey)) {
          return json(res, 404, { error: 'DATASET_NOT_FOUND' });
        }

        // Determine if team has reached Purple Zone (i.e. solved yellow, blue, orange, red zones)
        let isPurpleUnlocked = false;
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(effectiveTeamId, ctx.delegateId, config);
          const purpleZone = bootstrap?.zones?.find((z) => z.id === 'purple');
          isPurpleUnlocked = !!(purpleZone && (purpleZone.unlocked || purpleZone.state === 'cleared' || purpleZone.state === 'available' || purpleZone.state === 'in-progress'));
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[effectiveTeamId];
          isPurpleUnlocked = !!(team && (
            (team.unlockedZones || []).includes('purple') ||
            (team.completedZones || []).includes('purple') ||
            (team.completedZones || []).includes('red')
          ));
        }

        // sample_submission is open to all authenticated survivors as an evaluation benchmark
        if (datasetKey === 'sample_submission') {
          // Open to authenticated users
        } else if (datasetKey === 'train') {
          // train.csv is given in Purple Zone
          if (!isPurpleUnlocked) {
            return json(res, 403, {
              error: 'ENTITLEMENT_LOCKED',
              message: 'train.csv is locked until your team reaches the Purple Zone.'
            });
          }
        } else {
          let hasAccess = false;
          if (isPurpleUnlocked) {
            // Once all 4 zones (yellow, blue, orange, red) are cleared and purple is reached,
            // all 4 recovered sector datasets are fully accessible
            hasAccess = true;
          } else if (hasSupabase) {
            hasAccess = await supabaseStore.checkDatasetEntitlement(effectiveTeamId, datasetKey);
            if (!hasAccess) {
              const bootstrap = await supabaseStore.getTeamBootstrap(effectiveTeamId, ctx.delegateId, config);
              const DATASET_ZONE = { community_final: 'yellow', radio_final: 'blue', forensics_final: 'orange', research_final: 'red' };
              const reqZoneId = DATASET_ZONE[datasetKey];
              const zoneObj = bootstrap?.zones?.find((z) => z.id === reqZoneId);
              if (zoneObj && (zoneObj.state === 'cleared' || zoneObj.solved >= zoneObj.ctfTotal)) {
                hasAccess = true;
              }
            }
          } else {
            const state = await fallbackStore.read();
            const team = state.teams[effectiveTeamId];
            const DATASET_ZONE = { community_final: 'yellow', radio_final: 'blue', forensics_final: 'orange', research_final: 'red' };
            const reqZoneId = DATASET_ZONE[datasetKey];
            hasAccess = !!(team && (
              (team.datasets || []).includes(datasetKey) ||
              (reqZoneId && (team.completedZones || []).includes(reqZoneId))
            ));
          }
          if (!hasAccess) {
            return json(res, 403, {
              error: 'ENTITLEMENT_LOCKED',
              message: `Your team has not yet completed the required zone to earn ${datasetKey}.csv.`
            });
          }
        }

        const fileName = `${datasetKey}.csv`;
        let filePath = path.join(serverDataDir, fileName);
        if (!fs.existsSync(filePath)) {
          filePath = path.join(publicDir, 'datasets', fileName);
        }
        if (!fs.existsSync(filePath)) {
          return json(res, 404, { error: 'FILE_UNAVAILABLE', message: 'Dataset file is currently being processed.' });
        }

        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Cache-Control': 'no-store'
        });
        return fs.createReadStream(filePath).pipe(res);
      }

      // -------------------------------------------------------------------
      // 8. PURPLE ZONE ML EVALUATION (Strict Server-Side Evaluator)
      // -------------------------------------------------------------------
      if (pathname === '/api/ml/evaluate' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to evaluate a model.' });
        const body = await readBody(req);
        const teamId = ctx.teamId;
        const delegateId = ctx.delegateId || (body && (body.delegateId || body.delegate_id)) || 'OPERATOR';

        // Enforce sequential progression: Sector Red must be completed before Purple ML evaluation is permitted
        if (hasSupabase && supabase) {
          let isRedComplete = false;
          const { data: redProg } = await supabase
            .from('zone_progress')
            .select('status')
            .eq('team_id', teamId)
            .eq('zone_id', 'red')
            .maybeSingle();

          if (redProg && (redProg.status === 'completed' || redProg.status === 'cleared')) {
            isRedComplete = true;
          } else {
            // Also check score_ledger in case of legacy records
            const { data: redLedger } = await supabase
              .from('score_ledger')
              .select('id')
              .eq('team_id', teamId)
              .in('source_id', ['red-zone', 'red', 'zone_red_clear'])
              .limit(1);
            if (redLedger && redLedger.length > 0) {
              isRedComplete = true;
            }
          }

          if (!isRedComplete) {
            return json(res, 403, {
              error: 'PREREQUISITE_NOT_MET',
              message: 'Sector "red" must be cleared by your team before Purple Zone evaluation can be accessed.'
            });
          }
        }

        const csvContent = body.csvContent || body.raw || '';
        const rawFilename = String(body.rawFilename || 'submission.csv').slice(0, 100);

        // Pre-validate CSV before consuming any quota attempt
        const evalResult = evaluateSubmission(csvContent);
        if (!evalResult.valid) {
          if (evalResult.error && evalResult.error.startsWith('SCORING_ARBITER_UNAVAILABLE')) {
            return json(res, 503, {
              error: 'EVALUATION_SERVICE_UNAVAILABLE',
              message: 'Scoring arbiter is currently unavailable. No attempt consumed.'
            });
          }
          let existingCount = 0;
          try {
            if (hasSupabase) {
              const subs = await supabaseStore.getTeamSubmissions(teamId);
              existingCount = subs.length;
            } else {
              const state = await fallbackStore.read();
              existingCount = (state.teams[teamId]?.mlSubmissions || []).length;
            }
          } catch (_) {}

          return json(res, 400, {
            error: 'VALIDATION_FAILED',
            message: evalResult.error,
            submissionsUsed: existingCount,
            submissionsRemaining: Math.max(0, 10 - existingCount),
            maxAllowed: 10,
            note: 'Invalid submission format. No attempt was consumed.'
          });
        }

        // Atomically reserve attempt (serialized mutex prevents race conditions)
        let reservation;
        try {
          if (hasSupabase) {
            reservation = await supabaseStore.reserveMlAttempt({
              teamId,
              delegateId,
              rawFilename,
              maxAttempts: 10
            });
          } else {
            reservation = await reserveAttemptFallback(teamId, delegateId, rawFilename, 10);
          }
        } catch (dbErr) {
          console.error('[ml reserve error]', dbErr);
          return json(res, 503, {
            error: 'DATABASE_ERROR',
            message: dbErr.message || 'Could not record submission attempt due to database error. Please try again.'
          });
        }

        if (!reservation.allowed) {
          if (reservation.alreadyCompleted || reservation.reason === 'PURPLE_ALREADY_COMPLETED') {
            return json(res, 429, {
              error: 'PURPLE_ALREADY_COMPLETED',
              message: 'Your team has already successfully completed the Purple Zone and qualified for evacuation. Further submissions are locked.',
              submissionsUsed: reservation.submissionsUsed,
              submissionsRemaining: 0,
              maxAllowed: 10
            });
          }
          return json(res, 429, {
            error: 'SUBMISSION_LIMIT_EXCEEDED',
            message: 'Maximum 10 submissions allowed per team. Submission quota exhausted.',
            submissionsUsed: reservation.submissionsUsed,
            submissionsRemaining: 0,
            maxAllowed: 10
          });
        }

        // Finalize submission
        try {
          if (hasSupabase) {
            if (evalResult.qualifiesForEscape) {
              await supabaseStore.finalizeQualifyingMlSubmission({
                submissionId: reservation.submissionId,
                teamId,
                delegateId,
                r2Score: evalResult.r2Score,
                mseScore: evalResult.mseScore,
                points: CANONICAL_STAGE_SCORES.purple?.points || 1000
              });
            } else {
              await supabaseStore.finalizeMlSubmission({
                submissionId: reservation.submissionId,
                r2Score: evalResult.r2Score,
                mseScore: evalResult.mseScore,
                qualifiesForEscape: false,
                status: 'valid'
              });
            }
          } else {
            await finalizeAttemptFallback(teamId, reservation.submissionId, {
              r2Score: evalResult.r2Score,
              mseScore: evalResult.mseScore,
              qualifiesForEscape: evalResult.qualifiesForEscape,
              status: 'valid'
            });
          }
        } catch (dbErr) {
          console.error('[ml finalize error]', dbErr);
          return json(res, 503, {
            error: 'FINALIZATION_FAILED',
            message: 'Model evaluated successfully but could not be durably recorded. Call /api/ml/reconcile with this evaluationId to retry finalization.',
            evaluationId: reservation.submissionId,
            attemptNumber: reservation.attemptNumber,
            retryable: true
          });
        }

        return json(res, 200, {
          success: true,
          evaluationId: reservation.submissionId,
          attemptNumber: reservation.attemptNumber,
          timestamp: reservation.submittedAt || new Date().toISOString(),
          r2Score: evalResult.r2Score,
          mseScore: evalResult.mseScore,
          qualifiesForEscape: evalResult.qualifiesForEscape,
          threshold: evalResult.threshold,
          message: evalResult.message,
          submissionsUsed: reservation.submissionsUsed,
          submissionsRemaining: reservation.submissionsRemaining,
          maxAllowed: 10
        });
      }

      // -------------------------------------------------------------------
      // 8.05 PURPLE ZONE ML RECONCILIATION
      // -------------------------------------------------------------------
      if (pathname === '/api/ml/reconcile' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to reconcile an evaluation.' });
        const body = await readBody(req);
        const teamId = ctx.teamId;

        const evaluationId = body.evaluationId;
        const csvContent = body.csvContent || body.raw || '';
        if (!evaluationId) {
          return json(res, 400, { error: 'MISSING_EVALUATION_ID', message: 'evaluationId is required.' });
        }

        try {
          if (hasSupabase) {
            const sub = await supabaseStore.getMlSubmissionById(evaluationId, teamId);
            if (!sub) {
              return json(res, 404, { error: 'NOT_FOUND', message: 'Submission not found or does not belong to your team.' });
            }

            if (sub.status === 'valid') {
              if (sub.qualifies_for_escape) {
                await supabaseStore.finalizeQualifyingMlSubmission({
                  submissionId: sub.id,
                  teamId,
                  delegateId: ctx.delegateId || sub.delegate_id,
                  r2Score: sub.r2_score,
                  mseScore: sub.mse_score,
                  points: CANONICAL_STAGE_SCORES.purple?.points || 1000
                });
              }
              const allSubs = await supabaseStore.getTeamSubmissions(teamId);
              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: sub.r2_score,
                mseScore: sub.mse_score,
                qualifiesForEscape: sub.qualifies_for_escape,
                message: sub.qualifies_for_escape ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission finalized.',
                submissionsUsed: allSubs.length,
                submissionsRemaining: Math.max(0, 10 - allSubs.length),
                maxAllowed: 10
              });
            }

            if (sub.status === 'pending') {
              let r2 = sub.r2_score;
              let mse = sub.mse_score;
              let qualifies = sub.qualifies_for_escape;
              if (r2 === null || r2 === undefined) {
                if (!csvContent) {
                  return json(res, 400, {
                    error: 'CSV_REQUIRED_FOR_PENDING_RECONCILIATION',
                    message: 'Submission is pending evaluation score. Please provide csvContent to reconcile.'
                  });
                }
                const evalResult = evaluateSubmission(csvContent);
                if (!evalResult.valid) {
                  await supabaseStore.finalizeMlSubmission({
                    submissionId: sub.id,
                    status: 'rejected',
                    errorMessage: evalResult.error
                  });
                  return json(res, 400, { error: 'VALIDATION_FAILED', message: evalResult.error });
                }
                r2 = evalResult.r2Score;
                mse = evalResult.mseScore;
                qualifies = evalResult.qualifiesForEscape;
              }

              if (qualifies) {
                await supabaseStore.finalizeQualifyingMlSubmission({
                  submissionId: sub.id,
                  teamId,
                  delegateId: ctx.delegateId || sub.delegate_id,
                  r2Score: r2,
                  mseScore: mse,
                  points: CANONICAL_STAGE_SCORES.purple?.points || 1000
                });
              } else {
                await supabaseStore.finalizeMlSubmission({
                  submissionId: sub.id,
                  r2Score: r2,
                  mseScore: mse,
                  qualifiesForEscape: false,
                  status: 'valid'
                });
              }

              const allSubs = await supabaseStore.getTeamSubmissions(teamId);
              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: r2,
                mseScore: mse,
                qualifiesForEscape: qualifies,
                message: qualifies ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission reconciled.',
                submissionsUsed: allSubs.length,
                submissionsRemaining: Math.max(0, 10 - allSubs.length),
                maxAllowed: 10
              });
            }

            return json(res, 400, { error: 'SUBMISSION_STATUS_INVALID', message: `Submission status is ${sub.status}` });
          } else {
            const state = await fallbackStore.read();
            const team = state.teams[teamId];
            if (!team) return json(res, 404, { error: 'TEAM_NOT_FOUND' });
            const sub = (team.mlSubmissions || []).find((s) => s.id === evaluationId);
            if (!sub) return json(res, 404, { error: 'NOT_FOUND', message: 'Submission not found' });

            if (sub.status === 'valid') {
              if (sub.qualifies_for_escape) {
                team.escapeUnlocked = true;
                if (!team.solvedCtfs.includes('purple-01')) {
                  team.solvedCtfs.push('purple-01');
                }
                team.completedZones = team.completedZones || [];
                if (!team.completedZones.includes('purple')) {
                  team.completedZones.push('purple');
                  team.score = (team.score || 0) + (CANONICAL_STAGE_SCORES.purple?.points || 1000);
                  team.events = team.events || [];
                  team.events.unshift({
                    at: new Date().toISOString(),
                    message: 'Sector PURPLE completed. Helicopter evacuation authorized!'
                  });
                }
                await fallbackStore.write(state);
              }
              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: sub.r2_score,
                mseScore: sub.mse_score,
                qualifiesForEscape: sub.qualifies_for_escape,
                message: sub.qualifies_for_escape ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission finalized.',
                submissionsUsed: team.mlSubmissions.length,
                submissionsRemaining: Math.max(0, 10 - team.mlSubmissions.length),
                maxAllowed: 10
              });
            }

            if (sub.status === 'pending') {
              let r2 = sub.r2_score;
              let mse = sub.mse_score;
              let qualifies = sub.qualifies_for_escape;
              if (r2 === null || r2 === undefined) {
                if (!csvContent) {
                  return json(res, 400, {
                    error: 'CSV_REQUIRED_FOR_PENDING_RECONCILIATION',
                    message: 'Submission is pending evaluation score. Please provide csvContent to reconcile.'
                  });
                }
                const evalResult = evaluateSubmission(csvContent);
                if (!evalResult.valid) {
                  sub.status = 'rejected';
                  sub.error_message = evalResult.error;
                  await fallbackStore.write(state);
                  return json(res, 400, { error: 'VALIDATION_FAILED', message: evalResult.error });
                }
                r2 = evalResult.r2Score;
                mse = evalResult.mseScore;
                qualifies = evalResult.qualifiesForEscape;
              }

              await finalizeAttemptFallback(ctx.teamId, sub.id, {
                r2Score: r2,
                mseScore: mse,
                qualifiesForEscape: qualifies,
                status: 'valid'
              });

              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: r2,
                mseScore: mse,
                qualifiesForEscape: qualifies,
                message: qualifies ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission reconciled.',
                submissionsUsed: team.mlSubmissions.length,
                submissionsRemaining: Math.max(0, 10 - team.mlSubmissions.length),
                maxAllowed: 10
              });
            }

            return json(res, 400, { error: 'SUBMISSION_STATUS_INVALID', message: `Submission status is ${sub.status}` });
          }
        } catch (recErr) {
          console.error('[reconcile error]', recErr);
          return json(res, 500, { error: 'RECONCILE_FAILED', message: recErr.message });
        }
      }

      // -------------------------------------------------------------------
      // 8.1 PURPLE ZONE SUBMISSION HISTORY
      // -------------------------------------------------------------------
      if (pathname === '/api/ml/submissions' && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to view submission history.' });
        const targetTeamId = ctx.teamId;
        try {
          let submissions = [];
          if (hasSupabase) {
            submissions = await supabaseStore.getTeamSubmissions(targetTeamId);
          } else {
            const state = await fallbackStore.read();
            submissions = state.teams[targetTeamId]?.mlSubmissions || [];
          }
          const submissionsUsed = submissions.length;
          const submissionsRemaining = Math.max(0, 10 - submissionsUsed);
          const alreadyCompleted = submissions.some(s => s.qualifies_for_escape);
          return json(res, 200, {
            submissions,
            submissionsUsed,
            submissionsRemaining,
            alreadyCompleted,
            maxAllowed: 10,
            at: new Date().toISOString()
          });
        } catch (err) {
          return json(res, 500, { error: 'FETCH_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 9. LIVE LEADERBOARD
      // -------------------------------------------------------------------
      if (pathname === '/api/leaderboard' && req.method === 'GET') {
        let board;
        if (hasSupabase) {
          board = await supabaseStore.getLeaderboard();
        } else {
          const state = await fallbackStore.read();
          board = Object.values(state.teams || {}).map((t) => {
            const escapeUnlocked = (t.completedZones || []).includes('purple') || (t.mlSubmissions || []).some((s) => s.qualifies_for_escape);
            const bestR2 = (t.mlSubmissions || []).reduce((max, s) => s.r2_score !== null && s.r2_score > max ? s.r2_score : max, null);
            return {
              team_id: t.id,
              team_name: t.name || t.id,
              total_score: t.score || 0,
              best_r2_score: bestR2,
              escape_unlocked: escapeUnlocked,
              last_score_at: t.lastScoreAt || null
            };
          }).sort((a, b) => b.total_score - a.total_score || (b.best_r2_score || 0) - (a.best_r2_score || 0));
        }
        return json(res, 200, { leaderboard: board, at: new Date().toISOString() });
      }

      // -------------------------------------------------------------------
      // 10. ATOMIC SERVER-TO-SERVER CHALLENGE COMPLETION (HMAC)
      // -------------------------------------------------------------------
      if (pathname === '/api/internal/complete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body.teamId !== 'string' || typeof body.ctfId !== 'string' || typeof body.signature !== 'string') {
          return json(res, 400, { error: 'INVALID_COMPLETION' });
        }
        const teamId = canonicalTeamId(body.teamId);
        const found = findCtf(body.ctfId);
        if (!found || !Number.isSafeInteger(Number(body.timestamp))) return json(res, 400, { error: 'INVALID_COMPLETION' });

        const secret = env[found.ctf.completion.secretEnv];
        if (!secret) return json(res, 503, { error: 'SECRET_NOT_CONFIGURED' });

        if (!validCtfSignature({ secret, teamId, ctfId: found.ctf.id, timestamp: body.timestamp, signature: body.signature })) {
          return json(res, 401, { error: 'INVALID_SIGNATURE' });
        }

        // Zone completion reward mappings
        const allZoneIds = found.zone.ctfs.map((c) => c.id);
        const stagePoints = CHALLENGE_SCORES[found.ctf.id] || 0;

        if (hasSupabase) {
          const rpcResult = await supabaseStore.completeChallenge({
            teamId,
            delegateId: body.delegateId || null,
            zoneId: found.zone.id,
            challengeId: found.ctf.id,
            points: stagePoints,
            allZoneChallenges: allZoneIds,
            nextZoneId: ZONE_NEXT_MAP[found.zone.id] || null,
            rewardDatasetKey: ZONE_REWARD_DATASETS[found.zone.id] || null
          });
          return json(res, 200, { ok: true, ...rpcResult });
        } else {
          const state = await fallbackStore.read();
          state.usedSignatures = state.usedSignatures || [];
          if (state.usedSignatures.includes(body.signature)) {
            return json(res, 409, { error: 'REPLAY_REJECTED' });
          }
          state.usedSignatures.push(body.signature);
          let team = state.teams[teamId];
          if (!team) {
            team = { id: teamId, name: teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
            state.teams[teamId] = team;
          }
          team.solvedCtfs = team.solvedCtfs || [];
          const newlySolved = !team.solvedCtfs.includes(found.ctf.id);
          if (newlySolved) {
            team.solvedCtfs.push(found.ctf.id);
            if (stagePoints > 0) {
              team.scoredChallenges = team.scoredChallenges || [];
              if (!team.scoredChallenges.includes(found.ctf.id)) {
                team.scoredChallenges.push(found.ctf.id);
                team.score = (team.score || 0) + stagePoints;
              }
            }
          }
          await fallbackStore.write(state);
          return json(res, 200, { ok: true, newlySolved });
        }
      }

      // -------------------------------------------------------------------
      // 11. DEV SIMULATION SOLVE
      // -------------------------------------------------------------------
      if (devToolsEnabled && pathname === '/api/dev/solve' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const body = await readBody(req);
        const found = findCtf(body.ctfId);
        if (!found) return json(res, 404, { error: 'CTF_NOT_FOUND' });

        const allZoneIds = found.zone.ctfs.map((c) => c.id);
        const stagePoints = CHALLENGE_SCORES[found.ctf.id] || 0;

        if (hasSupabase) {
          const rpcResult = await supabaseStore.completeChallenge({
            teamId: ctx.teamId,
            delegateId: ctx.delegateId,
            zoneId: found.zone.id,
            challengeId: found.ctf.id,
            points: stagePoints,
            allZoneChallenges: allZoneIds,
            nextZoneId: ZONE_NEXT_MAP[found.zone.id] || null,
            rewardDatasetKey: ZONE_REWARD_DATASETS[found.zone.id] || null
          });

          const nextBootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
          return json(res, 200, { ok: true, rpcResult, bootstrap: nextBootstrap });
        } else {
          const state = await fallbackStore.read();
          let team = state.teams[ctx.teamId];
          if (!team) {
            team = { id: ctx.teamId, name: ctx.teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
            state.teams[ctx.teamId] = team;
          }
          team.solvedCtfs = team.solvedCtfs || [];
          const newlySolved = !team.solvedCtfs.includes(found.ctf.id);
          if (newlySolved) {
            team.solvedCtfs.push(found.ctf.id);
            if (stagePoints > 0) {
              team.scoredChallenges = team.scoredChallenges || [];
              if (!team.scoredChallenges.includes(found.ctf.id)) {
                team.scoredChallenges.push(found.ctf.id);
                team.score = (team.score || 0) + stagePoints;
              }
            }
          }
          await fallbackStore.write(state);
          const bootstrap = buildFallbackBootstrap(team);
          return json(res, 200, { ok: true, newlySolved, bootstrap });
        }
      }

      // -------------------------------------------------------------------
      // 11.5 ADMIN ENDPOINTS (Protected with Admin Key or Admin Session)
      // -------------------------------------------------------------------
      if (pathname === '/api/admin/session' && req.method === 'GET') {
        const authed = isAuthorizedAdmin(req, url);
        return json(res, 200, { ok: true, authenticated: authed });
      }

      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const body = await readBody(req);
        const adminKey = body.adminKey || body.key;
        const expectedKey = getExpectedAdminKey();

        if (!expectedKey || !adminKey || !safeEqual(crypto.createHash('sha256').update(String(adminKey)).digest('hex'), crypto.createHash('sha256').update(String(expectedKey)).digest('hex'))) {
          return json(res, 401, { error: 'INVALID_ADMIN_KEY', message: 'Invalid admin master key.' });
        }

        setAdminSessionCookie(res);
        return json(res, 200, { ok: true, message: 'Admin authentication successful' });
      }

      if (pathname === '/api/admin/logout' && req.method === 'POST') {
        clearAdminSessionCookie(res);
        return json(res, 200, { ok: true, message: 'Admin session terminated' });
      }

      if (pathname === '/api/admin/overview' && req.method === 'GET') {
        if (!isAuthorizedAdmin(req, url)) {
          return json(res, 401, { error: 'UNAUTHORIZED', message: 'Valid x-admin-key header or admin session required.' });
        }

        let overview = null;
        if (hasSupabase) {
          try {
            overview = await supabaseStore.getAdminOverview();
          } catch (err) {
            console.warn('[admin-overview] Supabase query error, using local fallback:', err.message);
          }
        }
        if (!overview) {
          const state = await fallbackStore.read();
          overview = buildFallbackAdminOverview(state);
        }
        return json(res, 200, { ok: true, totalPointsPossible: TOTAL_COMPETITION_POINTS, ...overview });
      }

      if (pathname === '/api/admin/import-roster' && req.method === 'POST') {
        if (!isAuthorizedAdmin(req, url)) {
          return json(res, 401, { error: 'UNAUTHORIZED', message: 'Valid x-admin-key header or admin session required.' });
        }

        const body = await readBody(req);
        let roster = Array.isArray(body?.teams) ? body.teams : null;
        if (!roster) {
          const rosterPath = path.join(baseDir, 'data', 'teams_roster.json');
          if (fs.existsSync(rosterPath)) {
            try {
              roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
            } catch (err) {
              return json(res, 500, { error: 'ROSTER_READ_FAILED', message: err.message });
            }
          }
        }

        if (!Array.isArray(roster) || roster.length === 0) {
          return json(res, 400, { error: 'NO_ROSTER_DATA', message: 'No roster teams found in body or data/teams_roster.json' });
        }

        let result = { success: true, importedTeams: 0, importedMembers: 0 };
        if (hasSupabase) {
          try {
            result = await supabaseStore.importRoster(roster);
          } catch (err) {
            console.error('[import-roster] Supabase import error:', err);
          }
        }

        // Always sync fallbackStore for offline resilience and local parity
        try {
          const state = await fallbackStore.read();
          state.teams = state.teams || {};
          for (const team of roster) {
            state.teams[team.id] = {
              id: team.id,
              name: team.team_name,
              createdAt: state.teams[team.id]?.createdAt || new Date().toISOString(),
              solvedCtfs: state.teams[team.id]?.solvedCtfs || [],
              events: state.teams[team.id]?.events || [],
              members: (team.members || []).map((m) => m.delegate_id),
              studentType: team.student_type,
              leaderName: team.team_leader_name,
              leaderMobile: team.leader_mobile
            };
          }
          await fallbackStore.write(state);
        } catch (storeErr) {
          console.error('[import-roster] Fallback store sync error:', storeErr);
        }

        return json(res, 200, {
          ok: true,
          ...result,
          rosterCount: roster.length
        });
      }

      if (pathname === '/api/admin/clean-test-data' && req.method === 'POST') {
        if (!isAuthorizedAdmin(req, url)) {
          return json(res, 401, { error: 'UNAUTHORIZED', message: 'Valid x-admin-key header or admin session required.' });
        }

        const body = await readBody(req);
        const targetTeamId = body?.teamId ? canonicalTeamId(body.teamId) : null;

        let dbResult = { success: true };
        if (hasSupabase) {
          try {
            dbResult = await supabaseStore.cleanupTestData(targetTeamId);
          } catch (err) {
            console.error('[clean-test-data] Supabase clean error:', err);
            return json(res, 500, { error: 'CLEANUP_FAILED', message: err.message });
          }
        }

        // Clean local fallback store as well
        try {
          const state = await fallbackStore.read();
          state.teams = state.teams || {};
          const purged = [];
          for (const key of Object.keys(state.teams)) {
            if (!key.startsWith('TECHTEAM')) {
              delete state.teams[key];
              purged.push(key);
            }
          }
          const teamsToReset = ['TECHTEAM10328'];
          if (targetTeamId && !teamsToReset.includes(targetTeamId)) {
            teamsToReset.push(targetTeamId);
          }
          for (const id of teamsToReset) {
            if (state.teams[id]) {
              state.teams[id].solvedCtfs = [];
              state.teams[id].events = [];
              state.teams[id].mlSubmissions = [];
              state.teams[id].completedZones = [];
              state.teams[id].unlockedZones = [];
              state.teams[id].datasets = [];
              state.teams[id].sanctuaryCompleted = false;
              delete state.teams[id].bestR2;
            }
          }
          await fallbackStore.write(state);
          dbResult.purgedFallbackTeams = purged;
        } catch (_) {}

        return json(res, 200, { ok: true, ...dbResult });
      }

      if (pathname === '/api/admin/set-team-zones' && req.method === 'POST') {
        if (!isAuthorizedAdmin(req, url)) {
          return json(res, 401, { error: 'UNAUTHORIZED', message: 'Valid x-admin-key header or admin session required.' });
        }

        const body = await readBody(req);
        const teamId = canonicalTeamId(body?.teamId);
        if (!teamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });

        if (hasSupabase) {
          try {
            await supabaseStore.setTeamZones({
              teamId,
              score: typeof body.score === 'number' ? body.score : undefined,
              zones: body.zones,
              datasets: body.datasets,
              solvedChallenges: body.solvedChallenges
            });
            const bootstrap = await supabaseStore.getTeamBootstrap(teamId, null, config);
            return json(res, 200, { ok: true, teamId, bootstrap });
          } catch (err) {
            return json(res, 500, { error: 'SET_ZONES_FAILED', message: err.message });
          }
        } else {
          const state = await fallbackStore.read();
          let team = state.teams[teamId];
          if (!team) {
            team = { id: teamId, name: teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], completedZones: [] };
            state.teams[teamId] = team;
          }
          if (typeof body.score === 'number') team.score = body.score;
          if (body.zones) {
            team.completedZones = Object.entries(body.zones).filter(([_, s]) => s === 'completed').map(([z]) => z);
            team.unlockedZones = Object.entries(body.zones).filter(([_, s]) => s !== 'locked').map(([z]) => z);
          }
          if (Array.isArray(body.datasets)) team.datasets = body.datasets;
          await fallbackStore.write(state);
          const bootstrap = buildFallbackBootstrap(team);
          return json(res, 200, { ok: true, teamId, bootstrap });
        }
      }

      // -------------------------------------------------------------------
      // 12. STATIC FILES & HTML (PRESERVED THREE.JS / SCENE FILES)
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }

      let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
        relative = path.join('admin', 'index.html');
      }
      let filePath = path.resolve(publicDir, relative);
      if (!filePath.startsWith(staticRoot)) { res.writeHead(403); return res.end('Forbidden'); }

      let actualPath = filePath;
      if (fs.existsSync(actualPath) && fs.statSync(actualPath).isDirectory()) {
        const indexCandidate = path.join(actualPath, 'index.html');
        if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) {
          actualPath = indexCandidate;
        }
      }

      if (!fs.existsSync(actualPath) || !fs.statSync(actualPath).isFile()) {
        const staticMap = {
          'index.html': path.join(publicDir, 'index.html'),
          'admin': path.join(publicDir, 'admin', 'index.html'),
          'admin/': path.join(publicDir, 'admin', 'index.html'),
          'admin.html': path.join(publicDir, 'admin', 'index.html'),
          [path.join('admin', 'index.html')]: path.join(publicDir, 'admin', 'index.html'),
          'admin/admin.css': path.join(publicDir, 'admin', 'admin.css'),
          'admin/admin.js': path.join(publicDir, 'admin', 'admin.js'),
          'app.js': path.join(publicDir, 'app.js'),
          'styles.css': path.join(publicDir, 'styles.css'),
          'scene.js': path.join(publicDir, 'scene.js'),
          'mock-ctf.js': path.join(publicDir, 'mock-ctf.js')
        };
        actualPath = staticMap[relative] || actualPath;
      }
      if (!actualPath || !actualPath.startsWith(staticRoot) || !fs.existsSync(actualPath) || !fs.statSync(actualPath).isFile()) {
        actualPath = path.join(publicDir, 'index.html');
      }

      const stat = fs.statSync(actualPath);
      const ext = path.extname(actualPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      if (req.method === 'HEAD') return res.end();
      res.end(fs.readFileSync(actualPath));
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || 500;
      if (status >= 500) console.error('[hub]', error);
      return json(res, status, { error: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: error.message });
    }
  };

  const server = require('node:http').createServer(handler);
  server.handler = handler;
  server.hub = { config, isProduction, devToolsEnabled };
  return server;
}

module.exports = { createHubServer, htmlEscape };
