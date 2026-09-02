# SFTS ESP32 Feather V2 demo

This folder contains a first hardware-test sketch for the Adafruit ESP32 Feather V2.

## Before uploading

1. Install the ESP32 board package in Arduino IDE.
2. Install the `WebSockets` library by Markus Sattler / Links2004.
3. Open `sfts_remote_demo.ino`.
4. Set `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_HOST`, and `SERVER_PORT`.
5. Leave `REMOTE_DEVICE_ID` as `C1` and select MODE `1` in the dashboard for a one-remote test.
6. Either set the matching `SFTS_REMOTE_TOKEN_C1` on the server and put it in `REMOTE_TOKEN`, or enable `SFTS_ALLOW_UNPAIRED_REMOTES=true` for local testing.
7. Select the Adafruit ESP32 Feather V2 board and upload.

`SERVER_HOST` must be the Windows PC or Raspberry Pi's LAN address. Do not use `localhost` on the ESP32.

## Button wiring

Each momentary button connects between its GPIO and GND. Keep the fitted external 10K pull-up from each GPIO to 3.3V. The sketch uses `INPUT` (not `INPUT_PULLUP`) and a change interrupt with state-based software debounce. It emits one event per press and re-arms only after a stable release.

| Button | GPIO | Feather label |
|---|---:|---|
| RED +1 | 26 | A0 |
| RED +2 | 25 | A1 |
| RED +3 | 27 | D27 |
| RED TECHNICAL | 33 | D33 |
| BLUE +1 | 32 | D32 |
| BLUE +2 | 14 | D14 |
| BLUE +3 | 21 | MI / MISO |
| BLUE TECHNICAL | 22 | SDA |

The selected pins are interrupt-capable on the ESP32 Arduino core. GPIO0/2, GPIO12, GPIO13, GPIO15, input-only pins without internal pull-ups, GPIO4, and GPIO5 were intentionally not used.

The sketch reports the Wi-Fi RSSI and `battery: 100` every 10 seconds. The battery value is a dummy percentage required by the SFTS protocol; no physical battery-voltage measurement is used yet. WebSocket connect/disconnect is reported in the serial monitor and is reflected in the dashboard by the server connection state.

Technical combinations are sent as two events from the same remote, for example `RED_TECHNICAL` followed by `RED_2`. The server converts that to +4 within its one-second combination window.
