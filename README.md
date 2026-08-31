# SFTS Taekwondo Scoring System

SFTS is a LAN-based taekwondo match scoring application. One host runs the scoring server and scoreboard, while referee clients connect over the same local network and submit votes in real time.

This repository contains the browser-based referee client plus the backend protocol and simulator for ESP32-based physical remotes. Raspberry Pi appliance deployment and the actual ESP32 firmware are not yet implemented.

## Current features

- Host scoreboard for red and blue competitors.
- Up to four referee corners, C1–C4.
- One connected host and one connected referee client per corner.
- 3-of-4 majority voting for +1, +2, and +3 points.
- Host controls for points, gam-jeom, score editing, names, and timer control.
- Best-of-three match flow.
- 60-second default rounds and 35-second breaks.
- Automatic round ending after timer expiry, a 15-point gap, or five gam-jeom.
- Round summaries with score, gam-jeom, and point-type statistics.
- Match winner screen and match numbering.
- QR-code connection screen for referee devices.
- Host-only controller test mode.
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
- Timestamp-based timer tracking to reduce timer drift.
- Protection against scoring outside an active round.
- Authenticated ESP32 remote handshakes with fixed corner assignment.
- Compact remote-specific state messages that avoid sending match history to small devices.
- Remote event acknowledgements and replay protection.
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

The tests verify the HTTP server, QR-code endpoint, WebSocket roles, referee voting, vote cleanup, timer expiry, phase restrictions, and malformed input handling.

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

### 5. Connect referee devices

Connect referee phones or other browser devices to the same Wi-Fi network as the host. Open the Wi-Fi URL printed by the server, for example:

```text
http://192.168.0.101:8080
```

Select **CORNER REFEREE**, choose C1–C4, and press **CONNECT**. The host’s **QR CODE CONNECT** setting can also be used to display the connection URL.

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

Each remote must identify itself with a fixed device ID (`C1`, `C2`, `C3`, or `C4`), a session ID, and a token. The device ID determines the referee corner; it cannot be selected by the client after connection.

The connection flow is:

```text
remote_hello → remote_ready → remote_event → remote_event_ack
```

An event uses a monotonically increasing sequence number and a button name such as `RED_1`, `RED_2`, `RED_3`, `BLUE_1`, `BLUE_2`, `BLUE_3`, or `CANCEL`. Re-sending the same sequence number returns the original acknowledgement without scoring twice.

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

The application can be run on a Raspberry Pi as a Node.js server, and the backend remote protocol is ready for integration. The current repository does not yet include an appliance setup, kiosk configuration, service file, or ESP32 firmware.

The planned deployment is:

```text
ESP32 referee remotes → dedicated local Wi-Fi → Raspberry Pi → scoreboard display
```

Before using physical remotes in competition, the communication protocol should add acknowledgements, sequence numbers, duplicate-event protection, pairing, battery reporting, and a clear offline/failure indication.

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
- The current role protocol is intended for a trusted local network; it is not an internet-facing authenticated service.
- The application is a manual referee-voting system and does not detect strikes through electronic protectors.
- Physical ESP32 remote firmware has not yet been added.
- It is not a replacement for certified World Taekwondo Protector and Scoring System equipment.
- Tournament rules and scoring behavior must be verified with the relevant federation before real competition use.
