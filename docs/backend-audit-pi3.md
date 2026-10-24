# Backend hardening and Raspberry Pi 3 review

Review date: 2026-10-24. Target: Raspberry Pi 3, 1 GB RAM, one local scoreboard browser, four ESP32 remotes, closed event LAN. Changes are in the checkout; they have not been deployed to a Pi by this review.

## Assessment

The code-level assessment is provisionally **8.5/10 for the stated closed-LAN deployment**. This is an engineering judgment, not a penetration-test certificate or a claim that the entire Raspberry Pi appliance has achieved that score. A 9/10 appliance rating needs the actual Pi's OS/account permissions, browser policies, maintained Node/Chromium versions, SD-card/power behavior, and a hardware soak test verified as well.

The assessment considers authentication/origin isolation, input and file validation, bounded resource use, recovery and persistence, dependency exposure, and regression evidence. The prior implementation had useful scoring safeguards, but known dependency advisories, unbounded work queues, no connection admission limit, and synchronous file parsing prevented a defensible 8.5 rating.

## Findings and implemented controls

| Finding | Implemented control | Pi 3 impact |
| --- | --- | --- |
| Known dependency advisories | Express 4.22.3, ws 8.22.0, patched transitive packages, official SheetJS 0.20.3 with lockfile integrity | No new framework; removes obsolete SheetJS helper dependencies |
| Foreign browser origins and DNS rebinding | Check actual Host/port and exact browser Origin on HTTP and WebSocket upgrades; native clients without Origin still require their tokens | Small constant checks; no DNS requests |
| Connection and request exhaustion | 32 WebSockets, 24 external slots, eight external connections per source IP, local host reservation, 64 TCP sockets, 10-second authentication deadline, bounded token buckets, message and byte limits | Fixed caps instead of growing maps/queues |
| Malformed fields could throw out of a WebSocket handler | Catch invalid field coercions, validate message type, reject unknown host actions, use safe integers for scores | Keeps malformed requests from taking down scoring |
| Blocking spreadsheet/PDF processing | One on-demand worker; 128 MB old-generation heap, 16 MB young-generation heap, 30-second job deadline, no job backlog, exits after 15 seconds idle | File libraries are not loaded into the scoring thread and are released when idle |
| Compressed-file memory expansion | 4 MB upload limit, 32 MB total expanded ZIP limit, 16 MB per ZIP entry, bounded actual inflation, directory/range/size checks, first worksheet only, 502-row and 128-column parsing bounds | Rejects oversized work before parsing; normal 500-player limit retained |
| USB file replacement/growth races | Descriptor-based bounded reads with no-follow flags where supported; temporary exclusive files, sync and rename for template writes | Protects imports and avoids incomplete exported templates |
| Concurrent rules/import changes | Recheck match/session/rules after asynchronous import work; block host actions during the rules commit | Prevents file operations from replacing an active scoring configuration |
| Repeated large tournament broadcasts | Dashboard opts into compact state patches; initial snapshots and structural changes still carry complete data; old clients retain the full protocol | Less JSON parsing, networking and repeated tournament/category DOM work |
| Redundant telemetry broadcasts | Update liveness internally but broadcast telemetry only when displayed fields change | Fewer complete UI updates for unchanged status |
| State/archive write backlog | At most one active write and one latest cumulative pending snapshot; compact JSON; preserve sync/backup/atomic replacement | Less SD-card traffic and less memory held by pending saves |
| Storage errors were only logged | Failed explicit flush rejects; persistent dashboard warning and status broadcast; warning clears on successful recovery | Prevents silent assumptions that data was saved |
| Unbounded speech memory/work | 2 MB maximum WAV, bounded response streaming, 8 MB total memory cache, four pending announcements; validate RIFF/WAVE | Caps Node's speech cache and backlog without SD audio writes |
| CSV formula injection | Prefix formula-like text with an apostrophe in CSV exports; normal XLSX cells stay strings | Negligible cost; protects exported schedules opened in spreadsheet apps |
| Repeated service failure could exhaust restart budget | Restart always with five-second delay, no start-rate lockout, dropped capabilities, kernel-log/realtime restrictions, bounded shutdown | Automatic recovery remains available; manual systemctl stop still stops it |
| Updates could miss transitive lockfile changes | Hash production lockfile, verify installed dependencies, refresh service template during restart | Maintenance-only work; dependency installation skipped when unchanged |

Worker heap limits do **not** cap the entire Node process or Chromium/Piper RAM. Explicit file/audio limits complement them. No small process-wide RAM cap was imposed that could kill a healthy live match.

## Verification evidence

- **All 43 automated tests pass**, covering scoring, timer/phase guards, majority/replay behavior, rule packs and ties, tournament formats, manual results, templates/exports, restart persistence, request boundaries, malformed coercions, compact state caching, file-worker formats/limits, speech limits, and storage failure/recovery.
- Dependency audit after updates: **zero known npm vulnerabilities**. This is a dated advisory check, not proof that dependencies have no undiscovered flaws.
- JavaScript syntax and Git whitespace validation pass. Installer/restart scripts pass Bash syntax validation with the Windows checkout's CRLF endings normalized in memory.
- A connected browser was unavailable, so visual/browser integration and actual Raspberry Pi testing remain unverified. Automated tests cover the cache merge and negotiated wire protocol.

### Isolated workload measurement

Measured on Windows x64, Node 24.15.0, 32 GB workstation, **not on a Pi 3**. The test starts a separate server with temporary state and generated test credentials, imports 500 players, runs four authenticated remotes at a nominal 40 total events/second, and exports XLSX schedules concurrently.

| Metric | Full state client | Compact dashboard client |
| --- | ---: | ---: |
| Acknowledged events | 184 | 188 |
| Unacknowledged events | 0 | 0 |
| p99 acknowledgement | 8.22 ms | 2.38 ms |
| WebSocket data received | 51.72 MiB | 5.24 MiB |
| Idle backend RSS | 64.1 MiB | 63.7 MiB |
| Peak backend RSS | 127.0 MiB | 132.1 MiB |
| RSS after worker idle | 68.5 MiB | 68.7 MiB |

The runs are indicative rather than a controlled hardware comparison; scheduling and other workstation activity vary. The main reproducible improvement is approximately **90% less WebSocket traffic** at this tournament size. RSS includes the Node worker but excludes Chromium and Piper. The benchmark's event-loop histogram uses a 10 ms sampling resolution and is diagnostic rather than a real-time scheduling guarantee.

## Apply and verify on the Pi

After transferring this checkout to the Pi, run from the project directory when no bout is active:

```bash
sudo bash deployment/scripts/restart-stack.sh
```

The first run downloads the changed dependencies, including the official SheetJS CDN tarball. Internet is needed for that maintenance step unless the packages are already cached; event scoring remains offline. The lockfile records the tarball integrity. The script refreshes the systemd service, Labwc configuration and Chromium policies, then relaunches the graphical kiosk. This pauses a match if one was active. The local automatic kiosk authorization uses `http://127.0.0.1:8080`, not a different browser hostname.

Run the isolated hardware check outside a bout, with the ordinary kiosk and Piper still running:

```bash
npm run benchmark:backend
free -m
vcgencmd get_throttled
```

The benchmark uses an unused port and temporary state, never the event server's saved data. It takes roughly 25 seconds. To compare the legacy full-state protocol, use `npm run benchmark:backend -- --legacy-state` in a separate run.

Suggested acceptance criteria for the Pi 3 are zero unacknowledged benchmark inputs, no OOM/restarts, no sustained swapping, stable timer/display behavior, and responsive operator controls during file exports and announcements. A p99 acknowledgement target below 50 ms is a useful local acceptance target, not a measured Pi result. Follow with a long event rehearsal including USB removal, server/browser recovery, Piper announcements, and the largest real category report.

## Remaining limits

- HTTP/WebSocket LAN transport is unencrypted. Remote credentials are visible to a party who can capture that LAN traffic. Public internet or shared untrusted Wi-Fi deployment needs a different security design.
- Kiosk loopback/Origin authorization assumes the OS account and local machine remain trusted. A local native process can forge Origin; this is not protection against an OS account compromise.
- The browser and service still use the existing account layout. Account separation and a restricted maintenance/SSH path need a device-level migration and validation.
- The official manual-result archive remains cumulative and is loaded into RAM. No official evidence is silently deleted or truncated. Very large multi-event archives need an explicit retention/export policy or indexed storage before claiming bounded total historical memory use.
- Abrupt power loss, SD-card failure, thermal throttling and whole-system hangs cannot be eliminated by backend changes. Atomic writes/backups reduce exposure but cannot guarantee all recent inputs survive a physical storage failure.
- A higher score needs actual device measurements and a maintained OS/browser/Node runtime confirmed, plus the remaining appliance controls above.

Upstream references: [SheetJS installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), [prototype-pollution advisory](https://cdn.sheetjs.com/advisories/CVE-2023-30533), [ReDoS advisory](https://cdn.sheetjs.com/advisories/CVE-2024-22363), [Node worker documentation](https://nodejs.org/api/worker_threads.html).
