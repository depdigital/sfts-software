# SFTS Remote Reliability Fix Context

## Status

- Investigation completed: 2026-09-04.
- No source or firmware changes have been implemented.
- Physical remote hardware is currently unavailable.
- Backend test suite currently passes all 11 tests.
- Hardware behavior still needs to be reproduced and validated later.

## Reported arena symptom

The remote initially connects and appears as `CONNECTED` in Remote Settings. After some time, button presses stop registering even though the connection indicator remains connected. Button test presses may eventually begin working after repeated attempts. Disconnect status can remain stale. Rebooting restores normal behavior.

## Confirmed primary protocol fault

The firmware creates its session ID from the device MAC address:

- `firware/firware.ino:289` calls `makeSessionId()`.
- `makeSessionId()` returns a MAC-derived ID.
- `nextSequence` starts at zero at every firmware boot: `firware/firware.ino:88`.

The server deliberately reuses a previous session when the device ID and session ID match:

- `src/server.js:2271-2274` reuses the previous session.
- The session retains `lastSequence` and its acknowledgement cache.
- `src/server.js:2321-2324` rejects any event with a sequence less than or equal to the stored sequence as `SEQUENCE_REPLAY`.

### Failure sequence

1. The remote sends events through sequence 40.
2. The remote reboots or otherwise resets its firmware state.
3. It reconnects with the same MAC-derived session ID.
4. The server reuses the old session with `lastSequence = 40`.
5. The remote sends sequence 1 again.
6. The server rejects sequences 1 through 40.
7. The handshake still succeeds, so the remote appears connected.
8. Test-mode handling is never reached because replay rejection occurs first.
9. Pressing enough times can eventually reach sequence 41, making the remote appear to recover.
10. Restarting the server clears the in-memory session map, which explains why a server/system reboot restores operation.

This is the strongest explanation for the reported behavior.

The README already specifies that each remote needs a unique session ID for each boot/session (`README.md:124`), but the current firmware does not satisfy that requirement.

## Secondary confirmed reliability weaknesses

### Stale connection state

The server sets `remoteStatuses.connected = true` whenever a hello or telemetry message is accepted (`src/server.js:1569-1576`). It sets the value to false mainly during WebSocket cleanup (`src/server.js:1800-1813`).

`lastSeenAt` is recorded but is not used as an application-level liveness timeout. The dashboard renders only the boolean `connected` field (`public/js/app.js:1133-1145`). Therefore a transport that remains open while the application event path is unhealthy can still display `CONNECTED`.

The server WebSocket heartbeat helps detect dead transports, but it does not prove that the firmware can still scan buttons, queue events, send events, or process acknowledgements.

### Firmware can remain transport-connected but input-disabled

After an error message, the firmware sets `remoteAccepted = false` (`firware/firware.ino:225-235`). If the remote had already been accepted, it does not force a reconnect. Subsequent button presses are ignored by the guard at `firware/firware.ino:166-170`, while the server may still consider the WebSocket connected.

### Input events are not queued

The interrupt handler stores only a bit per button (`firware/firware.ino:100-105`). Multiple transitions before the main loop samples the pin can be coalesced. A fast press/release can therefore be missed.

Button event transmission is also performed from the main loop. A failed `sendTXT()` increments the sequence and drops the event instead of retaining it for retry (`firware/firware.ino:173-188`).

### Dynamic allocation risk

The firmware repeatedly builds incoming and outgoing messages with Arduino `String` objects. Long-running repeated allocations can fragment the ESP32 heap and cause later message construction or transmission failures. This is a secondary hypothesis and must be checked with serial diagnostics and a long soak test.

## Required future fixes

### 1. Boot-unique session identity

Generate a new session ID for every firmware boot using ESP32 hardware randomness or a persistent boot counter plus randomness.

Rules:

- Same session ID during ordinary network reconnects within one boot.
- New session ID after a firmware reset or power cycle.
- Sequence starts at 1 for a new session.
- Server may retain sessions only for a bounded expiry period.

Do not remove replay protection or reset the server sequence on every handshake. That could allow duplicate scoring.

### 2. Reliable fixed-size event outbox

Button detection must enqueue an event before network transmission. Each event should contain:

- Session ID.
- Sequence number.
- Button identifier.
- Send timestamp.
- Retry count.

The firmware should retransmit until it receives the matching acknowledgement. It should remove an event only after acknowledgement. `sendTXT()` failure must leave the event queued.

The server must continue to return deterministic idempotent acknowledgements for duplicate events. The acknowledgement retention window must be at least as large as the firmware outbox, or the protocol must provide an equivalent way to confirm already-processed events.

### 3. Decouple button scanning from networking

Use a fixed-size queue or per-button event counters. Button scanning/debouncing must not depend on the timing of WebSocket transmission.

Possible implementation choices:

- A dedicated FreeRTOS button task feeding a queue.
- Deterministic high-frequency polling with a button state machine feeding the outbox.

No network send should occur inside an ISR.

### 4. Use bounded memory on the firmware

Replace repeated dynamic message construction with fixed-size buffers and bounded parsing. Avoid heap allocation in the button/input path. Add periodic diagnostics for free heap, largest free block, queue depth, failed sends, and reconnect count.

### 5. Enforce a connection state machine

Recommended states:

`DISCONNECTED -> TRANSPORT_CONNECTED -> AUTHENTICATING -> READY -> DEGRADED -> DISCONNECTED`

Rules:

- `READY` requires a successful `remote_ready` response.
- Any application error after `READY` transitions to `DEGRADED` and forces a clean reconnect.
- A reconnect must re-authenticate before button events are sent.
- Transport connection alone must not mean input-ready.

### 6. Add application-level liveness

The firmware should send a periodic heartbeat/telemetry message and verify the server response. The server should mark the remote stale/disconnected when the last valid application message exceeds a defined threshold, for example three heartbeat intervals.

The UI should expose the last heartbeat time and, where useful, the last event acknowledgement time and failure reason.

### 7. Improve observability

Log or expose:

- Current session ID.
- Last sequence sent.
- Last sequence acknowledged.
- Last acknowledgement reason.
- Outbox depth.
- Retry count.
- Last heartbeat time.
- Last transport reconnect time.
- Heap diagnostics.

The first serial evidence to check during reproduction is repeated `SEQUENCE_REPLAY` acknowledgements.

## Validation plan when hardware is available

1. Start the server and connect one remote.
2. Send enough presses to establish a nonzero sequence.
3. Reboot only the remote while leaving the server running.
4. Confirm it receives a new session ID and can immediately operate.
5. Disconnect/reconnect Wi-Fi without rebooting the firmware.
6. Confirm the same session remains valid and queued events are delivered exactly once.
7. Unplug the remote and verify the dashboard becomes disconnected after the liveness timeout.
8. Inject or simulate lost acknowledgements and confirm retransmission without duplicate scoring.
9. Hold and rapidly tap every button repeatedly.
10. Run an 8-24 hour soak test while monitoring heap, reconnects, queue depth, and acknowledgements.
11. Repeat in remote test mode and during an active match.

## Testing gaps to address

Current automated tests pass but do not cover the important failure case:

- Reconnect the same device with the same session ID after sequence advancement while the server remains running.
- Reboot/reset the remote and verify a new session.
- Lost acknowledgement and retransmission.
- Application error after successful authentication.
- Button burst/short-press behavior.
- Long-running memory stability.

The simulator currently generates a fresh random session ID for each process (`tools/remote-simulator.js:22`), so it does not reproduce the hardware reboot/session-reset defect.

## Reliability boundary

Software can provide reliable delivery, duplicate protection, reconnection, queueing, and clear fault reporting. It cannot guarantee a button press during a physical switch failure, total power loss, damaged wiring, failed ESP32, or permanently unavailable network. Those cases must be surfaced as an explicit disconnected/degraded state rather than silently presented as connected.

