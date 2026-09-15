'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rainDevices, rainState } = require('../lib/RainSensorState');
const controller = { id: 42, name: 'Garden', online: true, sensors: [
  { id: 9, name: 'Rain', model: { name: 'Rain Sensor', sensorType: 'LEVEL_OPEN' }, status: { active: false } },
  { id: 10, name: 'Flow', model: { name: 'Flow meter', sensorType: 'FLOW' }, status: { active: true } },
] };
test('only discover rain sensors with immutable controller/sensor identity', () => {
  assert.deepEqual(rainDevices([controller]).map(d => d.data), [{ id: '42:9', controllerId: 42, sensorId: 9 }]);
});
test('use the sensor active boolean, not watering or configuration state', () => {
  assert.equal(rainState([controller], { controllerId: 42, sensorId: 9 }), false);
  const wet = structuredClone(controller); wet.sensors[0].status.active = true;
  assert.equal(rainState([wet], { controllerId: 42, sensorId: 9 }), true);
});
test('null, missing, offline and removed sensors never become dry', () => {
  for (const value of [null, undefined, 'false', 0]) {
    const c = structuredClone(controller); c.sensors[0].status.active = value;
    assert.throws(() => rainState([c], { controllerId: 42, sensorId: 9 }));
  }
  assert.throws(() => rainState([{ ...controller, online: false }], { controllerId: 42, sensorId: 9 }));
  assert.throws(() => rainState([], { controllerId: 42, sensorId: 9 }));
});
