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
- Category match import from Excel/CSV with explicit HONG/CHUNG sides and supplied match order.
- Shared manual/imported category results, placement review, finalization and PDF export.
- Schedule viewing, announcements, Excel/CSV download, and printing.
- Local state recovery after restart, with a backup snapshot.
- Optional local Piper text-to-speech; browser speech is only a fallback.
- Remote acknowledgements, replay protection, fixed corner IDs, access tokens, heartbeats, and message limits.

### Rules configuration foundation

The current match behavior is described by [`config/rules.default.json`](config/rules.default.json). At startup, the server first checks for an optional `data/active-rules.json` file (or the path in `SFTS_RULES_FILE`), validates it, and safely falls back to the built-in rules if it is missing or invalid. The host SETTINGS screen provides a Rules workflow for previewing and applying validated JSON packs from the USB drive, with an automatic local backup for rollback.

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

Backend hardening and Pi 3 resource limits, measurements, remaining limits and the isolated hardware benchmark are documented in [the backend audit](docs/backend-audit-pi3.md). The production lockfile pins the patched official SheetJS CDN release; installation needs access to that CDN during maintenance. The server omits the host token from logs in kiosk mode.

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

The Pi network should use its built-in Wi-Fi for maintenance internet/SSH and Ethernet for the dedicated remote router. The remote router should provide the `192.168.50.x` network, while the Pi's default internet route must remain on `wlan0`. The kiosk Chromium profile is separately restricted to the local scoreboard origin even when the Pi has maintenance internet access.

From the Pi project checkout, run:

```bash
cd ~/sfts-software
git switch deployment
git pull --ff-only origin deployment
bash deployment/scripts/check-network.sh
sudo bash deployment/install.sh
```

The installer checks or installs Node.js, Python virtual-environment support, `curl`, `flock`, `swaybg`, `polkitd`, and Chromium, installs production dependencies, preserves the `data` directory and local environment file, installs the Piper voice environment/model and `sfts-piper.service`, and configures the `sfts-scoreboard.service` systemd unit. It configures Raspberry Pi OS Desktop with a dedicated labwc kiosk session that bypasses the normal wallpaper/panel/notification startup, auto-logs in, sets the default audio output to 85% and unmuted, and launches Chromium in kiosk mode after boot. Root-owned Chromium policies allow only the local dashboard origin, redirect new tabs/home/startup to the dashboard, and disable guest/incognito browsing, extensions, DevTools, sign-in, and file-selection dialogs. Labwc consumes browser navigation and developer shortcuts, while the dashboard suppresses context menus and file drops. The kiosk waits for the server before opening and restarts Chromium after clean exits or crashes; the Labwc autostart loop also restarts the launcher if it exits. The installer suppresses boot splash/log output so the display transitions cleanly to the scoreboard. After verification, the installer gives a 10-second countdown and reboots automatically; use `SFTS_SKIP_REBOOT=true` for a maintenance run without rebooting. It sets `PORT=8080` and `SFTS_KIOSK_MODE=true`, so the local host browser does not require manual token entry. Kiosk authorization additionally requires the exact local dashboard WebSocket origin. Backend authentication remains enabled for non-kiosk connections.

The host SETTINGS screen also provides REBOOT and SHUTDOWN controls. Each action requires confirmation, waits 15 seconds, and can be cancelled during the countdown. The installer adds a narrowly scoped polkit rule for the non-root service account, allowing these two actions without a sudo prompt; no sudo command is used by the scoreboard server.

If Chromium ever shows an internal error page instead of the dashboard, press **Ctrl+Alt+Shift+R**. The dedicated kiosk binding terminates only the current user's Chromium processes, and the supervised launcher opens a fresh local dashboard after two seconds.

Open the host dashboard on the Pi at `http://127.0.0.1:8080`. Configure the ESP32 remotes with the Pi's Ethernet address, normally `ws://192.168.50.102:8080`, and their matching tokens from `config/remote-config.json`.

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

The current C1 firmware uses remote protocol v2. Each physical scoring press is queued with a sequence number and its capture age, sent promptly, and retried until the server acknowledges it. The server accepts distinct rapid presses, including identical scores less than 750 ms apart, while a retry of the same sequence cannot score twice. Events older than 2.5 seconds are discarded rather than applied to a later match state. The server also accepts protocol v1 during the transition, but the v2 firmware and server should be deployed together.

The scoring buttons send `RED_1`, `RED_2`, `RED_3`, `BLUE_1`, `BLUE_2`, and `BLUE_3`. For a technical score, press or hold the same side's `TECHNICAL` button and press +2 or +3 within one second; firmware v2 sends one atomic `RED_TECHNICAL_2/3` or `BLUE_TECHNICAL_2/3` scoring event. If the scoring button lands just before `TECHNICAL`, a 150 ms chord window still combines them; a lone +2/+3 is delayed by at most that window. The technical button also sends its own non-scoring event, but Remote Settings validates a technical check only after the matching head or chest combination arrives. A technical press alone awards no points or test check, and technical +1 is not a scoring input. Legacy firmware may still send a separate technical modifier, which the server supports during migration and in test mode.

The remote reports Wi-Fi RSSI, battery, queued-event count, retry count, and dropped-input/event counters in `remote_status`. The operator's corner card shows these delivery indicators and the last event reason. A rejected event also produces a dashboard notice. A connected remote or green LED alone does not prove that a point was awarded; confirm the score and watch for dropped counts.

For local development only, unpaired remotes can be allowed with `SFTS_ALLOW_UNPAIRED_REMOTES=true`. Do not use that setting during a real event.

Use **SETTINGS → REMOTE SETTINGS** to choose 1–4 active remotes. Each red/blue side has five checks, ordered head (+3), chest (+2), TECHNICAL HEAD, TECHNICAL CHEST, and punch (+1); the three normal scoring checks use the existing headgear, chestguard and fist icons. Test each normal scoring button separately and both technical combinations on each side. The centre tick appears only after all ten distinct checks pass for that corner; a technical button alone does not validate either technical check. The required matching vote count is 1, 2, 2, or 3 for modes 1, 2, 3, or 4. Test mode pauses the timer, clears pending votes, and does not change the score.

Each corner card shows `CONNECTED` or `DISCONNECTED`, the latest RSSI in dBm, and the latest battery percentage. A remote that has never reported telemetry shows `—` for that value.

For one-remote use, select mode 1 before scoring. With the match running, verify repeated identical +1/+2/+3 taps less than 750 ms apart, mixed-side taps, a short tap, technical +2/+3, technical +1 rejection, and a disconnect/reconnect. Every accepted press should change the score exactly once; `QUEUED` should return to 0 and `DROPPED` should stay at 0. The four-remote voting and near-simultaneous-incident cases require a separate physical test with all four devices before an event.

## Independent category import

The current Excel template also includes an official arena `Schedule`. It alternates categories to give every player at least one scored match between appearances, including before finals. SFTS validates and follows that order; Load Next Match selects the scheduled category automatically. See [the scheduled fixture exporter contract](docs/scheduled-fixture-format.md) to build compatible fixture software. Workbooks without Schedule retain the category-only flow below.

Data Import uses the same decision-card style as manual entry:

1. **Event:** enter tournament name, date, venue, arena and competition.
2. **File:** select an Excel/CSV opening fixture from USB (or a desktop file during development).
3. **Review:** check the imported division, gender, category, HONG/CHUNG sides and BYEs. Confirm before starting.
4. **Matches:** use **LOAD NEXT MATCH**, score normally, then choose **CONTINUE CATEGORY**. SFTS advances adjacent winners locally without reshuffling.
5. **Results:** review and finalize gold, silver and bronze through the existing manual results/PDF workflow.

The file supplies the **opening round only**, including every competitor and explicit BYE positions. Use the supplied `sfts-match-template.xlsx`; its Categories sheet reflects the active rulepack. Opening row counts must be a power of two: 1 FINAL, 2 SEMIFINAL, 4 QUARTERFINAL, or 8 and above PRELIMINARY. A BYE has one actual competitor and an empty/BYE opponent with no club/state/district.

Required columns: Bout Number, Stage, Division, Gender, the applicable Weight Category or Group, and both actual competitors' Hong/Chung Name and Club. State Code and District are optional. HONG is red; CHUNG is blue. Each competitor appears once in the opening file. Subsequent rounds and references are generated locally.

A winner can be corrected with confirmation before a dependent bout is loaded; corrections update the pending match, archived result and medals with an audit entry. Draws require a winner before advancement. BYEs never create fake scored matches. At least two actual entrants are required.

Imports and match loading cannot replace an unfinished match. Restart restores the category and loaded bout paused. Reimporting the same opening fixture preserves completed results; another category replaces the active list while keeping archived results. Previously saved explicit lists and legacy brackets remain recoverable. Manual entry retains its existing flow.

Supported: `.xlsx`, `.xls`, `.csv`, first worksheet only, **4 MB**, up to **512 competitors / 511 total bouts**. Existing bounded parsing and compact state updates remain in use.

See [the opening fixture file contract](docs/category-match-import.md) for the exact fields, BYE example, operating rules and recovery behavior.

## Saved data and safe restart

The server saves local data in the `data` folder:

- `sfts-state.json` — current match, history, and tournament progress.
- `sfts-state.backup.json` — previous valid snapshot.
- `sfts-state.lock` — prevents two servers using the same data folder.
- `manual-results.json` and its backup — shared manual/imported category records and placements, retained independently of the recent match-history list.

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
