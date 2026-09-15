'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const { RateLimit, MIN_BACKOFF_MS } = require('../lib/RateLimit');

// Zone.js pulls in `homey`, which only exists inside the app runtime, and
// axios through ./httpService. Stub both before requiring it.
const realResolve = Module._resolveFilename;
const stubs = new Map();
Module._resolveFilename = function (request, ...rest) {
  if (stubs.has(request)) return request;
  return realResolve.call(this, request, ...rest);
};
function stub(name, exports) {
  stubs.set(name, true);
  require.cache[name] = { id: name, filename: name, loaded: true, exports };
}
stub('homey', { SimpleClass: class { log() {} } });

let getCalls = [];
let getImpl = async () => ({ data: { relays: [] } });
stub('./httpService', { get: (...args) => { getCalls.push(args); return getImpl(...args); } });

const ZoneHelper = require('../lib/Zone');

function makeZone() {
  const helper = new ZoneHelper({ settings: { get: () => 'key' } });
  helper.log = () => {};
  return helper;
}

function device(relayId, controllerId = 'c1', apiKey = 'k1') {
  return {
    getData: (field) => (field === 'controllerId' ? { controllerId } : field === 'apiKey' ? { apiKey } : { id: relayId }),
    updateStatus: () => {},
    setUnavailable: () => {},
    getRemainingDuration: () => 0,
  };
}

test.beforeEach(() => {
  getCalls = [];
  getImpl = async () => ({ data: { relays: [{ relay_id: 1 }, { relay_id: 2 }] } });
});

test('six zones polled in parallel issue ONE request, not six', async () => {
  const zone = makeZone();
  // Resolve only after every caller has started, reproducing the real race:
  // app.js fires all devices' updates before the first response lands.
  let release;
  getImpl = () => new Promise((resolve) => { release = () => resolve({ data: { relays: [{ relay_id: 1 }] } }); });

  const devices = [1, 2, 3, 4, 5, 6].map((id) => device(id));
  const all = Promise.all(devices.map((d) => zone.updateZoneStatus(d, 7)));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(getCalls.length, 1, 'the batch must collapse to a single call');
  release();
  await all;
});

test('a new polling loop fetches again', async () => {
  const zone = makeZone();
  await zone.updateZoneStatus(device(1), 1);
  await zone.updateZoneStatus(device(1), 2);
  assert.strictEqual(getCalls.length, 2);
});

test('zones on different controllers each get their own request', async () => {
  const zone = makeZone();
  await Promise.all([
    zone.updateZoneStatus(device(1, 'c1', 'k1'), 5),
    zone.updateZoneStatus(device(2, 'c2', 'k2'), 5),
  ]);
  assert.strictEqual(getCalls.length, 2);
});

test('a failed batch is not reused by the next loop', async () => {
  const zone = makeZone();
  getImpl = async () => { throw new Error('boom'); };
  await zone.updateZoneStatus(device(1), 1);
  getImpl = async () => ({ data: { relays: [{ relay_id: 1 }] } });
  await zone.updateZoneStatus(device(1), 2);
  assert.strictEqual(getCalls.length, 2);
});

test('a 429 surfaces as rate_limited and blocks further calls during the cool-off', async () => {
  const zone = makeZone();
  const err = new Error('429');
  err.response = { status: 429, headers: { 'retry-after': '120' } };
  getImpl = async () => { throw err; };

  await assert.rejects(() => zone.doRequest('u', {}), /rate_limited:\d+/);
  const afterFirst = getCalls.length;
  // The second call must not reach the network at all.
  await assert.rejects(() => zone.doRequest('u', {}), /rate_limited:\d+/);
  assert.strictEqual(getCalls.length, afterFirst, 'no request may be spent during the penalty');
});

test('RateLimit floors the cool-off and accepts both Retry-After shapes', () => {
  let now = 1000;
  const limit = new RateLimit({ now: () => now });
  assert.strictEqual(limit.limited, false);

  limit.penalise('5'); // server asks for less than the floor
  assert.strictEqual(limit.remaining, MIN_BACKOFF_MS);

  limit.clear();
  limit.penalise(new Date(now + 300000).toUTCString()); // HTTP-date form
  assert.ok(limit.remaining > MIN_BACKOFF_MS);

  limit.clear();
  limit.penalise(undefined); // unparseable must not mean "retry now"
  assert.strictEqual(limit.remaining, MIN_BACKOFF_MS);

  now += MIN_BACKOFF_MS + 1;
  assert.strictEqual(limit.limited, false);
});
