'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Client = require('../lib/HydrawiseSensors');
const state = require('../lib/RainSensorState');
const sandbox = { module: { exports: {} }, require: id => id === 'homey' ? { Driver: class {} } : id.includes('HydrawiseSensors') ? Client : state };
vm.runInNewContext(fs.readFileSync(require.resolve('../drivers/rain_sensor/driver'), 'utf8'), sandbox);
const Driver = sandbox.module.exports;
async function setup() {
  const values = new Map(); const handlers = {}; const d = new Driver();
  d.homey = { settings: { get: key => values.get(key), set: (key, value) => values.set(key, value) }, __: s => s };
  d.getDevices = () => [];
  await d.onInit(); await d.onPair({ setHandler: (name, handler) => { handlers[name] = handler; } });
  return { d, values, handlers };
}
test('failed login never overwrites working auth or exposes raw error text', async () => {
  const { d, values, handlers } = await setup();
  const original = { accountId: 1, refresh: 'original' }; values.set('rainSensorAuth', original);
  d.client.login = async () => { throw new Error('password-secret'); };
  await assert.rejects(handlers.login({ username: 'u', password: 'p' }), { message: 'rain_sensor.connection_failed' });
  assert.equal(values.get('rainSensorAuth'), original);
});
test('paired device identity prevents a different account even if auth was lost', async () => {
  const { d, values, handlers } = await setup();
  d.getDevices = () => [{ getData: () => ({ accountId: 1 }) }];
  d.client.login = async () => ({ accountId: 2, refresh: 'other' });
  await assert.rejects(handlers.login({ username: 'u', password: 'p' }), { message: 'rain_sensor.different_account' });
  assert.equal(values.has('rainSensorAuth'), false);
});
test('rotated token from a replaced client cannot overwrite repaired authentication', async () => {
  const { d, values } = await setup(); const old = d.client;
  const repaired = { accountId: 1, refresh: 'new' }; values.set('rainSensorAuth', repaired); d.createClient();
  assert.throws(() => old.save({ accountId: 1, refresh: 'old' }), /login_required/);
  assert.equal(values.get('rainSensorAuth'), repaired);
});
