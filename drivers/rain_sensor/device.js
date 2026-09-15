'use strict';
const Homey = require('homey');
const { rainState } = require('../../lib/RainSensorState');

class RainSensorDevice extends Homey.Device {
  async onInit() {
    this.stopped = false;
    this.pending = null;
    await this.setUnavailable(this.homey.__('rain_sensor.loading'));
    this.timer = this.homey.setInterval(() => this.poll().catch(() => {}), 60000);
    await this.poll();
  }

  async poll() {
    if (this.stopped) return;
    if (this.pending) return this.pending;
    this.pending = this.updateRain().finally(() => { this.pending = null; });
    return this.pending;
  }

  async updateRain() {
    const client = this.driver.client;
    try {
      const controllers = await client.controllers();
      if (this.stopped || this.driver.client !== client) return;
      const active = rainState(controllers, this.getData());
      await this.setCapabilityValue('alarm_generic', active);
      if (!this.stopped) await this.setAvailable();
    } catch (error) {
      // Do not turn a failed/unknown observation into a false dry reading.
      if (!this.stopped && this.driver.client === client) await this.setUnavailable(this.driver.message(error));
    }
  }

  async onUninit() {
    this.stopped = true;
    if (this.timer) this.homey.clearInterval(this.timer);
  }
  async onDeleted() { await this.onUninit(); }
}
module.exports = RainSensorDevice;
