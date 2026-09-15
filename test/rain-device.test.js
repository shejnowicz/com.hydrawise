'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const state = require('../lib/RainSensorState');
const sandbox = { module: { exports: {} }, require: id => id === 'homey' ? { Device: class {} } : state };
vm.runInNewContext(fs.readFileSync(require.resolve('../drivers/rain_sensor/device'), 'utf8'), sandbox);
const Device = sandbox.module.exports;
const wet = [{ id: 42, online: true, sensors: [{ id: 9, status: { active: true } }] }];
function setup(client) {
  const d = new Device(); const events = []; const intervals = [];
  d.driver = { client, message: e => e.message };
  d.homey = { __: s => s, setInterval: (fn, ms) => { intervals.push({fn, ms}); return 1; }, clearInterval: id => events.push(['clear', id]) };
  d.getData = () => ({ controllerId: 42, sensorId: 9 });
  d.setCapabilityValue = async (key, value) => events.push(['value', key, value]);
  d.setAvailable = async () => events.push(['available']);
  d.setUnavailable = async message => events.push(['unavailable', message]);
  return { d, events, intervals };
}
test('initial read sets real alarm state immediately and schedules updates', async () => {
  const { d, events, intervals } = setup({ controllers: async () => wet });
  await d.onInit(); assert.deepEqual(events.slice(-2), [['value', 'alarm_generic', true], ['available']]);
  assert.equal(intervals[0].ms, 60000);
});
test('network failure marks unavailable without inventing a dry transition', async () => {
  let failure = false;
  const { d, events } = setup({ controllers: async () => { if (failure) throw new Error('connection_failed'); return wet; } });
  await d.onInit(); failure = true; await d.poll();
  assert.deepEqual(events.at(-1), ['unavailable', 'connection_failed']);
  assert.equal(events.filter(e => e[0] === 'value').length, 1);
});
test('late replies cannot revive deleted devices', async () => {
  let resolve;
  const { d, events } = setup({ controllers: () => new Promise(r => { resolve = r; }) });
  const init = d.onInit(); await new Promise(r => setImmediate(r));
  await d.onDeleted(); resolve(wet); await init;
  assert.ok(events.some(e => e[0] === 'clear'));
  assert.ok(!events.some(e => e[0] === 'value' || e[0] === 'available'));
});
test('an old account response is ignored after repair replaces its client', async () => {
  let resolve;
  const { d, events } = setup({ controllers: () => new Promise(r => { resolve = r; }) });
  const init = d.onInit(); await new Promise(r => setImmediate(r));
  d.driver.client = { controllers: async () => [] }; resolve(wet); await init;
  assert.ok(!events.some(e => e[0] === 'value'));
});
