'use strict';

// Match the upstream Hydrawise model, not the user-editable device name.
// Unknown/custom models need verification before being labelled rain sensors.
function rainDevices(controllers) {
  return controllers.flatMap(controller => (controller.sensors || [])
    .filter(sensor => /rain sensor/i.test(sensor.model?.name || ''))
    .map(sensor => ({
      name: `${sensor.name} (${controller.name})`,
      data: { id: `${controller.id}:${sensor.id}`, controllerId: controller.id, sensorId: sensor.id },
    })));
}

function rainState(controllers, data) {
  const controller = controllers.find(c => c.id === data.controllerId);
  const sensor = controller?.sensors?.find(s => s.id === data.sensorId);
  if (controller?.online !== true || typeof sensor?.status?.active !== 'boolean') {
    throw new Error('sensor_unavailable');
  }
  return sensor.status.active;
}
module.exports = { rainDevices, rainState };
