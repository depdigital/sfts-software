import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import WebSocket from 'ws';
import * as XLSX from 'xlsx';
import { createPersistence } from '../src/persistence.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  const queued = ws.messages.findIndex(predicate);
  if (queued >= 0) return Promise.resolve(ws.messages.splice(queued, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    waiter.timer = setTimeout(() => {
      const index = ws.waiters.indexOf(waiter);
      if (index >= 0) ws.waiters.splice(index, 1);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    ws.waiters.push(waiter);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.waiters = [];
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      for (let index = 0; index < ws.waiters.length; index += 1) {
        const waiter = ws.waiters[index];
        if (!waiter.predicate(message)) continue;
        ws.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      ws.messages.push(message);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SFTS_DATA_DIR: dataDir,
      SFTS_BREAK_MS: '50',
      SFTS_ALLOW_UNPAIRED_REMOTES: 'true',
      SFTS_HOST_TOKEN: 'test-host-token',
      SFTS_KIOSK_MODE: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5000);
    const onData = chunk => {
      output += String(chunk);
      if (!output.includes('running on port')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup with code ${code}: ${output}`));
    });
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

function snapshot(label) {
  return {
    version: 1,
    savedAt: label,
    match: {
      matchNo: 1,
      round: 1,
      configuredRoundMs: 60000,
      timerMs: 60000,
      breakMs: 35000,
      running: false,
      phase: 'ROUND',
      red: { name: 'HONG', playerName: '', weightCategory: '', stateCode: '', district: '', score: 0, gamjeom: 0, stats: { plus1: 0, plus2: 0, plus3: 0 } },
      blue: { name: 'CHUNG', playerName: '', weightCategory: '', stateCode: '', district: '', score: 0, gamjeom: 0, stats: { plus1: 0, plus2: 0, plus3: 0 } },
      roundHistory: [],
      votes: {},
      matchWinner: null,
      matchReason: '',
      test: { active: false, presses: {} }
    },
    matchHistory: [],
    tournament: {
      players: [],
      groups: [],
      schedule: [],
      byes: [],
      activeBoutNo: null
    }
  };
}

test('local persistence writes a backup and restores it when the primary is corrupt', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-persistence-'));
  const warnings = [];
  const logger = { warn: message => warnings.push(message), error: () => {} };
  try {
    const persistence = createPersistence({ dataDir, logger });
    await persistence.flush(snapshot('first'));
    await persistence.flush(snapshot('second'));

    const primary = JSON.parse(await readFile(persistence.stateFile, 'utf8'));
    const backup = JSON.parse(await readFile(persistence.backupFile, 'utf8'));
    assert.equal(primary.savedAt, 'second');
    assert.equal(backup.savedAt, 'first');

    await writeFile(persistence.stateFile, '{not valid json', 'utf8');
    const restored = await persistence.load();
    assert.equal(restored.source, 'backup');
    assert.equal(restored.snapshot.savedAt, 'first');
    assert.ok(warnings.length >= 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('local persistence prevents two server instances sharing one data folder', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-persistence-lock-'));
  try {
    const first = createPersistence({ dataDir });
    const second = createPersistence({ dataDir });
    await first.acquire();
    await assert.rejects(second.acquire(), /another server process|could not acquire/);
    await first.release();
    await second.acquire();
    await second.release();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('server restores match history and tournament progress after restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-server-persistence-'));
  const port = 22000 + (process.pid % 1000);
  const url = `ws://127.0.0.1:${port}`;
  let serverProcess;
  let host;
  try {
    serverProcess = await startServer(port, dataDir);
    host = await connect(url);
    host.send(JSON.stringify({ type: 'role', role: 'host' }));
    const role = await waitForMessage(host, message => message.type === 'roleAccepted');
    await waitForMessage(host, message => message.type === 'state');

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      { Name: 'Persisted Red', Gender: 'MALE', 'Weight Category': '58 kg' },
      { Name: 'Persisted Blue', Gender: 'MALE', 'Weight Category': '58 kg' }
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Players');
    const imported = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'X-SFTS-Host-Token': role.hostToken
      },
      body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    });
    assert.equal(imported.status, 200);
    await imported.arrayBuffer();

    host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 1 }));
    await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === 1);
    host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 15 }));
    await waitForMessage(host, message => message.type === 'roundEnd' && message.record.winner === 'RED');
    await waitForMessage(host, message => message.type === 'state' && message.match.round === 2);
    host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 15 }));
    await waitForMessage(host, message => message.type === 'matchEnd' && message.winner === 'RED');
    await waitForMessage(host, message => message.type === 'state' && message.tournament.schedule[0].status === 'COMPLETED');
    await new Promise(resolve => setTimeout(resolve, 400));
    host.close();
    await stopServer(serverProcess);
    serverProcess = null;

    serverProcess = await startServer(port, dataDir);
    const restoredHost = await connect(url);
    restoredHost.send(JSON.stringify({ type: 'role', role: 'host' }));
    await waitForMessage(restoredHost, message => message.type === 'roleAccepted');
    const restored = await waitForMessage(restoredHost, message => message.type === 'state');
    assert.equal(restored.matchHistory.length, 1);
    assert.equal(restored.matchHistory[0].winner, 'RED');
    assert.equal(restored.tournament.players.length, 2);
    assert.equal(restored.tournament.schedule[0].status, 'COMPLETED');
    assert.equal(restored.match.phase, 'MATCH_END');
    assert.equal(restored.match.running, false);
    restoredHost.close();
  } finally {
    if (host && host.readyState !== WebSocket.CLOSED) host.close();
    await stopServer(serverProcess);
    await rm(dataDir, { recursive: true, force: true });
  }
});
