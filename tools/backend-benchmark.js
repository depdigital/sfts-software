// Isolated, repeatable Pi 3 check. Never connects to the event server or reads
// its saved state. Run outside a bout so the benchmark does not compete for CPU.
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';

if (process.argv.includes('--server')) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  process.on('message', message => {
    if (message === 'shutdown') process.emit('SIGTERM');
    if (message === 'metrics') process.send({
      memory: process.memoryUsage(), cpu: process.cpuUsage(),
      loopP99Ms: histogram.percentile(99) / 1e6, loopMaxMs: histogram.max / 1e6
    });
  });
  await import('../src/server.js');
} else {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-benchmark-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = crypto.randomBytes(24).toString('hex');
  const env = {
    ...process.env, PORT: String(port), SFTS_DATA_DIR: dataDir,
    SFTS_RULES_FILE: path.join(project, 'config', 'rules.default.json'),
    SFTS_HOST_TOKEN: token, SFTS_KIOSK_MODE: 'false', SFTS_ALLOW_UNPAIRED_REMOTES: 'false',
    SFTS_TTS_ENGINE: 'browser', SFTS_USB_IMPORT_ONLY: 'false'
  };
  for (let i = 1; i <= 4; i += 1) env[`SFTS_REMOTE_TOKEN_C${i}`] = token;
  const child = fork(fileURLToPath(import.meta.url), ['--server'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const sockets = [];
  const samples = [];
  const latencies = [];
  const pending = new Map();
  let interval;
  let probe;
  let stderr = '';
  let bytesReceived = 0;
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.on('message', sample => samples.push(sample));

  async function connect(message, acceptedType) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(socket);
    await once(socket, 'open');
    socket.on('message', raw => {
      bytesReceived += raw.length;
      const result = JSON.parse(String(raw));
      const key = `${result.deviceId}:${result.sequence}`;
      if (result.type === 'remote_event_ack' && pending.has(key)) {
        latencies.push(performance.now() - pending.get(key));
        pending.delete(key);
      }
    });
    const accepted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Benchmark authentication timed out')), 5000);
      socket.on('message', raw => {
        const result = JSON.parse(String(raw));
        if (result.type === acceptedType) { clearTimeout(timer); resolve(result); }
        if (result.type === 'error') { clearTimeout(timer); reject(new Error(result.code)); }
      });
    });
    socket.send(JSON.stringify(message));
    return { socket, accepted: await accepted };
  }

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Benchmark server did not start: ${stderr}`)), 10_000);
      child.stdout.on('data', chunk => {
        if (String(chunk).includes('running on port')) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Benchmark server exited: ${code} ${stderr}`)); });
    });
    probe = setInterval(() => { if (child.connected) child.send('metrics'); }, 250);
    await delay(750);
    const idleRss = samples.at(-1)?.memory.rss || 0;
    const compact = !process.argv.includes('--legacy-state');
    const { socket: host, accepted } = await connect({ type: 'role', role: 'host', accessToken: token, supportsStatePatch: compact }, 'roleAccepted');
    const headers = { 'X-SFTS-Host-Token': accepted.hostToken };
    const rows = ['Name,Gender,Division,Weight Category'];
    for (let i = 0; i < 500; i += 1) rows.push(`Player ${i},MALE,SENIOR,FLYWEIGHT`);
    const imported = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/csv' }, body: rows.join('\n') });
    if (!imported.ok) throw new Error(`Benchmark import failed: ${await imported.text()}`);
    await imported.arrayBuffer();
    host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
    const remotes = [];
    for (let i = 1; i <= 4; i += 1) {
      const deviceId = `C${i}`;
      const sessionId = `bench-${deviceId}`;
      const { socket } = await connect({ type: 'remote_hello', deviceId, sessionId, protocolVersion: 2, token }, 'remote_ready');
      remotes.push({ socket, deviceId, sessionId, sequence: 0 });
    }
    let tick = 0;
    const started = performance.now();
    interval = setInterval(() => {
      tick += 1;
      for (const remote of remotes) {
        remote.sequence += 1;
        pending.set(`${remote.deviceId}:${remote.sequence}`, performance.now());
        remote.socket.send(JSON.stringify({ type: 'remote_event', deviceId: remote.deviceId, sessionId: remote.sessionId, sequence: remote.sequence, ageMs: 0, button: tick % 2 ? 'RED_1' : 'BLUE_1' }));
      }
    }, 100);
    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/api/tournament/schedule.xlsx`, { headers });
      if (!response.ok) throw new Error(`Benchmark export failed (${response.status})`);
      await response.arrayBuffer();
      await delay(700);
    }
    await delay(Math.max(0, 5000 - (performance.now() - started)));
    clearInterval(interval);
    await delay(250);
    const loadRss = Math.max(...samples.map(item => item.memory.rss));
    host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
    console.log('Load phase complete; waiting 16 seconds for the file worker to release memory...');
    await delay(16_000);
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))] || 0;
    const first = samples[0];
    const last = samples.at(-1);
    console.log(JSON.stringify({
      hardware: { platform: process.platform, arch: process.arch, totalRamMiB: Math.round(os.totalmem() / 1048576), node: process.version },
      workload: '500 players, four authenticated remotes at 40 total events/sec, concurrent XLSX exports',
      stateFormat: compact ? 'compact' : 'legacy full',
      ackCount: latencies.length, unacknowledged: pending.size, ackP99Ms: +p99.toFixed(2),
      eventLoopP99Ms: +last.loopP99Ms.toFixed(2), eventLoopMaxMs: +last.loopMaxMs.toFixed(2),
      idleRssMiB: +(idleRss / 1048576).toFixed(1), peakRssMiB: +(loadRss / 1048576).toFixed(1),
      afterWorkerIdleRssMiB: +(last.memory.rss / 1048576).toFixed(1),
      cpuMs: +((last.cpu.user + last.cpu.system - first.cpu.user - first.cpu.system) / 1000).toFixed(1),
      receivedMiB: +(bytesReceived / 1048576).toFixed(2)
    }, null, 2));
    if (pending.size) process.exitCode = 1;
  } finally {
    clearInterval(interval);
    clearInterval(probe);
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.send('shutdown');
      const force = setTimeout(() => child.kill('SIGKILL'), 12_000);
      await exited;
      clearTimeout(force);
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}
