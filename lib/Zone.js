const http = require("./httpService");
const { SimpleClass } = require("homey");
const _ = require("lodash");

const STATUS_ZONE_URL = "statusschedule.php";
const SET_ZONE_URL = "setzone.php";
const { RateLimit } = require("./RateLimit");

// One gate for every legacy-API call the app makes, so a 429 triggered by
// polling also holds back zone commands (and vice versa) — they share the
// account's quota, so they must share the penalty.
const rateLimit = new RateLimit();
const CUSTOMER_DETAILS_URL = "customerdetails.php";

const DEFAULT_DURATION = 5; //minutes

module.exports = class ZoneHelper extends SimpleClass {
  constructor(Homey) {
    super();
    this.homey = Homey;
    this.lastBatchID = 0;
    this.data;
    return this;
  }

  async getZones() {
    let zones = [];
    const url = this.getUrl(STATUS_ZONE_URL);
    let params = "";
    const controllers = await this.getControllers();
    
    for( let i = 0; i<controllers.length; i++){
      const apiKey = this.homey.settings.get("api_key");
      const params = this.getParameters("", apiKey, controllers[i]);

      const data = await this.doRequest(url, params);
      
      //convert JSON to Array
      Object.values(data.relays).map(function (relay) {
        zones.push({
          name: relay.name,
          data: { id: relay.relay_id, controllerId: controllers[i], apiKey: apiKey },
          settings: { duration: 15 },
        });
      })
  };
  return zones;
  }

  async getControllers() {
    const controllers = [];
    const url = this.getUrl(CUSTOMER_DETAILS_URL);
    const params = this.getParameters("");
    const data = await this.doRequest(url, params);
    //convert JSON to Array
    Object.values(data.controllers).map(function (controller) {
      controllers.push(
        controller.controller_id,
      );
    });
    return controllers;
  }

  async runAllZones(options, controllerId) {
    const url = this.getUrl(SET_ZONE_URL);
    const duration = options.duration * 60; // convert to seconds
    const action = "runall";
    const apiKey = null
    //create the specific parameter part of the url
    const params = this.getParameters({
      params: {
        action: action,
        period_id: 999,
        custom: duration,
      },
      apiKey,
      controllerId,
    });
    try {
      await this.doRequest(url, params);
      this.homey.app.setAllDevicesOnOff(true, duration );
    } catch (ex) {
      this.log(ex);
    }
  }

  async stopAllZones( controllerId) {
    const url = this.getUrl(SET_ZONE_URL);
    const action = "stopall";
    const apiKey = null;

    //create the specific parameter part of the url
    const params = this.getParameters({
      params: { action: action }, apiKey,
      controllerId
    });
    try {
      await this.doRequest(url, params);
      //reset the device onoff property to off
      this.homey.app.setAllDevicesOnOff(false, 0 );
    } catch (ex) {
      this.log(ex);
    }
  }

  async startstopZone(onoff, options, device) {
    const url = this.getUrl(SET_ZONE_URL);
    //convert duration to minutes -> here we get them as seconds
    //options.duration = options.duration / 1000;
    const duration = this.getDuration(options, device);

    const relayId = device.getData("id").id;
    const controllerId = device.getData("controllerId").controllerId;
    const apiKey = device.getData( "apiKey").apiKey;
    const action = onoff ? "run" : "stop";

    //create the specific parameter part of the url
    const params = this.getParameters({
      params: {
        action: action,
        period_id: 999,
        relay_id: relayId,
        custom: duration,
      }
    }, apiKey, controllerId);

    try {
      await this.doRequest(url, params);
      device.updateRemainingDuration( onoff, duration );
      device.updateRunning( onoff );

      //start polling if not already started (stopping will done in the status update when polling)
      if (this.homey.app.timerId === null && action === "run") {
        this.homey.app.startPolling();
      }
    } catch (ex) {
      if (device) {
        await device.setUnavailable(ex);
      } else {
        this.log(ex);
      }
    }
  }

  async setWateringDuration( duration, options, device )
  {
    //do nothing
  }

  /**
   * ONE status request per controller per polling loop, shared by every zone
   * device on it.
   *
   * The previous guard (`if (batchID != this.lastBatchID)`, with the marker
   * assigned only AFTER the await) could not do this: app.js starts every
   * device's update in parallel, so each one saw the marker still unchanged
   * and issued its own request. With six zones that is six simultaneous
   * calls a minute against an account Hunter rate-limits — the 429 the user
   * hit when starting a zone.
   *
   * Keying by controller+key rather than a single shared field also fixes a
   * latent bug for multi-controller accounts, which previously had every
   * zone read whichever controller answered last.
   */
  batchedStatus(key, batchID, url, params) {
    if (!this.statusBatch) this.statusBatch = new Map();
    const cached = this.statusBatch.get(key);
    if (cached && cached.batchID === batchID) return cached.promise;

    const promise = this.doRequest(url, params);
    this.statusBatch.set(key, { batchID, promise });
    // A failed batch must not be served to the next loop as if it were fresh.
    promise.catch(() => {
      const current = this.statusBatch.get(key);
      if (current && current.promise === promise) this.statusBatch.delete(key);
    });
    return promise;
  }

  async updateZoneStatus(device, batchID) {
    const url = this.getUrl(STATUS_ZONE_URL);
    const controllerId = device.getData("controllerId").controllerId;
    const apiKey = device.getData( "apiKey").apiKey;
    const params = this.getParameters("", apiKey, controllerId);

    try {
      const data = await this.batchedStatus(`${controllerId}|${apiKey}`, batchID, url, params);
      const selectedRelay = Object.values(data.relays).find(
        (relay) => relay.relay_id === device.getData().id
      );
       
      if ( selectedRelay != null ){
        await device.updateStatus(selectedRelay);
        await device.setAvailable();
      }
    } catch (ex) {
      if (device) {
        await device.setUnavailable(ex);
      } else {
        this.log(ex);
      }
    }
  }

  async doRequest(url, params) {
    // Hunter rate-limits the cloud per account. Refuse to spend a request
    // while a 429 cool-off is running: hammering the API during the penalty
    // is what keeps it renewed, and the user gets a clear "try again in N s"
    // instead of a raw 429 (the zone path had no 429 handling at all — only
    // the GraphQL sensor client did).
    if (rateLimit.limited) {
      const seconds = Math.ceil(rateLimit.remaining / 1000);
      return Promise.reject(new Error(`rate_limited:${seconds}`));
    }
    //execute the request
    try {
      const { data } = await http.get(url, params);
      //status 200 but Homey didn't manage to start/stop
      if (data && data.message_type === "error") {
        throw new Error(data.message);
      }
      rateLimit.clear();
      return data;
    } catch (ex) {
      if (ex && ex.response && ex.response.status === 429) {
        rateLimit.penalise(ex.response.headers && ex.response.headers["retry-after"]);
        const seconds = Math.ceil(rateLimit.remaining / 1000);
        return Promise.reject(new Error(`rate_limited:${seconds}`));
      }
      return Promise.reject(new Error(ex));
    }
  }

  getUrl(suburl) {
    return "http://api.hydrawise.com/api/v1/" + suburl;
  }

  getParameters(addOnParams, apikey, controller) {
    let apiKey = apikey
    if ( apiKey === undefined || apiKey===null){
      apiKey = this.homey.settings.get("api_key");
    }

    let apiParam = ""
    if ( controller===undefined || controller===null ){
      apiParam = { params: { api_key: apiKey} };
    } else
    {
      apiParam = { params: { api_key: apiKey, controller_id: controller } };
    }
    return _.merge(apiParam, addOnParams);
  }

  getDuration(options, device) {
    //duration always in minutes -> need to convert to seconds
    let duration = DEFAULT_DURATION * 60 ;
    if ( options.duration ){
      duration = options.duration/1000;
    } else if (device) {
      duration = Number( device.getCapabilityValue( "watering_duration" ) ) * 60;//device.getSetting("duration") * 60;
    }
    return duration;
  }
};
