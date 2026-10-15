const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpstashStore } = require('../lib/store');

test('Upstash store initializes, persists state, and releases its distributed lock', async () => {
  const priorFetch = global.fetch;
  const kv = new Map();
  let lockValue = null;
  global.fetch = async (_url, options) => {
    const [command, ...args] = JSON.parse(options.body);
    let result = null;
    if (command === 'GET') result = kv.has(args[0]) ? kv.get(args[0]) : null;
    else if (command === 'SET') {
      const [key, value, ...flags] = args;
      if (flags.includes('NX') && (key === 'last-dataset-map-hub:state:v1:lock' ? lockValue !== null : kv.has(key))) result = null;
      else {
        if (key === 'last-dataset-map-hub:state:v1:lock') lockValue = value;
        else kv.set(key, value);
        result = 'OK';
      }
    } else if (command === 'EVAL') {
      const [, , key, token] = args;
      if (key === 'last-dataset-map-hub:state:v1:lock' && lockValue === token) { lockValue = null; result = 1; }
      else result = 0;
    } else throw new Error(`Unexpected command ${command}`);
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const store = createUpstashStore({
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'unit-test-token'
    });
    const release = await store.acquireLock();
    const state = await store.read();
    assert.deepEqual(state.teams, {});
    state.teams['TEAM-1'] = { id: 'TEAM-1', solvedCtfs: [] };
    await store.write(state);
    await release();
    assert.equal(lockValue, null);

    const nextRelease = await store.acquireLock();
    const restored = await store.read();
    assert.deepEqual(restored.teams['TEAM-1'], { id: 'TEAM-1', solvedCtfs: [] });
    await nextRelease();
  } finally {
    global.fetch = priorFetch;
  }
});
