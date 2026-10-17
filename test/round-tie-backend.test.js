import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDataDir = path.join(projectRoot, 'data', `round-tie-test-${process.pid}`);
const port = 23000 + (process.pid % 1000);
const url = `ws://127.0.0.1:${port}`;

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

async function connect() {
  const ws = new WebSocket(url);
  ws.messages = [];
  ws.waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(String(raw));
    const index = ws.waiters.findIndex(waiter => waiter.predicate(message));
    if (index < 0) {
      ws.messages.push(message);
      return;
    }
    const [waiter] = ws.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function hostAction(ws, action, fields = {}) {
  ws.send(JSON.stringify({ type: 'host', action, ...fields }));
}

async function startRound(host, round) {
  hostAction(host, 'playPause');
  return waitForMessage(host, message => (
    message.type === 'state' && message.match.phase === 'ROUND' &&
    message.match.round === round && message.match.running
  ));
}

async function setTiedRound(host, score, redStats, blueStats) {
  hostAction(host, 'editScore', { player: 'RED', value: score });
  hostAction(host, 'editScore', { player: 'BLUE', value: score });
  hostAction(host, 'editRoundTieStats', { player: 'RED', stats: redStats });
  hostAction(host, 'editRoundTieStats', { player: 'BLUE', stats: blueStats });
  await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === score && message.match.blue.score === score &&
    message.match.red.stats.technicalHead === redStats.technicalHead &&
    message.match.red.stats.technicalChest === redStats.technicalChest &&
    message.match.red.stats.plus3 === redStats.normalHead &&
    message.match.blue.stats.technicalHead === blueStats.technicalHead &&
    message.match.blue.stats.technicalChest === blueStats.technicalChest &&
    message.match.blue.stats.plus3 === blueStats.normalHead
  ));
}

test('round superiority, round Woo-se-girok, final tie choices, and expiry locking work end to end', async t => {
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SFTS_DATA_DIR: testDataDir,
      SFTS_BREAK_MS: '50',
      SFTS_HOST_TOKEN: 'round-tie-host-token',
      SFTS_USB_IMPORT_ONLY: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let host;
  t.after(async () => {
    host?.close();
    if (server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    await rm(testDataDir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5000);
    server.stdout.on('data', chunk => {
      output += String(chunk);
      if (!output.includes('running on port')) return;
      clearTimeout(timer);
      resolve();
    });
    server.stderr.on('data', chunk => { output += String(chunk); });
    server.once('exit', code => reject(new Error(`Server exited with ${code}: ${output}`)));
  });

  host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'round-tie-host-token' }));
  await waitForMessage(host, message => message.type === 'roleAccepted');
  const initial = await waitForMessage(host, message => message.type === 'state');
  assert.equal(initial.scoringRules.roundTie.type, 'SUPERIORITY');
  hostAction(host, 'setTime', { ms: 1500 });
  await waitForMessage(host, message => message.type === 'state' && message.match.timerMs === 1500);

  // An entirely equal first round requires Woo-se-girok for that round only.
  await startRound(host, 1);
  await setTiedRound(
    host,
    1,
    { technicalHead: 0, technicalChest: 0, normalHead: 0 },
    { technicalHead: 0, technicalChest: 0, normalHead: 0 }
  );
  const roundWoo = await waitForMessage(host, message => (
    message.type === 'state' && message.match.phase === 'TIE_DECISION' &&
    message.match.tieDecision?.mode === 'ROUND_WOO_SE_GIROK'
  ));
  assert.deepEqual(roundWoo.match.tieDecision.options, ['WOO_SE_GIROK']);
  hostAction(host, 'editRoundTieStats', {
    player: 'RED',
    stats: { technicalHead: 1, technicalChest: 0, normalHead: 0 }
  });
  assert.equal((await waitForMessage(host, message => message.type === 'error')).code, 'ROUND_NOT_ACTIVE');
  hostAction(host, 'decideWooSeGirok', { player: 'RED' });
  const wooRoundRecord = await waitForMessage(host, message => message.type === 'roundEnd');
  assert.equal(wooRoundRecord.record.winner, 'RED');
  assert.equal(wooRoundRecord.record.reason, 'SUP - WOO-SE-GIROK');
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 2);

  // Reset and exercise the two approved automatic examples through a full match.
  hostAction(host, 'resetMatch');
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 1);

  await startRound(host, 1);
  await setTiedRound(
    host,
    6,
    { technicalHead: 1, technicalChest: 0, normalHead: 0 },
    { technicalHead: 0, technicalChest: 1, normalHead: 0 }
  );
  const firstRecord = await waitForMessage(host, message => message.type === 'roundEnd' && message.record.round === 1);
  assert.equal(firstRecord.record.winner, 'RED');
  assert.equal(firstRecord.record.reason, 'SUP - TECHNICAL HEAD');
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 2);

  await startRound(host, 2);
  await setTiedRound(
    host,
    12,
    { technicalHead: 0, technicalChest: 0, normalHead: 4 },
    { technicalHead: 2, technicalChest: 0, normalHead: 0 }
  );
  const secondRecord = await waitForMessage(host, message => message.type === 'roundEnd' && message.record.round === 2);
  assert.equal(secondRecord.record.winner, 'BLUE');
  assert.equal(secondRecord.record.reason, 'SUP - TECHNICAL HEAD');
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 3);

  await startRound(host, 3);
  const finalRound = await waitForMessage(host, message => (
    message.type === 'roundEnd' && message.record.round === 3
  ));
  assert.equal(finalRound.record.winner, null);
  assert.equal(finalRound.record.reason, 'TIME 0:00');
  const finalTieChoices = await waitForMessage(host, message => (
    message.type === 'state' && message.match.phase === 'TIE_DECISION' &&
    message.match.tieDecision?.mode === 'CHOOSE_METHOD'
  ));
  assert.deepEqual(finalTieChoices.match.tieDecision.options, ['GOLDEN_ROUND', 'WOO_SE_GIROK']);
  hostAction(host, 'decideWooSeGirok', { player: 'BLUE' });
  const matchEnd = await waitForMessage(host, message => message.type === 'matchEnd');
  assert.equal(matchEnd.winner, 'BLUE');
  assert.equal(matchEnd.reason, 'SUP - WOO-SE-GIROK');
});
