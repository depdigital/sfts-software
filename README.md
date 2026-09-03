# SFTS Taekwondo Scoring System

SFTS is a local-network scoring system for taekwondo matches. It runs on one computer or Raspberry Pi, shows the scoreboard in a browser, and accepts votes from up to four ESP32 referee remotes.

## Network layout

```text
ESP32 remotes --Wi-Fi--> Wi-Fi router --Ethernet--> Raspberry Pi (SFTS server)
                                                   |
                                           Host scoreboard browser
```

The event does not need internet. The dashboard, JavaScript, CSS, logo, tournament tools, saved data, and optional speech files are local. Internet is only needed if you still need to install/download software or voice files.

## What it can do

- Best-of-three scoring with +1, +2, +3, gam-jeom, timer, breaks, and winner display.
- Four-corner referee voting. Three matching votes award a point.
- Tournament player import from Excel/CSV, grouped by gender and weight category.
- Random single-elimination brackets with byes and result-based next matches.
- Tie-pending matches that must be resolved before the bracket continues.
- Schedule viewing, announcements, Excel/CSV download, and printing.
- Local state recovery after restart, with a backup snapshot.
- Optional local Piper text-to-speech; browser speech is only a fallback.
- Remote acknowledgements, replay protection, fixed corner IDs, access tokens, heartbeats, and message limits.

### Rules configuration foundation

The current match behavior is described by [`config/rules.default.json`](config/rules.default.json). At startup, the server first checks for an optional `data/active-rules.json` file (or the path in `SFTS_RULES_FILE`), validates it, and safely falls back to the built-in rules if it is missing or invalid. Rule updates are not exposed in the dashboard yet; the future Rules screen and USB import workflow will be added in a later stage.

## Install and run

Install Node.js 18 or newer, then open a terminal in this folder:

```bash
npm install
npm test
npm start
```

Open `http://localhost:8080` on the host computer. The server also prints its LAN address. Other devices must use that LAN address, for example `http://192.168.1.20:8080`.

The server prints a **Host access token** when it starts. Enter that token on the dashboard home screen before selecting **LAUNCH SCOREBOARD**. For a fixed token, set it before starting:

Windows Command Prompt:

```bat
set SFTS_HOST_TOKEN=put-a-long-private-token-here
npm start
```

PowerShell:

```powershell
$env:SFTS_HOST_TOKEN = "put-a-long-private-token-here"
npm start
```

Keep the token private. Only use the server on the closed local event network; do not expose its port to the internet.

### Kiosk mode

For a Raspberry Pi kiosk, enable kiosk mode and open the dashboard at `http://127.0.0.1:8080`. The local kiosk browser is authorized automatically, so the operator does not type a token. Other computers still need the host token.

Windows test:

```powershell
$env:SFTS_KIOSK_MODE = "true"
npm start
```

Use kiosk mode only when the browser is running on the same machine as the server. On the Pi, put `SFTS_KIOSK_MODE=true` in the service configuration. The dashboard reconnects automatically if the server restarts and requests a fresh host session.

## Raspberry Pi deployment

The `deployment` branch is reserved for the Raspberry Pi installation. The deployment files are kept under `deployment/`:

```text
deployment/
├── install.sh
├── config/sfts-scoreboard.env.example
├── polkit/sfts-scoreboard-power.rules
├── scripts/check-network.sh
├── scripts/start-kiosk.sh
└── systemd/
   ├── sfts-piper.service
   └── sfts-scoreboard.service
```

The Pi network should use its built-in Wi-Fi for internet/SSH and Ethernet for the dedicated remote router. The remote router should provide the `192.168.50.x` network, while the Pi's default internet route must remain on `wlan0`.

From the Pi project checkout, run:

```bash
cd ~/sfts-software
git switch deployment
git pull --ff-only origin deployment
bash deployment/scripts/check-network.sh
sudo bash deployment/install.sh
```

The installer checks or installs Node.js, Python virtual-environment support, `curl`, `flock`, `swaybg`, `polkitd`, and Chromium, installs production dependencies, preserves the `data` directory and local environment file, installs the Piper voice environment/model and `sfts-piper.service`, and configures the `sfts-scoreboard.service` systemd unit. It configures Raspberry Pi OS Desktop with a dedicated labwc kiosk session that bypasses the normal wallpaper/panel/notification startup, auto-logs in, sets the default audio output to 85% and unmuted, and launches Chromium in kiosk mode after boot. The kiosk startup immediately hides any remaining common desktop panels/icons and uses a solid black background while the server becomes ready. The installer suppresses boot splash/log output so the display transitions cleanly to the scoreboard. The kiosk waits for the server before opening and restarts Chromium if it closes. After verification, the installer gives a 10-second countdown and reboots automatically; use `SFTS_SKIP_REBOOT=true` for a maintenance run without rebooting. It sets `PORT=8080` and `SFTS_KIOSK_MODE=true`, so the local host browser does not require manual token entry. Backend authentication remains enabled for non-kiosk connections.

The host SETTINGS screen also provides REBOOT and SHUTDOWN controls. Each action requires confirmation, waits 15 seconds, and can be cancelled during the countdown. The installer adds a narrowly scoped polkit rule for the non-root service account, allowing these two actions without a sudo prompt; no sudo command is used by the scoreboard server.

Open the host dashboard on the Pi at `http://localhost:8080`. Configure the ESP32 remotes with the Pi's Ethernet address, normally `ws://192.168.50.102:8080`, and their matching tokens from `config/remote-config.json`.

Useful service commands:

```bash
sudo systemctl status sfts-scoreboard.service --no-pager
sudo journalctl -u sfts-scoreboard.service -f
```

For the full installer, service, network-check, update, and troubleshooting instructions, see [`deployment/README.md`](deployment/README.md).

## ESP32 remotes

Configure every remote once before the event with:

- The Raspberry Pi’s LAN IP, not `localhost`.
- WebSocket port `8080` by default.
- A fixed device ID: `C1`, `C2`, `C3`, or `C4`.
- A unique session ID for each boot/session.
- The matching remote token in `config/remote-config.json`.

The server loads `config/remote-config.json` automatically at startup, so the
event operator does not need to enter remote tokens in a terminal. Each remote
must be flashed once with its matching `REMOTE_DEVICE_ID` and `REMOTE_TOKEN`.
The checked-in file contains the default C1-C4 pairing values used by this
installation; keep it private if the project is copied outside the event LAN.

Environment variables are still supported as overrides for development:

```bat
set SFTS_REMOTE_TOKEN_C1=private-token-for-c1
set SFTS_REMOTE_TOKEN_C2=private-token-for-c2
set SFTS_REMOTE_TOKEN_C3=private-token-for-c3
set SFTS_REMOTE_TOKEN_C4=private-token-for-c4
npm start
```

The remote sends `RED_1`, `RED_2`, `RED_3`, `RED_TECHNICAL`, `BLUE_1`, `BLUE_2`, `BLUE_3`, `BLUE_TECHNICAL`, or `CANCEL`. It also sends its Wi-Fi RSSI and battery percentage in a `remote_status` message. The `TECHNICAL` button is a modifier: press it with the same corner's +2 or +3 within one second to award +4 or +6. `TECHNICAL` with +1 is rejected, and a technical press by itself awards no points. The server sends an acknowledgement for every event. Retrying the same sequence number does not score twice.

For local development only, unpaired remotes can be allowed with `SFTS_ALLOW_UNPAIRED_REMOTES=true`. Do not use that setting during a real event.

Use **SETTINGS → REMOTE SETTINGS** to choose 1–4 active remotes and check all eight buttons on each enabled corner. The required matching vote count is 1, 2, 2, or 3 for modes 1, 2, 3, or 4. Test mode pauses the timer, clears pending votes, and does not change the score.

Each corner card shows `CONNECTED` or `DISCONNECTED`, the latest RSSI in dBm, and the latest battery percentage. A remote that has never reported telemetry shows `—` for that value.

## Tournament workflow

1. Open **PLAYER SETTINGS**.
2. Download the template or prepare your own sheet.
3. Upload it and select **IMPORT & GENERATE SCHEDULE**.
4. Open **VIEW SCHEDULE**.
5. Load only a bout marked **SCHEDULED**.
6. Finish the match. The winner automatically advances to the next bracket bout.
7. If the match is tied, select **RED WINS** or **BLUE WINS** after the official tie-break decision.
8. Download or print the schedule and use **ANNOUNCE** when required.

Import is blocked while a match is active, has scores/penalties/votes, is in a break, or has a loaded tournament bout. This prevents the current match from being replaced accidentally.

## Excel player template

The first worksheet must have these required columns:

```csv
Player ID,Name,Gender,Weight Category,State Code,District,Club
M58-01,Arjun Mehta,MALE,58 kg,DL,New Delhi,SFTS Demo Club
M58-02,Rohan Singh,MALE,58 kg,UP,Noida,SFTS Demo Club
F49-01,Ananya Kapoor,FEMALE,49 kg,MH,Pune,SFTS Demo Club
```

`Name`, `Gender`, and `Weight Category` are required. The other columns are optional. Use `MALE` or `M`, and `FEMALE` or `F`. Player IDs must be unique; if blank, the system creates one. Use formats such as `58 kg`, `49 kg`, or `68 kg`. Players are never paired across gender or weight category.

The **DOWNLOAD TEMPLATE** button contains dummy players in several groups so byes and multiple brackets can be tested safely.

## Saved data and safe restart

The server saves local data in the `data` folder:

- `sfts-state.json` — current match, history, and tournament progress.
- `sfts-state.backup.json` — previous valid snapshot.
- `sfts-state.lock` — prevents two servers using the same data folder.

Important actions are saved immediately; timer snapshots are saved periodically. On restart, the match is paused and temporary votes/test presses are cleared. The host must reconnect and press **PLAY**. If the main file is damaged, the backup is used automatically.

To use another data folder:

```bat
set SFTS_DATA_DIR=D:\sfts-data
npm start
```

Stop the server before deleting state files to start a new event.

When the server is restarted, the dashboard reconnects automatically. The match remains paused until the host presses **PLAY**. ESP32 remotes must reconnect and send a new handshake/session before scoring; old pending votes are not restored.

## Local announcements with Piper

Piper is optional. For Raspberry Pi deployment, the installer runs Piper’s HTTP server locally with the official `en_GB-alan-medium` voice and configures the scoreboard to request audio from `127.0.0.1`. The generated WAV response is kept in the Node.js process memory and is served to the kiosk browser; it is not written to the SD card. The Piper service itself keeps the voice model loaded between announcements. The British-English voice is the closest official Piper option to formal Indian event English; an actual Indian-English accent requires a compatible third-party or custom Piper model.

Use these settings on the Pi:

```ini
SFTS_TTS_ENGINE=piper
SFTS_TTS_URL=http://127.0.0.1:5000/synthesize
```

For legacy CLI mode on a development computer, keep its executable and ONNX voice model on the same PC/Raspberry Pi. Example on Windows PowerShell:

```powershell
$env:SFTS_TTS_ENGINE = "piper"
$env:SFTS_TTS_COMMAND = "C:\tools\piper\piper.exe"
$env:SFTS_TTS_MODEL = "C:\tools\piper\voice.onnx"
npm start
```

Example on Raspberry Pi/Linux:

```bash
export SFTS_TTS_ENGINE=piper
export SFTS_TTS_COMMAND=/opt/piper/piper
export SFTS_TTS_MODEL=/opt/sfts/voices/voice.onnx
npm start
```

If Piper is not found, the browser uses its built-in speech voice. No cloud speech service is used.

## Useful commands

```bash
npm test
npm run simulate:remote -- C1 RED_2 1 ws://127.0.0.1:8080
```

The simulator is useful before ESP32 hardware is available. Run separate simulator terminals for C1, C2, and C3 to test a majority vote.

## Important limits

This repository contains the server, dashboard, and simulator; ESP32 firmware is separate. The system is designed for a trusted LAN and is not an internet-facing service. Confirm the scoring and tie-break rules with the event officials before competition use.
