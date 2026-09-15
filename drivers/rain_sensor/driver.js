'use strict';
const Homey = require('homey');
const HydrawiseSensors = require('../../lib/HydrawiseSensors');
const { rainDevices } = require('../../lib/RainSensorState');
const AUTH_KEY = 'rainSensorAuth';

class RainSensorDriver extends Homey.Driver {
  async onInit() {
    this.createClient();
  }

  createClient() {
    const generation = this.generation = (this.generation || 0) + 1;
    this.client = new HydrawiseSensors({
      load: () => this.homey.settings.get(AUTH_KEY),
      save: auth => {
        if (this.generation !== generation) throw new Error('login_required');
        this.homey.settings.set(AUTH_KEY, auth);
      },
    });
  }

  async configureLogin(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      try {
        const auth = await this.client.login(username, password);
        const existing = this.homey.settings.get(AUTH_KEY);
        const devices = this.getDevices();
        if (devices.some(d => d.getData().accountId !== auth.accountId) ||
            (devices.length && existing && existing.accountId !== auth.accountId)) {
          throw new Error('different_account');
        }
        this.homey.settings.set(AUTH_KEY, auth);
        this.createClient();
        if (device) await device.poll();
        return true;
      } catch (error) {
        throw new Error(this.message(error));
      }
    });
  }

  message(error) {
    const keys = ['login_required', 'connection_failed', 'rate_limited', 'invalid_response', 'sensor_unavailable', 'different_account'];
    return this.homey.__(`rain_sensor.${keys.includes(error.message) ? error.message : 'connection_failed'}`);
  }

  async onPair(session) {
    await this.configureLogin(session);
    session.setHandler('list_devices', async () => {
      try {
        const client = this.client;
        const controllers = await client.controllers();
        if (client !== this.client) throw new Error('login_required');
        const accountId = this.homey.settings.get(AUTH_KEY).accountId;
        return rainDevices(controllers).map(device => ({ ...device, data: { ...device.data, accountId } }));
      }
      catch (error) { throw new Error(this.message(error)); }
    });
  }

  async onRepair(session, device) {
    await this.configureLogin(session, device);
  }
}
module.exports = RainSensorDriver;
