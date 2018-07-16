# homebridge-nature-remo-aircon

Homebridge Plug-in for Air Conditioner Managed by Nature Remo

Example:

```js
...

"accessories": [
  {
    "accessory": "NatureRemoAircon",
    "name": "Air Conditioner",
    "access_token": "xxxxxxxxx_xxxxxxxxxxxxxxx_x_xxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "appliance_id": ""
  }
]

...
```

* Please get your access token at https://home.nature.global/ and set it to `access_token`.
* `appliance_id` can be left blank if you only have one aircon.
