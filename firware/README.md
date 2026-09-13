# SFTS ESP32-C6-MINI-1 remote — hardware and backend context

This README is the hardware-project handoff for an SFTS-compatible wireless
taekwondo referee remote. The objective is a stable, battery-powered remote
based on the **ESP32-C6-MINI-1**, with USB-C firmware programming, USB-C
charging, a physical ON/OFF switch, eight scoring buttons, and local status
indicators.

The remote is an input and telemetry device. It does not calculate scores or
decide a winner. The SFTS software backend in `src/server.js` is authoritative
for authentication, vote counting, technical-score combinations, match-state
validation, scoring, persistence, and scoreboard updates.

The repository directory is named `firware/` and contains the Arduino sketch
at [`firware.ino`](firware.ino).

## Design summary

- MCU/module: ESP32-C6-MINI-1, selected for its current Wi-Fi stack and
  integrated USB Serial/JTAG capability.
- Development environment: Arduino IDE with the ESP32-C6 board package and
  the `WebSockets` library by Markus Sattler / Links2004.
- Power: single-cell Li-Po battery, MCP73831T-2ACI/OT charger at a fixed
  500 mA charge current, TPS62821DLC buck converter, and regulated `+3V3`
  for the ESP32-C6-MINI-1.
- USB-C: one USB-C connector provides firmware programming and charging. It
  can also provide development power through the optional `VBUS_BYPASS`
  jumper.
- User input: eight momentary push buttons, four for RED/HONG and four for
  BLUE/CHUNG scoring.
- Status output: four active-low LEDs for RED input, BLUE input, Wi-Fi
  heartbeat, and low battery.
- Battery telemetry: switched 100 kΩ/100 kΩ divider, sampled only when needed
  through an N-channel MOSFET to reduce idle battery drain.

## System and network role

```text
ESP32-C6 remote --2.4 GHz Wi-Fi--> event router --LAN--> SFTS server
                                                               |
                                                        scoreboard browser
```

The SFTS server is a Node.js application that listens on all interfaces at
port `8080` by default. A remote connects to the root WebSocket path:

```text
ws://<SFTS-server-LAN-IP>:8080/
```

The ESP32 must use the server’s LAN IP, never `localhost` or `127.0.0.1`. The
system is intended for a closed event LAN and currently uses plain WebSocket
(`ws://`), not TLS (`wss://`).

When a remote event is accepted, the backend records the corner-referee input,
updates the pending vote state, applies the majority rule, updates the match
score when appropriate, broadcasts the authoritative state to the scoreboard,
and emits the score feedback. The remote does not need player names, fixture
data, timer logic, or winner logic.

Backend source of truth:

- `src/server.js` — WebSocket protocol, authentication, remote sessions,
  liveness, majority voting, technical combinations, scoring, and broadcasts.
- `public/js/app.js` — remote status cards, button feedback, vote strip, test
  mode, and scoreboard score highlights.
- `config/remote-config.json` — server port and C1–C4 remote tokens. Keep
  these tokens private and flash a different pair to each physical remote.
- `config/rules.default.json` — installed base points, technical scoring,
  voting limits, and match behavior.
- `tools/remote-simulator.js` — protocol-only testing without hardware.
- `docs/remote-reliability-fix-context.md` — reliability and failure-mode
  context for hardware testing.

## Power architecture

### USB-C input and programming

J1 is a 16-pin USB-C receptacle. USB-C sink configuration is provided by R5
and R6, both `5K1`, on the CC pins. C5, `1 µF`, filters the VBUS input.

The USB data connections are:

```text
J1 A7/B7 (USB D-) -- USBLC6-2SC6 -- ESP32-C6-MINI-1 IO12 / USB-
J1 A6/B6 (USB D+) -- USBLC6-2SC6 -- ESP32-C6-MINI-1 IO13 / USB+
```

On the ESP32-C6-MINI-1 these are module pads 17 and 18, and Arduino GPIO12
and GPIO13 respectively. They are the default USB Serial/JTAG D- and D+
signals. Preserve the ESD device, USB routing, return path, and connector
shield/ground treatment in the PCB layout.

J3 is the `VBUS_BYPASS` jumper. When J3 is shorted, USB VBUS bypasses the
charger and appears at the input of SW9, allowing development power when no
battery is connected. This bypass path is not the charging path. Confirm that
J3 cannot create an unsafe USB-to-battery backfeed or bypass a required power
protection function when a battery is installed.

### Li-Po charger

When `VBUS_BYPASS` is not shorted, USB VBUS enters the MCP73831T-2ACI/OT
single-cell Li-Po charger:

- R12, `2 kΩ`, programs the charge current to approximately `500 mA` using
  the MCP73831 programming relationship.
- C6, `4.7 µF`, is the charger input capacitor.
- C11, `4.7 µF`, is the charger output/battery-side capacitor.
- D1, `LED_R`, indicates charger status from the charger status output.
- `V_BATT` is the battery node.

The battery, cell protection, connector polarity, charge-temperature limits,
and whether the selected Li-Po cell is suitable for a 500 mA charge rate must
be verified as part of the hardware review. The MCP73831 is a charger, not a
complete system power-path manager.

### ON/OFF and 3.3 V regulator

`V_BATT` enters SW9, the physical ON/OFF switch. The switched node is `V_IN`.
When SW9 is ON, `V_IN` feeds U2, the TPS62821DLC synchronous buck converter,
which generates `+3V3` for the ESP32-C6-MINI-1.

The planned regulator network is:

- C13, `4.7 µF`, at the converter input.
- L1, `470 nH`, as the switching inductor.
- R20, `435 kΩ`, and R21, `100 kΩ`, as the feedback divider.
- C18, `47 µF`, and C19, `100 nF`, on the converter output.
- ESP32 local decoupling: C14 `10 µF` parallel with C15 `1 µF` parallel
  with C16 `100 nF`.

**Feedback value sign-off is required:** assuming R20 is the upper resistor
from `VOUT` to FB and R21 is the lower resistor from FB to AGND, the TI
feedback equation with a `0.6 V` reference gives approximately
`0.6 × (1 + 435/100) = 3.21 V`, not 3.3 V. For 3.3 V with a 100 kΩ lower
resistor, the upper resistor is approximately 450 kΩ; select the final value
from the exact datasheet equation and tolerance requirements before PCB
fabrication.

The TPS62821 input range supports both the single-cell battery operating
range and USB bypass input, but confirm startup, maximum current, thermal
margin, inductor rating, layout, and output-voltage tolerance in the final
design.

### Switched battery measurement

After SW9, the battery monitor is:

```text
V_IN -- R17 100 kΩ -- V_SNS / ESP32 IO2 -- C12 100 nF -- switched lower leg
                                                        |
                                                   R18 100 kΩ
                                                        |
                                               Q1 BSS138 N-MOSFET
                                                        |
                                                       GND
```

Q1’s gate is `V_SNS_EN` on ESP32 IO3. The firmware should:

1. Set `V_SNS_EN` active to turn Q1 on.
2. Wait for the divider and C12 to settle.
3. Read the ADC on `V_SNS`.
4. Convert the measured battery voltage to a calibrated percentage.
5. Disable `V_SNS_EN` immediately after the measurement.

The final schematic must ensure that `V_SNS` cannot exceed the ESP32 ADC
input limits while Q1 is off, during reset, or while the battery is connected.
A low-side disconnect can leave the ADC node floating or allow it to charge
through R17, so this behavior must be checked with transient analysis and
bench measurements. The firmware must not assume that an unpowered divider
node reads zero.

The backend accepts `battery` as an integer percentage from 0 to 100. Battery
percentage is not inherently equal to a Li-Po voltage percentage; define the
cell-specific voltage-to-SOC curve, load conditions, hysteresis, and the low
battery threshold before enabling the production battery indicator.

## User buttons

There are eight momentary push buttons with external `10 kΩ` pull-ups to
`+3V3` and `10 nF` debounce capacitors. Each button is active-low: pressing the
button connects its GPIO to GND. The firmware should configure these pins as
inputs and use falling-edge or change interrupts with software debounce.

The ESP32-C6 GPIO peripheral supports configurable GPIO interrupt trigger
types, including rising edge, falling edge, and both-edge triggering. The
selected input GPIOs below are digital I/O pins and are suitable for this
interrupt-based button scanner after reset configuration is complete.

| Physical side | Reference | Function | Protocol button | ESP32-C6 module pad | Arduino GPIO |
|---|---|---|---|---:|---:|
| RED / HONG | SW1 `SW_R_TECH` | Technical modifier | `RED_TECHNICAL` | 12 / IO0 | **0** |
| RED / HONG | SW2 `SW_R_HEAD` | Head point | `RED_3` | 13 / IO1 | **1** |
| RED / HONG | SW3 `SW_R_CHEST` | Chest point | `RED_2` | 19 / IO14 | **14** |
| RED / HONG | SW4 `SW_R_FIST` | Fist point | `RED_1` | 20 / IO15 | **15** |
| BLUE / CHUNG | SW5 `SW_B_TECH` | Technical modifier | `BLUE_TECHNICAL` | 15 / IO6 | **6** |
| BLUE / CHUNG | SW6 `SW_B_HEAD` | Head point | `BLUE_3` | 16 / IO7 | **7** |
| BLUE / CHUNG | SW7 `SW_B_CHEST` | Chest point | `BLUE_2` | 22 / IO8 | **8** |
| BLUE / CHUNG | SW8 `SW_B_FIST` | Fist point | `BLUE_1` | 25 / IO19 | **19** |

### Module pad number is not the Arduino GPIO number

The schematic mapping above contains module pad numbers. Arduino GPIO APIs
must receive the GPIO number in the final column, not the module pad number.
For example:

```cpp
// Correct: module pad 12 is IO0, so Arduino uses GPIO 0.
constexpr uint8_t PIN_RED_TECHNICAL = 0;
```

Do not write `12` as the Arduino GPIO constant for the RED technical button.
The same distinction applies to every module pad in the table.

### Boot and peripheral constraints on selected button GPIOs

GPIO8 is a C6 boot-mode strapping pin and is used here for `SW7`. GPIO15 is a
JTAG-source strapping pin and is used here for `SW4`. They are valid GPIOs and
can be used after reset, but the button pull-up/pull-down network must not
prevent the required reset-time strap levels. Test every boot condition with
each button pressed and released.

GPIO0, GPIO1, GPIO6, GPIO7, GPIO14, and GPIO19 do not have the same boot-mode
selection role, but still require normal GPIO electrical review. Keep USB
GPIO12/13 free for programming and keep UART0 GPIO16/17 free if the UART
programming/debug header is populated.

There is no physical CANCEL button in the eight-button allocation. The SFTS
backend supports the `CANCEL` protocol button, but it is currently available
only through software/referee controls unless another hardware input is added.

## Status LEDs

All four status outputs are active-low. The LED anodes are intended to be
powered from `V_IN`, while the ESP32 GPIOs sink the LED current so the buck
converter output is not used for LED load.

| Reference | Label | Function | ESP32-C6 module pad | Arduino GPIO |
|---|---|---|---:|---:|
| D2 | `LED_HONG` | Blink once for a RED/HONG button press | 9 / IO4 | **4** |
| D3 | `LED_CHUNG` | Blink once for a BLUE/CHUNG button press | 10 / IO5 | **5** |
| D4 | `LED_WIFI` | Wi-Fi/application heartbeat indication | 26 / IO20 | **20** |
| D5 | `LED_BATT` | Blink when calibrated battery percentage is below 20% | 27 / IO21 | **21** |

The firmware should drive D2/D3 from accepted local button events, D4 from a
successful application heartbeat/acknowledgement, and D5 from the calibrated
battery result. A merely open TCP socket should not be treated as proof that
the backend is accepting events.

**LED electrical sign-off is required:** because `V_IN` can be higher than
`+3V3`, a directly connected LED from `V_IN` to a push-pull ESP32 GPIO may
still conduct when the GPIO is driven HIGH and can inject current into the
GPIO. Verify the exact LED/resistor topology. If needed, use open-drain
operation with suitable protection or a transistor/MOSFET low-side driver for
each LED.

GPIO4 and GPIO5 are the C6 MTMS/MTDI-related pins. Since they drive status
LEDs, verify their reset-time loading and ensure the LED networks do not alter
boot/debug behavior.

## Complete ESP32-C6-MINI-1 mapping

The following table separates the schematic’s module pad number from the
Arduino GPIO number used by firmware.

| Purpose | Schematic signal | Module pad / label | Arduino GPIO | Notes |
|---|---|---:|---:|---|
| Battery ADC | `V_SNS` | 5 / IO2 | **2** | ADC1_CH2; enable Q1 first. |
| Divider enable | `V_SNS_EN` | 6 / IO3 | **3** | Drives BSS138 gate. |
| RED technical | `SW_R_TECH` | 12 / IO0 | **0** | Interrupt input. |
| RED head | `SW_R_HEAD` | 13 / IO1 | **1** | Interrupt input. |
| RED chest | `SW_R_CHEST` | 19 / IO14 | **14** | Interrupt input. |
| RED fist | `SW_R_FIST` | 20 / IO15 | **15** | Interrupt input; strap-related. |
| BLUE technical | `SW_B_TECH` | 15 / IO6 | **6** | Interrupt input. |
| BLUE head | `SW_B_HEAD` | 16 / IO7 | **7** | Interrupt input. |
| BLUE chest | `SW_B_CHEST` | 22 / IO8 | **8** | Interrupt input; boot strap. |
| BLUE fist | `SW_B_FIST` | 25 / IO19 | **19** | Interrupt input. |
| RED LED | `LED_HONG` | 9 / IO4 | **4** | Active-low sink; strap-related. |
| BLUE LED | `LED_CHUNG` | 10 / IO5 | **5** | Active-low sink; strap-related. |
| Wi-Fi LED | `LED_WIFI` | 26 / IO20 | **20** | Active-low sink. |
| Battery LED | `LED_BATT` | 27 / IO21 | **21** | Active-low sink. |
| USB D- | `USB-` | 17 / IO12 | **12** | USB Serial/JTAG D-. |
| USB D+ | `USB+` | 18 / IO13 | **13** | USB Serial/JTAG D+. |
| Boot strap reference | `PIN_BOOT_STRAP` | 23 / IO9 | **9** | Keep floating/high for SPI boot. |
| UART RX | `U0RXD` | 30 / RXD0 / IO17 | **17** | Factory UART receive. |
| UART TX | `U0TXD` | 31 / TXD0 / IO16 | **16** | Factory UART transmit. |

## SFTS backend protocol

### Remote identity and mode

The backend supports four fixed logical remote IDs:

| Device ID | Physical corner | Enabled in remote mode |
|---|---:|---|
| `C1` | Corner 1 | 1, 2, 3, or 4 remotes |
| `C2` | Corner 2 | 2, 3, or 4 remotes |
| `C3` | Corner 3 | 3 or 4 remotes |
| `C4` | Corner 4 | 4 remotes |

The host selects the active count in SETTINGS → REMOTE SETTINGS. The strict
majority requirement is 1 vote for 1 remote, 2 votes for 2 remotes, 2 votes
for 3 remotes, and 3 votes for 4 remotes. Votes are keyed by corner, so one
remote cannot count twice.

An authenticated remote above the selected active count remains connected but
its event is acknowledged as `REMOTE_DISABLED` and cannot score.

### Authentication handshake

Send this JSON text message after the WebSocket connects:

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

The backend requires protocol version `1`, a device ID of `C1`–`C4`, and a
session ID of 1–64 characters matching `[A-Za-z0-9._:-]+`. The token must
match the device entry in `config/remote-config.json`, unless the development
override `SFTS_ALLOW_UNPAIRED_REMOTES=true` is explicitly enabled.

The server replies with:

```json
{
  "type": "remote_ready",
  "protocolVersion": 1,
  "deviceId": "C1",
  "corner": 1,
  "sessionId": "sfts-0123456789abcdef"
}
```

The firmware must not send scoring events until `remote_ready` has been
validated. A transport-connected WebSocket is not the same as an
application-ready remote.

### Session and sequence rules

Every event has a positive integer sequence:

```json
{
  "type": "remote_event",
  "deviceId": "C1",
  "sessionId": "sfts-0123456789abcdef",
  "sequence": 42,
  "button": "RED_2"
}
```

The sequence must never be reused within one session. A new device boot must
create a new session ID. A Wi-Fi reconnect during the same boot must retain
the session ID and sequence counter. The backend retains same-session replay
protection and acknowledgement data for up to 24 hours.

### Acknowledgements and reliability

The backend returns `remote_event_ack` for every accepted or rejected event.
Typical reasons are:

| Reason | Meaning |
|---|---|
| `POINT_AWARDED` | This event completed the required majority and was scored. |
| `VOTE_RECORDED` | This event was recorded; other corners are still required. |
| `TECHNICAL_PENDING` | A technical modifier is waiting for its matching base point. |
| `TEST_PRESS_RECORDED` | Test mode registered the control; score unchanged. |
| `VOTE_CANCELLED` | This corner’s pending vote/combination was cleared. |
| `MATCH_NOT_RUNNING` | The match is paused or has not started. |
| `ROUND_NOT_ACTIVE` | The scoreboard is between rounds or at match end. |
| `REMOTE_DISABLED` | This corner is above the configured active count. |
| `INVALID_BUTTON` | The button name is not part of the protocol. |
| `SEQUENCE_REPLAY` | The sequence was already used or is not newer. |

The firmware must retain an event until an acknowledgement with the matching
device/session/sequence is received. A successful WebSocket `send` only means
the message entered the transport. Retrying the same sequence is safe because
the backend caches/replays the acknowledgement without scoring twice.

The firmware implementation should use a FIFO outbox, retry the oldest
unacknowledged event, and keep input scanning independent from network timing.
The backend also rate-limits WebSocket messages, so avoid high-frequency retry
loops.

### Telemetry and liveness

After authentication, send status approximately every 10 seconds:

```json
{
  "type": "remote_status",
  "deviceId": "C1",
  "sessionId": "sfts-0123456789abcdef",
  "rssi": -61,
  "battery": 78
}
```

`rssi` must be an integer from `-127` to `0`. `battery` must be an integer
percentage from `0` to `100`, or `null` if not measured. The backend returns
`remote_status_ack` and updates the dashboard telemetry card.

The backend’s application liveness timeout is three 10-second intervals,
approximately 30 seconds without a valid hello, status, event, or ping. The
WebSocket transport also uses ping/pong heartbeat checks. D4 should indicate
successful application heartbeat/acknowledgement, not only Wi-Fi association.

An authenticated remote may also send `remote_ping`; the backend replies with
`remote_pong`.

## Scoring behavior expected by the backend

| Physical button | Protocol button | Base result |
|---|---|---:|
| RED fist | `RED_1` | +1 RED |
| RED chest | `RED_2` | +2 RED |
| RED head | `RED_3` | +3 RED |
| RED technical | `RED_TECHNICAL` | Modifier only |
| BLUE fist | `BLUE_1` | +1 BLUE |
| BLUE chest | `BLUE_2` | +2 BLUE |
| BLUE head | `BLUE_3` | +3 BLUE |
| BLUE technical | `BLUE_TECHNICAL` | Modifier only |

Technical input is a same-corner modifier within the configured 1,000 ms
window:

- technical + chest, in either order, awards +4 for that side;
- technical + head, in either order, awards +6 for that side;
- technical + fist is not eligible;
- technical alone does not award a point;
- a side mismatch or expired combination does not award the technical value.

Normal remote scoring is accepted only during a started, running `ROUND`,
outside test mode and Kye-shi. Pause, timer expiry, breaks, match end, and
Kye-shi prevent normal scoring and produce a non-awarding acknowledgement.

## Firmware behavior required for this hardware

The Arduino sketch at `firware/firware.ino` should implement:

- the Arduino GPIO numbers in the mapping table, not the module pad numbers;
- active-low button inputs with 10 kΩ external pull-ups;
- falling/change-edge interrupts plus software debounce;
- exactly one event per press and re-arm only after stable release;
- `V_SNS_EN` control, ADC settling delay, battery calibration, and shutdown
  of the divider after measurement;
- a new valid session ID on every boot and a monotonically increasing sequence
  within that session;
- matching acknowledgement validation before removing an event from the
  outbox;
- local RED/BLUE LED blink feedback;
- application heartbeat feedback on D4;
- calibrated low-battery blink on D5 below 20%;
- clean reconnect after Wi-Fi loss or backend application error;
- USB Serial/JTAG programming through IO12/IO13 without using those pins for
  buttons or LEDs.

The firmware should parse the JSON response type and validate device ID,
session ID, and sequence. It must not treat an arbitrary message containing
the text `remote_ready` as a valid handshake response.

## Hardware sign-off checklist

1. Use Arduino GPIO numbers from the mapping table in the final sketch.
2. Confirm all eight button nets are active-low and have 3.3 V pull-ups.
3. Verify GPIO8/GPIO15 button reset behavior and GPIO4/GPIO5 LED reset loading.
4. Verify J3 bypass behavior, USB-to-battery isolation, and no unsafe
   backfeed when a battery is fitted.
5. Verify the MCP73831 charge current, Li-Po cell rating, thermal behavior,
   termination behavior, and charge indication.
6. Recalculate the TPS62821 feedback divider for the intended `+3V3` output;
   the stated 435 kΩ/100 kΩ values require confirmation.
7. Confirm the BSS138 divider switch leaves `V_SNS` within ADC limits in all
   power, reset, and switch states.
8. Confirm every LED has a safe current-limited off state when powered from
   `V_IN` and sunk by a 3.3 V GPIO.
9. Confirm the regulator, decoupling, EN/reset, antenna keep-out, module
   ground, and USB/UART programming provisions against the module guidance.
10. Confirm the final firmware reports real calibrated battery percentage and
    does not retain the dummy value `100`.

## Backend bring-up test

From the software project root:

```bash
npm install
npm test
npm start
```

For a physical remote:

1. Set the SFTS server LAN IP, Wi-Fi credentials, C1–C4 identity, and matching
   token in the firmware.
2. Start the server and confirm it prints port `8080` and configured remote
   IDs.
3. Open the scoreboard and select the matching remote count.
4. Confirm WebSocket connected → validated `remote_ready` → `remote_state`.
5. Use REMOTE SETTINGS test mode to press all eight buttons; confirm the
   correct corner/button feedback and no score change.
6. Test 1/2/3/4-remote majority behavior: required votes are 1/2/2/3.
7. Test normal points, both technical press orders, technical +1 rejection,
   pause, timer expiry, and remote-disabled behavior.
8. Verify D2/D3 button blink, D4 application heartbeat, and D5 below-20%
   battery indication.
9. Power-cycle the remote after advancing its sequence. Confirm the new boot
   session can score immediately after a new handshake.
10. Reconnect Wi-Fi without rebooting. Confirm the same session resumes and a
    retried event cannot double-score.
11. Leave the remote silent for approximately 30 seconds and confirm the
    scoreboard shows it disconnected.

For protocol-only testing without hardware:

```bash
npm run simulate:remote -- C1 RED_2 1 ws://127.0.0.1:8080
```

## Component references

- [ESP32-C6-MINI-1 datasheet](https://documentation.espressif.com/esp32-c6-mini-1_mini-1u_datasheet_en.html)
- [ESP32-C6-MINI-1 datasheet copy provided with the hardware context](https://robu-prod-media.s3.ap-south-1.amazonaws.com/products/attachments/skN0ZLBl6zGuNZ3S3A5eiM3ADkTIXfNHUQ8hrQ1l.pdf)
- [ESP32-C6 GPIO and interrupt reference](https://docs.espressif.com/projects/esp-idf/en/latest/esp32c6/api-reference/peripherals/gpio.html)
- [Espressif ESP32-C6 hardware design guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c6/schematic-checklist.html)
- [MCP73831T-2ACI/OT datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/APID/ProductDocuments/DataSheets/MCP73831-Family-Data-Sheet-DS20001984H.pdf)
- [TPS62821/TPS6282x datasheet](https://www.ti.com/lit/ds/symlink/tps62823.pdf)
