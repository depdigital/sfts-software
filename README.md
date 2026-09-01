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

## ESP32 remotes

Configure every remote with:

- The Raspberry Pi’s LAN IP, not `localhost`.
- WebSocket port `8080` by default.
- A fixed device ID: `C1`, `C2`, `C3`, or `C4`.
- A unique session ID for each boot/session.
- The matching remote token.

Set remote tokens before starting the server:

```bat
set SFTS_REMOTE_TOKEN_C1=private-token-for-c1
set SFTS_REMOTE_TOKEN_C2=private-token-for-c2
set SFTS_REMOTE_TOKEN_C3=private-token-for-c3
set SFTS_REMOTE_TOKEN_C4=private-token-for-c4
npm start
```

The remote sends `RED_1`, `RED_2`, `RED_3`, `BLUE_1`, `BLUE_2`, `BLUE_3`, or `CANCEL`. The server sends an acknowledgement for every event. Retrying the same sequence number does not score twice.

For local development only, unpaired remotes can be allowed with `SFTS_ALLOW_UNPAIRED_REMOTES=true`. Do not use that setting during a real event.

Use **SETTINGS → TEST REMOTES** to check all six buttons on each corner. Test mode pauses the timer, clears pending votes, and does not change the score.

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

## Local announcements with Piper

Piper is optional. Keep its executable and ONNX voice model on the same PC/Raspberry Pi. Example on Windows PowerShell:

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
