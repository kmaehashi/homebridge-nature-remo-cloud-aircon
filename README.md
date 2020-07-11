[![npm](https://img.shields.io/npm/v/homebridge-nature-remo-cloud-aircon?style=for-the-badge)](https://www.npmjs.com/package/homebridge-nature-remo-cloud-aircon)

# homebridge-nature-remo-cloud-aircon

Homebridge Plug-in for Air Conditioner Managed by Nature Remo.

```
npm install -g homebridge-nature-remo-cloud-aircon
```

Example:

```js
...

"accessories": [
  {
    "accessory": "NatureRemoAircon",
    "name": "Air Conditioner",
    "access_token": "xxxxxxxxx_xxxxxxxxxxxxxxx_x_xxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "appliance_id": "",
    "skip_command_request_if_no_change": true
  }
]

...
```

* Please get your access token at https://home.nature.global/ and set it to `access_token`.
* `appliance_id` can be left blank if you only have one aircon.
* `skip_command_request_if_no_change` can be omitted (Default: true). With this option enabled, command request (e.g. mode or temperature change) will not be sent to Nature Remo API if the request will change nothing by comparing it with the current AC state managed by Nature Remo. You may want to turn this false if you control your AC using _both_ Nature Remo and factory hardware remotes in your Home since the latest AC state in the Nature Remo might be incorrect.
