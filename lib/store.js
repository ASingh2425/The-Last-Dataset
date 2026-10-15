const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function initialState() {
  return { teams: {}, sessions: {}, usedSignatures: [], schemaVersion: 1 };
}

function validateState(value, source) {
  if (!value || typeof value !== 'object' || !value.teams || !value.sessions) {
    throw new Error(`Invalid progress state in ${source}.`);
  }
  if (!Array.isArray(value.usedSignatures)) {
    value.usedSignatures = [];
  }
  return value;
}

function createLocalLock() {
  let tail = Promise.resolve();
  return async function acquireLock() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const previous = tail;
    tail = previous.then(() => next, () => next);
    await previous;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      release();
    };
  };
}

function createStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(initialState(), null, 2));
  const acquireLock = createLocalLock();
  function read() {
    try {
      return validateState(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
    } catch (error) {
      throw new Error(`Cannot read progress store ${filePath}: ${error.message}`);
    }
  }
  function write(state) {
    const temp = `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    try {
      fs.renameSync(temp, filePath);
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
        try {
          fs.copyFileSync(temp, filePath);
          fs.unlinkSync(temp);
        } catch (_) {
          fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
          try { fs.unlinkSync(temp); } catch (_) {}
        }
      } else {
        throw err;
      }
    }
  }
  return { filePath, read, write, acquireLock, initialState };
}

/**
 * Durable, serverless-safe state store backed by Upstash Redis REST.
 * The hub serializes stateful requests with a short-lived distributed lock so its
 * whole-document JSON representation is not overwritten by concurrent requests.
 */
function createUpstashStore(env = process.env) {
  const baseUrl = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!baseUrl || !token) {
    if (env.NODE_ENV === 'production' || env.VERCEL) {
      throw new Error('FATAL: Upstash Redis credentials (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN) are missing in production. In-memory store cannot be used in serverless/production.');
    }
    let memoryState = initialState();
    return {
      filePath: 'memory',
      read: async () => memoryState,
      write: async (state) => { memoryState = state; },
      acquireLock: async () => () => {},
      initialState
    };
  }
  const stateKey = env.UPSTASH_STATE_KEY || 'last-dataset-map-hub:state:v1';
  const lockKey = `${stateKey}:lock`;
  async function command(...args) {
    let response;
    try {
      response = await fetch(baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
      });
    } catch (error) {
      throw new Error(`Progress database request failed: ${error.message}`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(`Progress database rejected a command (${response.status}).`);
    return payload.result;
  }
  async function read() {
    const raw = await command('GET', stateKey);
    if (raw == null) {
      const init = JSON.stringify(initialState());
      await command('SET', stateKey, init, 'NX');
      const seeded = await command('GET', stateKey);
      return validateState(JSON.parse(seeded || init), stateKey);
    }
    try { return validateState(JSON.parse(raw), stateKey); }
    catch (error) { throw new Error(`Cannot read progress store ${stateKey}: ${error.message}`); }
  }
  async function write(state) {
    await command('SET', stateKey, JSON.stringify(state));
  }
  async function acquireLock() {
    const value = crypto.randomUUID();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const acquired = await command('SET', lockKey, value, 'NX', 'PX', '30000');
      if (acquired === 'OK') {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          // Compare-and-delete; never release a lock owned by another invocation.
          await command('EVAL', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", '1', lockKey, value);
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 120 + Math.floor(Math.random() * 160)));
    }
    throw Object.assign(new Error('Progress store is busy. Retry the request.'), { status: 503 });
  }
  return { read, write, acquireLock, initialState, kind: 'upstash-redis' };
}

module.exports = { createStore, createUpstashStore, initialState };
