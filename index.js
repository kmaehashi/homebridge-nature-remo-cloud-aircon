const request = require('request');
const cron = require('cron');
const EventEmitter = require('events');

const DEFAULT_REQUEST_OPTIONS = {
  baseUrl: 'https://api.nature.global/1/',
  method: 'GET'
};

const RESPONSE_KEYS_BY_REQUEST_KEY = {
  'temperature': 'temp',
  'operation_mode': 'mode',
  'air_volume': 'vol',
  'air_direction': 'dir',
  'button': 'button'
}

let hap;

// Singleton cron.CronJob that updates appliances and devices.
let updater = null;

// eventHandler emits events when updater has updated appliances and devices.
const eventHandler = {};
Object.assign(eventHandler, EventEmitter.prototype);

module.exports = homebridge => {
  hap = homebridge.hap;
  homebridge.registerAccessory('homebridge-nature-remo-cloud-aircon', 'NatureRemoAircon', NatureRemoAircon);
};

class NatureRemoAircon {

  constructor(log, config) {
    log('NatureRemoAircon init');

    // `log` is the logger for this service.
    this.log = log;

    // `access_token` is the token for the API.
    // Users must specify it in the configuration (mandatory).
    this.access_token = config.access_token;

    // `appliance_id` is the appliance ID of the aircon to be handled by this
    // service.
    // Users can specify the ID in the configuration.
    // When it is left blank, this value will be filled during the first
    // refresh. In that case, the first aircon is automatically selected.
    this.appliance_id = config.appliance_id || null;

    // `schedule` controls the update frequency of the latest aircon status
    // (including temperature) from Nature Remo Cloud API. This operation is
    // referred as "refresh".
    // Users can specify the frequency in crontab format in the configuration.
    // When left blank, the schedule will be "every minute".
    this.schedule = config.schedule || '* * * * *';

    // `skip_command_request_if_no_change` controls whether the update request
    // should be sent to the cloud if no changes has been made. This option
    // has been introduced for iOS 13 support; the Home app on iOS 13 always
    // sends command requests to Homebridge every time opening a thermostat
    // control panel even without actual user operations. (see #22 for details)
    this.skip_command_request_if_no_change = config.skip_command_request_if_no_change || true;

    // `service` is the instance of this HomeBridge service.
    this.service = null;

    // `record` is the object representing `Appliance` model.
    // c.f. http://swagger.nature.global/#model-Appliance
    // This value will be filled/updated by refresh.
    this.record = null;

    // `temperature` is the temperature sensor value retrieved from the Remo.
    // This value will be updated by refresh.
    this.temperature = 0.0;

    // `hasNotifiedConfiguration` indicates that the characteristics of the
    // aircon service (fetched from the API asynchronously) has been
    // advertised.
    this.hasNotifiedConfiguration = false;

    // Periodically refresh the target appliance information.
    if (! updater) {
      updater = new cron.CronJob({
        cronTime: this.schedule,
        onTick: () => {
          this._refreshTargetAppliance();
        },
        runOnInit: true
      });
      updater.start();
    }

    eventHandler.on('appliancesRefreshed', (json) => {
      let appliance;
      if (this.appliance_id) {
        // Use the persisted appliance ID (i.e., ID discovered during the first
        // refresh or ID specified in configuration by user).
        appliance = json.find((app, i) => {
          return app.id === this.appliance_id;
        });
      } else {
        // ID not specified in configuration; automatically use the first
        // aircon appliance.
        // TODO: fix error if no aircon is registered.
        appliance = json.filter(app => {
          if (app.aircon !== null) {
            this.log.debug(`Discovered aircon: ${app.id}: ${JSON.stringify(app)}`);
            return true;
          }
        })[0];
      }
      if (appliance) {
        this.log.debug(`Target aircon ID: ${appliance.id}`);
        this.record = appliance;
        this.appliance_id = appliance.id;  // persist discovered ID
        this._notifyConfigurationIfNeeded();
        this._notifyLatestValues();
      } else {
        this.log('Target aircon could not be found. You can leave `appliance_id` blank to automatically use the first aircon.');
      }
    });

    eventHandler.on('devicesRefreshed', (json) => {
      const device = json.find(dev => {
        return dev.id === this.record.device.id;
      });
      this.temperature = device.newest_events.te.val;
      this.log.debug(`room temperature: ${this.temperature}`);
      this._notifyLatestValues();
    });
  }

  _updateTargetAppliance(params, callback) {
    if (this.skip_command_request_if_no_change && !this._shouldUpdateApplianceState(params)) {
      this.log.debug(`skipping request for update since it won't change the appliance state: ${JSON.stringify(params)}`);
      callback();
      return;
    }

    this.log.debug(`making request for update: ${JSON.stringify(params)}`);
    this.requestParams = Object.assign({}, this.requestParams, params);

    if (!this.requestPromise) {
      this.requestPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
          // Use the current button state unless it is requested to be changed.
          this.requestParams = Object.assign({'button': this.record.settings.button}, this.requestParams);

          this.log.debug(`requesting update to server: ${JSON.stringify(this.requestParams)}`);

          const options = Object.assign({}, DEFAULT_REQUEST_OPTIONS, {
            uri: `/appliances/${this.record.id}/aircon_settings`,
            headers: {'authorization': `Bearer ${this.access_token}`},
            method: 'POST',
            form: this.requestParams
          });
          request(options, (error, response, body) => {
            this.log.debug('got reponse for update');
            if (error || body === null) {
              this.log(`failed to update: ${error}, ${body}`);
              reject('failed to update');
              return;
            }
            let json;
            try {
              json = JSON.parse(body);
            } catch (e) {
              json = null;
            }
            if (json === null || 'code' in json) {
              // 'code' is returned when e.g., unsupported temperature or mode
              this.log(`server returned error: ${body}`);
              reject('server returned error');
              return;
            }
            resolve(json)
          });
          delete this.requestPromise
          delete this.requestParams
        }, 100)
      });
    }

    this.requestPromise.then((json) => {
      this.record.settings = json;
      this._notifyLatestValues();
      callback();
    }).catch((reason) => {
      callback(reason)
    })
  }

  _shouldUpdateApplianceState(requestParams) {
    // Returns true if the state has been changed so that it should be
    // notified to the cloud.
    const currentState = this.record && this.record.settings;

    if (!currentState) {
      return true;
    }

    for (let requestKey of Object.keys(requestParams)) {
      const requestValue = requestParams[requestKey];
      const currentValue = currentState[RESPONSE_KEYS_BY_REQUEST_KEY[requestKey]];
      if (requestValue !== currentValue) {
        return true;
      }
    }

    return false;
  }

  _refreshTargetAppliance() {
    this.log.debug('refreshing target appliance record');
    const options = Object.assign({}, DEFAULT_REQUEST_OPTIONS, {
      uri: '/appliances',
      headers: {'authorization': `Bearer ${this.access_token}`}
    });

    request(options, (error, response, body) => {
      if (error || body === null) {
        this.log(`failed to refresh target appliance record: ${error}`);
        return;
      }
      let json;
      try {
        json = JSON.parse(body);
      } catch (e) {
        json = null;
      }
      if (json === null || 'code' in json) {
        this.log(`failed to parse response: ${body}`);
        return;
      }
      eventHandler.emit('appliancesRefreshed', json);

      this._refreshTemperature();
    });
  }

  _refreshTemperature() {
    this.log.debug('refreshing temperature record');
    const options = Object.assign({}, DEFAULT_REQUEST_OPTIONS, {
      uri: '/devices',
      headers: {'authorization': `Bearer ${this.access_token}`}
    });

    request(options, (error, response, body) => {
      if (error || body === null) {
        this.log(`failed to refresh temperature record: ${error}`);
        return;
      }
      let json;
      try {
        json = JSON.parse(body);
      } catch (e) {
        json = null;
      }
      if (json === null || 'code' in json) {
        this.log(`failed to parse response of devices: ${body}`);
        return;
      }
      eventHandler.emit('devicesRefreshed', json);
    });
  }

  _notifyConfigurationIfNeeded() {
    if (this.hasNotifiedConfiguration) {
      return;
    }

    const props = {
      maxValue: this.getMaxTargetTemperature(),
      minValue: this.getMinTargetTemperature(),
      minStep: this.getTargetTemperatureStep(),
    };

    this.log.debug(`notifying TargetTemperature props: ${JSON.stringify(props)}`);

    // We cannot set these props in getServices() for the reasons:
    // * getServices() is invoked at the initialization of this accessary.
    // * The props are fetched via Nature API asynchronously.
    this.service.getCharacteristic(hap.Characteristic.TargetTemperature).setProps(props)

    // This is needed to notify homebridge of the change.
    this.service.emit('service-configurationChange', { service: this.service });

    this.hasNotifiedConfiguration = true;
  }

  _notifyLatestValues() {
    const aircon = this.service;
    if (aircon === null) {
      // Service is not yet created.
      return;
    }

    const settings = this.record.settings;
    this.log.debug(`notifying values: ${JSON.stringify(settings)}`);
    aircon
      .getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .updateValue(this._translateHeatingCoolingState(settings));
    aircon
      .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .updateValue(this._translateHeatingCoolingState(settings));
    aircon
      .getCharacteristic(hap.Characteristic.CurrentTemperature)
      .updateValue(this.temperature);
    aircon
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .updateValue(settings.temp);
  }

  _translateHeatingCoolingState(settings) {
    if (settings.button === 'power-off') {
      return 0;
    } else if (settings.mode === 'warm') {
      return 1;
    } else if (settings.mode === 'cool') {
      return 2;
    } else if (settings.mode === 'auto') {
      return 3;
    }
    return null;
  }

  getHeatingCoolingState(callback) {
    const settings = this.record.settings;
    const value = this._translateHeatingCoolingState(settings);
    if (value === null) {
      callback(`unsupported settings: ${settings}`);
      return;
    }
    callback(null, value);
  }

  setHeatingCoolingState(value, callback) {
    const params = {};
    if (value == 0) {
      // off
      params.button = 'power-off';
    } else if (value == 1) {
      // heat
      params.button = '';
      params.operation_mode = 'warm';
    } else if (value == 2) {
      // cool
      params.button = '';
      params.operation_mode = 'cool';
    } else if (value == 3) {
      // auto
      if ('auto' in this.record.aircon.range.modes) {
        params.button = '';
        params.operation_mode = 'auto';
      } else {
        // Auto mode is not supported by this aircon.
        // Use the current mode instead.
        const mode = this.record.settings.mode;
        this.log(`auto mode is not supported; using last mode: ${mode}`)
        params.button = '';
        params.operation_mode = mode;
      }
    } else {
      this.log(`unexpected heating cooling state value: ${value}`)
      callback('assertion error');
      return
    }
    this._updateTargetAppliance(params, callback);
  }

  getCurrentTemperature(callback) {
    callback(null, this.temperature);
  }

  getTargetTemperature(callback) {
    if (!this.record.settings || !this.record.settings.temp) {
      callback('assertion error');
    } else {
      callback(null, this.record.settings.temp);
    }
  }

  setTargetTemperature(value, callback) {
    const params = {
        'temperature': value.toString()
    };
    this._updateTargetAppliance(params, callback);
  }

  _translateTemperatureDisplayUnits(record) {
    if (record.aircon.tempUnit === 'c') {
      return 0;
    } else if (record.aircon.tempUnit === 'f') {
      return 1;
    }
    return null;
  }

  getTemperatureDisplayUnits(callback) {
    const currentUnit = this._translateTemperatureDisplayUnits(this.record);
    if (currentUnit === null) {
      callback('assertion error');
    } else {
      callback(null, currentUnit);
    }
  }

  setTemperatureDisplayUnits(value, callback) {
    const currentUnit = this._translateTemperatureDisplayUnits(this.record);
    if (currentUnit === null) {
      callback('assertion error');
    } else if (value === currentUnit) {
      // No changes.
      callback();
    } else {
      this.log(`temperature display unit cannot be changed from ${currentUnit} to ${value}`)
      callback('unsupportred operation');
    }
  }

  getServices() {
    const aircon = new hap.Service.Thermostat('エアコン');
    aircon
      .getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .on('get', this.getHeatingCoolingState.bind(this));
    aircon
      .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .on('get', this.getHeatingCoolingState.bind(this))
      .on('set', this.setHeatingCoolingState.bind(this));
    aircon
      .getCharacteristic(hap.Characteristic.CurrentTemperature)
      .on('get', this.getCurrentTemperature.bind(this));
    aircon
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .on('get', this.getTargetTemperature.bind(this))
      .on('set', this.setTargetTemperature.bind(this));
    aircon
      .getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .on('get', this.getTemperatureDisplayUnits.bind(this))
      .on('set', this.setTemperatureDisplayUnits.bind(this));

    this.service = aircon;
    return [aircon];
  }

  getTargetTemperatureStep() {
    const v = Math.min(...this._getAllTemperatures().sort().map(
        (_, i, temp) => i === 0 ? 0 : temp[i] - temp[i-1]).filter(
        x => x > 0));
    return isNaN(v) ? 1.0 : v;
  }

  getMinTargetTemperature() {
    const v = Math.min(...this._getAllTemperatures());
    return isNaN(v) ? 10.0 : v;
  }

  getMaxTargetTemperature() {
    const v = Math.max(...this._getAllTemperatures());
    return isNaN(v) ? 122.0 : v;
  }

  _getAllTemperatures() {
    // Returns the list of all possible temperatures for cool/warm mode.
    // Note that the returned list may contain duplicates.
    let allTemperatures = [];
    const modes = this.record.aircon.range.modes;

    for (const mode in modes) {
      if (! (mode === 'cool' || mode === 'warm')) {
        continue;
      }
      const temperatures = modes[mode].temp.filter(t => t.match(/^\d+(\.\d+)?$/)).map(t => parseInt(t));
      allTemperatures = allTemperatures.concat(temperatures);
    }

    return allTemperatures;
  }

}  // class NatureRemoAircon
