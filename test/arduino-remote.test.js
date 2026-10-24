import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(projectRoot, 'data', `arduino-compat-test-${process.pid}`);
const port = 24000 + (process.pid % 1000);
const url = `ws://127.0.0.1:${port}/`;
const hostToken = 'arduino-test-host-token';
const remoteToken = 'arduino-test-c1-token';
const clients = new Set();
let child;

function connect({ protocol, origin } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocol ? [protocol] : [], {
      headers: origin === undefined ? {} : { Origin: origin }
    });
    clients.add(socket);
    socket.messages = [];
    socket.on('message', raw => socket.messages.push(JSON.parse(String(raw))));
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function message(socket, predicate, timeoutMs = 3000) {
  const index = socket.messages.findIndex(predicate);
  if (index >= 0) return Promise.resolve(socket.messages.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const listener = raw => {
      const value = JSON.parse(String(raw));
      if (!predicate(value)) return;
      cleanup();
      const queued = socket.messages.findIndex(item => item === value || predicate(item));
      if (queued >= 0) socket.messages.splice(queued, 1);
      resolve(value);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Arduino protocol reply timed out')); }, timeoutMs);
    function cleanup() { clearTimeout(timer); socket.off('message', listener); }
    socket.on('message', listener);
  });
}

const send = (socket, value) => socket.send(JSON.stringify(value));

before(async () => {
  await mkdir(dataDir, { recursive: true });
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env, PORT: String(port), SFTS_DATA_DIR: dataDir,
      SFTS_RULES_FILE: path.join(projectRoot, 'config', 'rules.default.json'),
      SFTS_HOST_TOKEN: hostToken, SFTS_REMOTE_TOKEN_C1: remoteToken,
      SFTS_ALLOW_UNPAIRED_REMOTES: 'false', SFTS_KIOSK_MODE: 'true',
      SFTS_USB_IMPORT_ONLY: 'false', SFTS_TTS_ENGINE: 'browser'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Test server did not start: ${output}`)), 5000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('running on port')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited: ${code}: ${output}`)); });
  });
});

after(async () => {
  for (const socket of clients) socket.terminate();
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  await rm(dataDir, { recursive: true, force: true });
});

test('C1 firmware handshake authenticates, reports status and delivers an acknowledged button press', async () => {
  // Links2004 2.7.2 defaults, as used by webSocket.begin(host, port, "/").
  const remote = await connect({ protocol: 'arduino', origin: 'file://' });
  assert.equal(remote.protocol, 'arduino');
  send(remote, { type: 'role', role: 'host', accessToken: hostToken });
  assert.equal((await message(remote, msg => msg.type === 'error')).code, 'REMOTE_ONLY_CONNECTION');
  send(remote, { type: 'remote_hello', protocolVersion: 2, deviceId: 'C1', sessionId: 'firmware-compat', token: 'wrong-token' });
  assert.equal((await message(remote, msg => msg.type === 'error')).code, 'UNAUTHORIZED_REMOTE');
  send(remote, { type: 'remote_hello', protocolVersion: 2, deviceId: 'C1', sessionId: 'firmware-compat', token: remoteToken, firmware: 'sfts-esp32-c6-mini-1-r2' });
  assert.equal((await message(remote, msg => msg.type === 'remote_ready')).deviceId, 'C1');
  send(remote, { type: 'remote_status', deviceId: 'C1', sessionId: 'firmware-compat', rssi: -55, battery: 80, outboxDepth: 0, droppedInputs: 0, droppedEvents: 0, retryCount: 0, reconnectCount: 1, lastAckSequence: 0 });
  assert.equal((await message(remote, msg => msg.type === 'remote_status_ack')).accepted, true);

  const host = await connect({ origin: `http://127.0.0.1:${port}` });
  send(host, { type: 'role', role: 'host' });
  await message(host, msg => msg.type === 'roleAccepted');
  const state = await message(host, msg => msg.type === 'state');
  assert.equal(state.remotes.find(item => item.deviceId === 'C1').connected, true);
  send(host, { type: 'host', action: 'testStart' });
  await message(host, msg => msg.type === 'state' && msg.match.test.active);
  send(remote, { type: 'remote_event', deviceId: 'C1', sessionId: 'firmware-compat', sequence: 1, button: 'RED_1', ageMs: 0 });
  const ack = await message(remote, msg => msg.type === 'remote_event_ack' && msg.sequence === 1);
  assert.equal(ack.accepted, true);
  assert.equal((await message(host, msg => msg.type === 'testPress')).corner, 1);
});

test('Arduino compatibility does not admit arbitrary file or foreign browser origins', async () => {
  await assert.rejects(connect({ origin: 'file://' }), /403/);
  await assert.rejects(connect({ protocol: 'arduino', origin: 'null' }), /403/);
  await assert.rejects(connect({ protocol: 'arduino', origin: 'https://attacker.invalid' }), /403/);
});
