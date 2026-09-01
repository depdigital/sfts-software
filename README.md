# SFTS Taekwondo Scoring System

SFTS is a LAN-based taekwondo match scoring application. One host runs the scoring server and scoreboard, while dedicated C1–C4 ESP32 remotes submit votes in real time.

This repository contains the scoring dashboard, backend remote protocol, and simulator for ESP32-based physical remotes. Raspberry Pi appliance deployment and the actual ESP32 firmware are not yet implemented.

## Current features

- Host scoreboard for red and blue competitors.
- Up to four physical remote corners, C1–C4.
- One connected host and one connected remote per corner.
- 3-of-4 majority voting for +1, +2, and +3 points.
- Host controls for points, gam-jeom, score editing, names, and timer control.
- Best-of-three match flow.
- 60-second default rounds and 35-second breaks.
- Automatic round ending after timer expiry, a 15-point gap, or five gam-jeom.
- Round summaries with score, gam-jeom, and point-type statistics.
- Match winner screen and match numbering.
- Host-only remote test mode for checking all C1–C4 remotes.
- Tournament player-sheet import with same-gender, same-weight round-robin scheduling.
- Tournament schedule viewing, bout loading, announcer messages, Excel/CSV download, and print layout.
- ESP32 remote protocol with fixed C1–C4 identities, token authentication, acknowledgements, and sequence-based duplicate protection.
- Node-based remote simulator for backend testing before hardware is available.
- In-memory history of the last 50 completed matches.

## Backend reliability

The backend uses Express and WebSocket communication through a single Node.js process.

The current backend includes:

- WebSocket ping/pong heartbeats and disconnected-client cleanup.
- Vote removal when a referee disconnects.
- Host and referee-corner connection exclusivity.
- Input validation and malformed-message protection.
- WebSocket payload and slow-client limits.
- Timestamp-based timer tracking to reduce timer drift, with timer expiry checked before processing incoming commands.
- Protection against scoring outside an active round.
- Authenticated ESP32 remote handshakes with fixed corner assignment.
- Role-scoped WebSocket delivery: ESP32 remotes receive compact state only; full match history is sent only to host/referee browsers.
- Remote event acknowledgements and replay protection.
- Remote test mode clears pending votes and pauses the timer so a hardware check cannot carry stale votes into scoring.
- Tournament file actions require the active host session and are limited to 500 player rows and 5,000 generated bouts per import.
- Graceful shutdown handling.
- Automated HTTP and WebSocket integration tests.

## Requirements

- Node.js 18 or newer recommended.
- A host computer or Raspberry Pi connected to a local network.
- Referee devices on the same Wi-Fi network.

The current version does not require internet access after dependencies have been installed.

## How to run

### 1. Install dependencies

Open a terminal in the project directory:

```bash
npm install
```

### 2. Run the backend tests

```bash
npm test
```

The tests verify the HTTP server, WebSocket remote protocol, vote cleanup, timer expiry, phase restrictions, and malformed input handling.

### 3. Start the application

```bash
npm start
```

The server listens on port `8080` by default and prints the available local and Wi-Fi URLs.

### 4. Open the host scoreboard

On the host computer, open:

```text
http://localhost:8080
```

Select **MAIN SCOREBOARD**, then use the host controls to configure the match.

### 5. Test the physical remotes

1. Put the host computer and all ESP32 remotes on the same local Wi-Fi network.
2. Start the server on the host and note the printed **Wi-Fi** URL. Configure each remote with the host address, for example `ws://192.168.0.106:8080`; never use `localhost` on an ESP32.
3. From the host landing screen, select **MAIN SCOREBOARD**, open **SETTINGS**, then select **TEST REMOTES**.
4. Press all six scoring buttons on each remote: `RED_1`, `RED_2`, `RED_3`, `BLUE_1`, `BLUE_2`, and `BLUE_3`.
5. A successful press is acknowledged by the backend and lights the matching control. All six unique buttons mark that corner as passed.

Test mode pauses the match timer, clears pending votes, and records button presses without changing scores. Select **EXIT TEST** before starting a round.

For a quick pre-hardware check, use the simulator commands below. For a real hardware check, also confirm the ESP32 reconnects after a Wi-Fi interruption and that a press is not counted twice when its acknowledgement is retried.

## Tournament player sheet and schedule

Open **PLAYER SETTINGS** from the host scoreboard. The upload accepts `.xlsx`, `.xls`, and `.csv` files. The first worksheet must contain these required columns:

```text
Name | Gender | Weight Category
```

The optional columns are `Player ID`, `State Code`, `District`, and `Club`. Gender values `MALE`/`M` and `FEMALE`/`F` are accepted. Player IDs are generated when omitted, but supplied IDs must be unique. State codes are validated against the Indian state-code list already used by player settings.

Selecting **IMPORT & GENERATE SCHEDULE** validates the entire sheet before replacing the current tournament list. Players are grouped by exact gender and case-insensitive weight category. Each group receives a seeded random order and a complete round-robin fixture list; every pairing is scheduled once. An odd-sized group receives a bye allocation. The seed is shown with the schedule so the draw can be identified and reproduced from the same player list and seed during a future audit.

The host can view the schedule, load an available bout into the normal scoring board, announce a bout to connected browser displays using generated announcement text, download the complete schedule as Excel or CSV, and print the schedule. Bye allocations are included in the schedule view and downloads. Importing is blocked while an active match contains scores, penalties, votes, a running timer, or remote test mode. Tournament data is held in memory for the current server run.

The downloadable template is available from **PLAYER SETTINGS → DOWNLOAD TEMPLATE**. A generated schedule contains bout number, group, gender, weight category, round, red player, blue player, status, winner, and announcement text.

### 6. Stop the application

Press `Ctrl+C` in the terminal running the server.

### Optional: change the port

Windows Command Prompt:

```bat
set PORT=8081
npm start
```

PowerShell:

```powershell
$env:PORT = "8081"
npm start
```

PowerShell environment variables must use the `$env:` prefix. Commands such as `set PORT=8081` do not configure the process environment in PowerShell.

Linux/macOS/Raspberry Pi:

```bash
export PORT=8081
npm start
```

## ESP32 remote backend

The backend accepts ESP32-style WebSocket clients using protocol version `1`.

Each remote must identify itself with a fixed device ID (`C1`, `C2`, `C3`, or `C4`), a session ID, and, when configured, a token. The device ID determines the referee corner; it cannot be selected by the client after connection. The server binds to `0.0.0.0`, so the ESP32 connects to the host's LAN/Wi-Fi address and the selected TCP port.

The connection flow is:

```text
WebSocket connect → remote_hello → remote_ready → remote_state
                                      └→ remote_event → remote_event_ack
```

Before authentication, the server does not send dashboard state or match broadcasts. After `remote_ready`, an ESP32 receives only compact `remote_state` updates, `remote_event_ack` responses, and `remote_pong` responses. `remote_state` excludes match history and browser-only events.

An event uses the following fields:

```json
{
  "type": "remote_event",
  "deviceId": "C1",
  "sessionId": "boot-1234",
  "sequence": 1,
  "button": "RED_2"
}
```

`button` must be `RED_1`, `RED_2`, `RED_3`, `BLUE_1`, `BLUE_2`, `BLUE_3`, or `CANCEL`. `sequence` must be a positive, strictly increasing safe integer for the current session. Re-sending a cached sequence returns the original acknowledgement without scoring twice. A new session ID starts a new sequence stream; a reconnect using the same session ID preserves the server's replay state.

Each scoring remote contributes one vote for its corner. A new vote replaces that corner's previous vote, `CANCEL` removes it, and disconnecting removes it. A point is awarded when at least three of the four corners select the same player and point value. Events received during a break, match end, or test mode are acknowledged as rejected or test presses and do not score.

### Configure remote tokens

For normal use, configure one token per remote before starting the server.

Windows Command Prompt:

```bat
set SFTS_REMOTE_TOKEN_C1=replace-with-c1-token
set SFTS_REMOTE_TOKEN_C2=replace-with-c2-token
set SFTS_REMOTE_TOKEN_C3=replace-with-c3-token
set SFTS_REMOTE_TOKEN_C4=replace-with-c4-token
npm start
```

For local development without tokens only, explicitly enable unpaired remotes.

Windows Command Prompt:

```bat
set SFTS_ALLOW_UNPAIRED_REMOTES=true
npm start
```

PowerShell:

```powershell
$env:SFTS_ALLOW_UNPAIRED_REMOTES = "true"
npm start
```

Do not enable unpaired remotes on a competition or shared network.

### Run the remote simulator

With the server running, simulate one remote event:

```bash
npm run simulate:remote -- C1 RED_2 1 ws://127.0.0.1:8080
```

The arguments are:

```text
<device-id> <button> <sequence> <websocket-url>
```

If token authentication is enabled, set the matching `SFTS_REMOTE_TOKEN_C1` environment variable before running the simulator. The simulator generates a session ID, performs the handshake, sends one event, prints the acknowledgements, and exits. Use `--duplicate` to resend the same sequence number, or `--then CANCEL` to send a follow-up cancellation in the same session. Because the backend removes votes from disconnected remotes, use `--hold` when combining multiple simulator instances into one majority vote:

```bash
npm run simulate:remote -- C1 RED_2 1 ws://127.0.0.1:8080 --hold
npm run simulate:remote -- C2 RED_2 1 ws://127.0.0.1:8080 --hold
npm run simulate:remote -- C3 RED_2 1 ws://127.0.0.1:8080 --hold
```

Run each command in its own terminal. After the third connected remote submits the same button, the point should be awarded. Press `Ctrl+C` in each simulator terminal when finished.

## Raspberry Pi direction

The application can be run on a Raspberry Pi as a Node.js server, and the backend remote protocol is ready for ESP32 integration. The current repository does not yet include an appliance setup, kiosk configuration, service file, or ESP32 firmware. The backend already provides acknowledgements, sequence numbers, duplicate-event protection, fixed corner pairing, and token authentication. Battery reporting, remote connection status in the dashboard, TLS, and automatic service recovery still need to be added for a production appliance.

The planned deployment is:

```text
ESP32 referee remotes → dedicated local Wi-Fi → Raspberry Pi → scoreboard display
```

Before using physical remotes in competition, validate Wi-Fi coverage, reconnect behavior, power/battery life, host failure handling, and the federation's scoring rules with the actual hardware and operators.

## Project structure

```text
src/server.js              Express and WebSocket backend
public/index.html          Application markup
public/js/app.js           Browser-side behavior and WebSocket client
public/css/style.css       Application styling
public/assets/             Static image assets
test/backend.test.js       Backend integration tests
package.json               Scripts and dependencies
```

## Limitations

- Match state and match history are memory-only and are lost when the server stops.
- Tournament player data and generated schedules are also memory-only and are lost when the server stops.
- The current role protocol is intended for a trusted local network; it is not an internet-facing authenticated service.
- The application is a manual referee-voting system and does not detect strikes through electronic protectors.
- Physical ESP32 remote firmware has not yet been added; the simulator is the only included remote client.
- The host dashboard does not yet show a live connected/offline indicator for each remote or battery level.
- It is not a replacement for certified World Taekwondo Protector and Scoring System equipment.
- Tournament rules and scoring behavior must be verified with the relevant federation before real competition use.
