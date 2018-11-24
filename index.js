const request = require('request');
const cron = require('cron');

const DEFAULT_REQUEST_OPTIONS = {
  baseUrl: 'https://api.nature.global/1/',
  method: 'GET'
};

let hap;

module.exports = homebridge => {
  hap = homebridge.hap;
  homebridge.registerAccessory('homebridge-nature-remo-aircon', 'NatureRemoAircon', NatureRemoAircon);
};

class NatureRemoAircon {

  constructor(log, config) {
    log('NatureRemoAircon init');

    this.log = log;
    this.appliance_id = config.appliance_id || null;
    this.access_token = config.access_token;
    this.schedule = config.schedule || '* * * * *';

    this.service = null;
    this.record = null;
    this.temperature = 0.0;
    this.hasNotifiedConfiguration = false;
    this.updater = new cron.CronJob({
      cronTime: this.schedule,
      onTick: () => {
        this._refreshTargetAppliance();
      },
      runOnInit: true
    });
    this.updater.start();
  }

  _updateTargetAppliance(params, callback) {
    this.log('making request for update');
    const options = Object.assign({}, DEFAULT_REQUEST_OPTIONS, {
        uri: `/appliances/${this.record.id}/aircon_settings`,
        headers: {'authorization': `Bearer ${this.access_token}`},
        method: 'POST',
        form: params
      }
    );
    request(options, (error, response, body) => {
      this.log('got reponse for update');
      if (error || body === null) {
        this.log(`failed to update: ${error}, ${body}`);
        callback('failed to update');
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
        callback('server returned error');
        return
      }
      this.record.settings = json;
      this._notifyLatestValues();
      callback();
    });
  }

  _refreshTargetAppliance() {
    this.log('refreshing target appliance record');
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
      let appliance;
      if (this.appliance_id) {
        appliance = json.find((app, i) => {
          return app.id === this.appliance_id;
        });
      } else {
        appliance = json.filter(app => {
          if (app.aircon !== null) {
            this.log(`Discovered aircon: ${app.id}: ${JSON.stringify(app)}`);
            return true;
          }
        })[0];
      }
      if (appliance) {
        this.log(`Target aircon ID: ${appliance.id}`);
        this.record = appliance;
        this.appliance_id = appliance.id;  // persist discovered ID
        this._refreshTemperature();
        this._notifyConfigurationIfNeeded();
        this._notifyLatestValues();
      } else {
        this.log('Target aircon could not be found. You can leave `appliance_id` blank to automatically use the first aircon.');
      }
    });
  }

  _refreshTemperature() {
    if (this.record === null) {
      this.log('The aircon record is not available yet');
      return;
    }

    this.log('refreshing temperature record');
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
      const device = json.find(dev => {
        return dev.id === this.record.device.id;
      });
      this.temperature = device.newest_events.te.val;
      this.log(`Temperature: ${this.temperature}`);
      this._notifyLatestValues();
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

    this.log(`notifying TargetTemperature props: ${JSON.stringify(props)}`);

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
    this.log(`notifying values: ${JSON.stringify(settings)}`);
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
      params.button = '';
      params.operation_mode = 'auto';
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
    callback(null, this.record.settings.temp);
  }

  setTargetTemperature(value, callback) {
    const params = {'temperature': value.toString()}
    this._updateTargetAppliance(params, callback);
  }

  getTemperatureDisplayUnits(callback) {
    if (this.record.aircon.tempUnit === 'c') {
      callback(null, 0);
    } else if (this.record.aircon.tempUnit === 'f') {
      callback(null, 1);
    } else {
      callback('assertion error');
    }
  }

  setTemperatureDisplayUnits(value, callback) {
    if (value === 0) {  // C
      callback();
    } else if (value === 1) {  // F
      this.log('temperature display unit cannot be set')
      callback('unsupportred operation');
    } else {
      this.log(`unexpected temperature display unit value: ${value}`)
      callback('assertion error');
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
      if (! (mode === 'cool' || mode === 'warm' || mode === 'auto')) {
        continue;
      }
      const temperatures = modes[mode].temp.filter(t => t.match(/^\d+(\.\d+)?$/)).map(t => parseInt(t));
      allTemperatures = allTemperatures.concat(temperatures);
    }

    return allTemperatures;
  }

}  // class NatureRemoAircon
