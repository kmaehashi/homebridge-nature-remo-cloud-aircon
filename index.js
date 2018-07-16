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
      let json = JSON.parse(body);
      if (error || json === null) {
        this.log(`failed to update: ${error}, ${body}`);
        callback('failed to update');
        return
      } else if ('code' in json) {
        // e.g., unsupported temperature
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
      if (error) {
        this.log(`failed to refresh target appliance record: ${error}`);
        return;
      }
      const json = JSON.parse(body);
      if (!json) {
        this.log(`failed to parse response: ${body}`);
        return;
      }
      let appliance;
      if (this.appliance_id) {
        appliance = json.find((app, i) => {
          return app.id === this.appliance_id;
        });
      } else {
        appliance = json.find((app, i) => {
          return app.aircon !== null;
        });
      }
      if (appliance) {
        this.log(`Target aircon: ${JSON.stringify(appliance)}`);
        this.record = appliance;
        this.appliance_id = appliance.id;  // persist discovered ID
        this._notifyLatestValues();
      } else {
        this.log('Target aircon could not be found. You can leave `appliance_id` blank to automatically use the first aircon.');
      }
    });
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
      .updateValue(settings.temp);  // TODO use sensor value
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
    /* TODO use sensor value */
    this.getTargetTemperature(callback);
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

}  // class NatureRemoAircon
