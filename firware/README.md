# SFTS remote hardware integration context

This folder contains the first ESP32 remote firmware prototype for the SFTS
Taekwondo Scoring System. The remote is a Wi-Fi WebSocket client. It does not
calculate scores and it does not decide a winner; it reports referee button
presses to the SFTS backend, which performs authentication, voting, scoring,
match-state validation, persistence, and scoreboard updates.

The folder name is retained as `firware/` for compatibility with the existing
project. The sketch file is `firware/firware.ino`.

## Compatibility verdict for the planned ESP32-C6-MINI-1

The application protocol is compatible in principle, but the checked-in sketch
is **not hardware-compatible with an ESP32-C6-MINI-1 as-is**. The sketch was
written for an Adafruit ESP32 Feather V2 and its GPIO map must be replaced
before the C6 schematic or PCB is signed off.

| Firmware signal | Current sketch GPIO | C6-MINI-1 result |
|---|---:|---|
| RED +1 | 26 | Not a usable C6-MINI-1 module GPIO; in the C6 family this range is associated with SPI0/1/flash. |
| RED +2 | 25 | Same issue. |
| RED +3 | 27 | Same issue. |
| RED TECHNICAL | 33 | ESP32-C6 has GPIO0–GPIO30; GPIO33 does not exist. |
| BLUE +1 | 32 | Does not exist on ESP32-C6. |
| BLUE +2 | 14 | Exposed on the C6-MINI-1 and generally usable. |
| BLUE +3 | 21 | Exposed and generally usable. |
| BLUE TECHNICAL | 22 | Exposed and generally usable. |

The C6-MINI-1 is a module, not a Feather-style development board. It has no
universal `LED_BUILTIN` pin or Feather labels. The sketch’s
`pinMode(LED_BUILTIN, ...)` therefore needs a board/schematic-specific LED
definition, or the LED indication must be removed/replaced with a named GPIO.
The firmware identification string should also be changed from
`sfts-demo-esp32-feather-v2` to a C6 hardware revision string.

The C6-MINI-1 module exposes the GPIOs needed for an eight-button remote,
but the final assignment belongs to the hardware schematic. A provisional
button-only candidate is `GPIO0, GPIO1, GPIO2, GPIO3, GPIO6, GPIO7, GPIO14,
GPIO18`. This is only a starting point for schematic review; do not copy it
blindly if those pins are allocated to another peripheral.

For the C6 design, review these constraints before assigning pins:

- Avoid `GPIO8` and `GPIO9` for buttons unless their reset-time levels are
  explicitly controlled. They select C6 boot mode; GPIO9 should normally be
  high or floating for SPI boot.
- Treat `GPIO4`/MTMS, `GPIO5`/MTDI, and `GPIO15` as boot/JTAG-related pins.
  Avoid them for buttons where possible, especially if a button can hold them
  low during reset.
- `GPIO12` and `GPIO13` are the default USB Serial/JTAG D-/D+ pins. Do not use
  them for buttons if USB programming or USB logs are required.
- `GPIO16`/TXD0 and `GPIO17`/RXD0 are the default UART0 pins. Reserve them if
  the hardware needs a UART programming/debug header.
- The module runs from a 3.0–3.6 V supply. All button pull-ups and external
  signals must be 3.3 V logic; never connect a 5 V pull-up to a GPIO.
- Keep the external pull-up arrangement used by the sketch: one momentary
  switch from each button GPIO to GND and one external pull-up from that GPIO
  to 3.3 V. The firmware uses `INPUT`, not `INPUT_PULLUP`.
- The current sketch reports `battery: 100` as a dummy value. It does not
  measure a battery. If the hardware includes a battery, provide a protected
  resistor-divider/ADC design and update the firmware’s percentage conversion
  and calibration; never feed the ADC above 3.3 V.
- A bare module needs the normal Espressif power, EN/reset, flash/module,
  antenna keep-out, and programming provisions. In particular, provide a
  stable 3.3 V rail with adequate transient current, an EN pull-up/RC reset
  network, and access to USB Serial/JTAG or UART download as selected by the
  schematic.

Authoritative C6 references: [ESP32-C6-MINI-1 datasheet](https://documentation.espressif.com/esp32-c6-mini-1_mini-1u_datasheet_en.html),
[ESP32-C6 GPIO reference](https://docs.espressif.com/projects/esp-idf/en/latest/esp32c6/api-reference/peripherals/gpio.html),
and [Espressif ESP32-C6 hardware design guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c6/schematic-checklist.html).

## SFTS system and network role

```text
ESP32-C6 remote --2.4 GHz Wi-Fi--> event remote router --LAN--> SFTS server
                                                               |
                                                        host scoreboard browser
```

The SFTS server is the Node.js application in `src/server.js`. It listens on
all interfaces at port `8080` by default. The server accepts the remote
WebSocket on the root path:

```text
ws://<SFTS-server-LAN-IP>:8080/
```

The ESP32 must use the server’s LAN IP, never `localhost` or `127.0.0.1`.
The server and remotes are intended for a closed event LAN; this protocol is
plain WebSocket (`ws://`), not TLS (`wss://`). The Raspberry Pi deployment
normally uses the Pi Ethernet address on the dedicated remote network, often
`192.168.50.102`.

The browser scoreboard is also connected to the same backend. When a remote
event is accepted, the backend updates the authoritative match state, applies
the majority-vote rules, broadcasts the new state to the scoreboard, records
corner-referee history, and emits the score sound/visual feedback. The remote
does not need to know player names, tournament fixtures, round winner logic, or
the display layout.

Relevant backend files:

- `src/server.js` — WebSocket protocol, authentication, remote sessions,
  liveness, majority voting, technical combinations, scoring, and state
  broadcasts.
- `public/js/app.js` — scoreboard rendering for remote status, button flashes,
  vote strip, test mode, and score highlights.
- `config/remote-config.json` — C1–C4 remote tokens and default port. Treat
  this file and tokens flashed into hardware as private event credentials.
- `config/rules.default.json` — active scoring and voting constraints. A
  validated `data/active-rules.json` may override the default at runtime.
- `tools/remote-simulator.js` — protocol simulator for testing without a
  physical remote.
- `docs/remote-reliability-fix-context.md` — reliability history and failure
  modes relevant to hardware testing.

## Remote identities and operating modes

There are four fixed logical remotes:

| Device ID | Physical corner | Enabled when mode is |
|---|---:|---|
| `C1` | Corner 1 | 1, 2, 3, or 4 |
| `C2` | Corner 2 | 2, 3, or 4 |
| `C3` | Corner 3 | 3 or 4 |
| `C4` | Corner 4 | 4 |

The host chooses **1 REMOTE**, **2 REMOTES**, **3 REMOTES**, or **4 REMOTES**
under SETTINGS → REMOTE SETTINGS. A connected remote whose corner is above
the selected count remains authenticated but its events are acknowledged as
`REMOTE_DISABLED` and cannot score.

The required strict-majority vote count is:

| Active remotes | Required matching votes |
|---:|---:|
| 1 | 1 |
| 2 | 2 |
| 3 | 2 |
| 4 | 3 |

Votes are keyed by corner, so one remote cannot count twice toward a majority.
When a majority is reached, the backend awards the point, clears the pending
votes, updates the scoreboard, and acknowledges the event that completed the
majority.

## Authentication and message lifecycle

Every remote opens one WebSocket and must authenticate on that connection
before sending status or scoring events.

### 1. Remote hello

Send immediately after WebSocket connection:

```json
{
  "type": "remote_hello",
  "protocolVersion": 1,
  "deviceId": "C1",
  "sessionId": "sfts-0123456789abcdef",
  "firmware": "sfts-esp32-c6-r1",
  "token": "token-configured-for-C1"
}
```

Required backend rules:

- `protocolVersion` must be `1`.
- `deviceId` must be exactly one of `C1`, `C2`, `C3`, `C4`.
- `sessionId` must be 1–64 characters matching
  `[A-Za-z0-9._:-]+`.
- The token must match the configured token for that device, unless the
  development-only `SFTS_ALLOW_UNPAIRED_REMOTES=true` override is enabled.
- Only one live WebSocket may use a device ID at a time.

The server replies with `remote_ready` and then `remote_state`:

```json
{
  "type": "remote_ready",
  "protocolVersion": 1,
  "deviceId": "C1",
  "corner": 1,
  "sessionId": "sfts-0123456789abcdef"
}
```

The firmware must treat `remote_ready` as the application-ready state. A TCP
or WebSocket connection alone is not enough to send events.

### 2. Remote event

Send one JSON text message per debounced button press:

```json
{
  "type": "remote_event",
  "deviceId": "C1",
  "sessionId": "sfts-0123456789abcdef",
  "sequence": 42,
  "button": "RED_2"
}
```

`sequence` is a positive integer and must never be reused within the same
session. The backend remembers the session’s sequence/replies in memory for up
to 24 hours. A new firmware boot must generate a new session ID; a Wi-Fi
reconnect during the same boot should retain the existing session ID and
sequence counter. The current sketch generates a random session ID from
`esp_random()` during `setup()` and uses a 32-bit sequence counter.

The backend replies to every valid event with `remote_event_ack`. Examples:

```json
{
  "type": "remote_event_ack",
  "deviceId": "C1",
  "sessionId": "sfts-0123456789abcdef",
  "sequence": 42,
  "accepted": true,
  "reason": "POINT_AWARDED",
  "awarded": true,
  "points": 2,
  "basePoints": 2,
  "technical": false,
  "voteCount": 3
}
```

Important acknowledgement reasons include:

| Reason | Meaning for firmware |
|---|---|
| `POINT_AWARDED` | Event completed a majority and was scored. |
| `VOTE_RECORDED` | Event was accepted as a vote; wait for other corners. |
| `TECHNICAL_PENDING` | Technical modifier is waiting for the matching base point. |
| `TEST_PRESS_RECORDED` | Test mode registered the button; no score changed. |
| `VOTE_CANCELLED` | The corner’s pending vote/technical combination was cleared. |
| `MATCH_NOT_RUNNING` | Match is paused or has not started; no score changed. |
| `ROUND_NOT_ACTIVE` | The scoreboard is between rounds or at match end. |
| `REMOTE_DISABLED` | This corner is above the selected remote count. |
| `INVALID_BUTTON` | Button name is not part of the installed protocol. |
| `SEQUENCE_REPLAY` | A new sequence was not greater than the session’s last sequence. |

The current firmware uses a FIFO outbox of 16 events and retries the oldest
unacknowledged event every 1 second. This is the intended reliability model:
do not delete an event from the outbox merely because `sendTXT()` returned
success; remove it only after a matching `remote_event_ack` is received.
Retransmission of the same sequence is safe because the backend caches and
replays the acknowledgement without scoring the event twice.

### 3. Status and liveness

After `remote_ready`, the remote should periodically send:

```json
{
  "type": "remote_status",
  "deviceId": "C1",
  "sessionId": "sfts-0123456789abcdef",
  "rssi": -61,
  "battery": 100
}
```

`rssi` must be an integer from `-127` to `0`. `battery` is a percentage from
`0` to `100`, or `null` if no measurement exists. The backend returns
`remote_status_ack` and updates the dashboard’s RSSI/battery fields.

The server’s application liveness threshold is three 10-second heartbeat
intervals: approximately 30 seconds without a valid hello, status, event, or
ping causes the dashboard status to become disconnected. The WebSocket
transport also has server-side ping/pong checks. Hardware acceptance testing
must therefore verify both event delivery and status/heartbeat delivery.

The firmware may also use:

```json
{"type":"remote_ping","deviceId":"C1","rssi":-61,"battery":100}
```

after authentication; the backend returns `remote_pong`. The checked-in sketch
currently uses `remote_status` every 10 seconds and the WebSockets library
heartbeat, which is sufficient for the current backend liveness path.

## Button protocol and scoring behavior

The installed default rules use three base buttons per side and one technical
modifier per side:

| Physical control | Message button | Normal award |
|---|---|---:|
| RED +1 / punch | `RED_1` | +1 RED |
| RED +2 / chest | `RED_2` | +2 RED |
| RED +3 / head | `RED_3` | +3 RED |
| RED technical | `RED_TECHNICAL` | Modifier only |
| BLUE +1 / punch | `BLUE_1` | +1 BLUE |
| BLUE +2 / chest | `BLUE_2` | +2 BLUE |
| BLUE +3 / head | `BLUE_3` | +3 BLUE |
| BLUE technical | `BLUE_TECHNICAL` | Modifier only |
| Cancel | `CANCEL` | Clear this corner’s pending vote |

Technical input is a same-corner modifier inside a 1,000 ms window:

- `RED_TECHNICAL` + `RED_2` in either order awards +4 RED.
- `RED_TECHNICAL` + `RED_3` in either order awards +6 RED.
- The same combinations work for BLUE.
- Technical +1 is not eligible.
- A technical button by itself does not award points.
- A side mismatch, an expired combination, or `CANCEL` clears the pending
  combination as applicable.

The backend only allows normal remote scoring when the match is in a started,
running `ROUND`, outside test mode and outside Kye-shi. Timer expiry, pause,
round breaks, match end, and Kye-shi suspend remote scoring and produce an
acknowledgement explaining why no point was awarded.

## What the current prototype already does

`firware/firware.ino` currently implements the important protocol behaviors:

- eight active-low button inputs with external pull-ups;
- GPIO change interrupts that only set pending flags;
- loop-based stateful debounce, currently 45 ms;
- one event per press and re-arm only after a stable release;
- random session ID per boot;
- monotonically increasing 32-bit event sequence;
- FIFO outbox with 16-event capacity;
- retry every 1 second until a matching acknowledgement;
- `remote_ready` gating before events/status are sent;
- RSSI and dummy battery telemetry every 10 seconds;
- reconnect on WebSocket loss and on backend application errors.

These behaviors should be retained when porting the sketch to the C6. The
button pin table, LED implementation, board name, and any battery measurement
code must be changed for the custom hardware.

The prototype’s response parser is intentionally small and should be hardened
for the production C6 firmware: validate JSON `type`, device ID, session ID,
and sequence before acknowledging/removing an outbox item. In particular, do
not treat any message that merely contains the text `remote_ready` as a valid
ready response. Keep application-ready state separate from transport-connected
state, and force a clean reconnect after an authenticated application error.

## Hardware-to-firmware sign-off checklist

Before reviewing the final hardware project, confirm:

1. The schematic’s eight button nets exactly match the final C6 GPIO constants
   in `firware.ino`.
2. None of the button nets can force an unsafe C6 strapping level during reset.
3. Every button is wired GPIO → switch → GND, with a 3.3 V external pull-up.
4. The selected C6 Arduino board/core is supported and the sketch compiles
   with the WebSockets library by Markus Sattler / Links2004.
5. `LED_BUILTIN` is replaced by the actual status LED GPIO or a safe no-LED
   implementation.
6. The USB/JTAG or UART programming path remains available after all GPIO
   assignments are made.
7. The 3.3 V regulator, decoupling, EN/reset circuit, antenna keep-out, and
   module ground/thermal connection follow the Espressif module guidance.
8. Battery ADC hardware, if present, is protected and the firmware reports a
   real calibrated percentage instead of `100`.
9. Each physical unit has a unique `REMOTE_DEVICE_ID` and matching token.
10. Each boot creates a new valid `sessionId`; Wi-Fi reconnects do not reset it.

## Bring-up and backend test sequence

Run the backend from the project root:

```bash
npm install
npm test
npm start
```

For a physical C6 remote, set the server LAN IP, Wi-Fi credentials, device ID,
and matching token in the sketch. Then:

1. Start the server and confirm it prints the LAN address and configured C1–C4
   remote IDs.
2. Open the scoreboard and select the matching remote mode in REMOTE SETTINGS.
3. Confirm the remote serial log reaches WebSocket connected → remote hello →
   remote accepted/ready.
4. Use REMOTE SETTINGS test mode to press all eight controls. Confirm each
   control appears for the correct corner and does not change the score.
5. Start a round and connect one, two, three, and four remotes in separate
   tests. Confirm the required vote counts 1/2/2/3.
6. Test normal +1/+2/+3, both technical press orders, technical +1 rejection,
   `CANCEL`, pause, round end, and remote-disabled behavior.
7. Drop Wi-Fi or power-cycle the remote after sequence numbers have advanced.
   A reboot must use a new session ID and score immediately after re-handshake.
8. Reconnect Wi-Fi without rebooting. The same session may resume, queued
   events must be retried, and duplicate delivery must not double-score.
9. Leave the remote silent for at least 30 seconds and verify the dashboard
   eventually shows it disconnected.

For protocol-only tests, use the simulator:

```bash
npm run simulate:remote -- C1 RED_2 1 ws://127.0.0.1:8080
```

## Configuration examples

The C1 values in the prototype sketch must correspond to the server’s
`config/remote-config.json` entry:

```cpp
const char* REMOTE_DEVICE_ID = "C1";
const char* REMOTE_TOKEN = "the-token-configured-for-C1";
const uint16_t SERVER_PORT = 8080;
const char* SERVER_PATH = "/";
```

For an event, flash each physical remote with its own ID/token pair. Do not
use `SFTS_ALLOW_UNPAIRED_REMOTES=true` outside local development.
