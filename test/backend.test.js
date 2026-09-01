import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as XLSX from 'xlsx';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 19000 + (process.pid % 1000);
const url = `ws://127.0.0.1:${port}`;
let serverProcess;
const clients = new Set();

function waitForMessage(ws, predicate, timeoutMs = 3000) {
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

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.waiters = [];
    clients.add(ws);
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      for (let i = 0; i < ws.waiters.length; i += 1) {
        const waiter = ws.waiters[i];
        if (!waiter.predicate(message)) continue;
        ws.waiters.splice(i, 1);
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

async function assign(ws, role, corner) {
  ws.send(JSON.stringify({ type: 'role', role, corner }));
  return waitForMessage(ws, message => message.type === 'roleAccepted' || message.type === 'error');
}

before(async () => {
  serverProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SFTS_ALLOW_UNPAIRED_REMOTES: 'true'
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
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', chunk => { output += String(chunk); });
    serverProcess.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup with code ${code}: ${output}`));
    });
  });
});

after(async () => {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

test('WebSocket roles, majority scoring, timer expiry, and phase guards work', async () => {
  const host = await connect();
  const hostRole = await assign(host, 'host');
  assert.equal(hostRole.type, 'roleAccepted');
  assert.match(hostRole.hostToken, /^[a-f0-9]{48}$/);
  const initial = await waitForMessage(host, message => message.type === 'state');
  assert.equal(initial.match.phase, 'ROUND');

  const workbook = XLSX.utils.book_new();
  const players = XLSX.utils.json_to_sheet([
    { 'Player ID': 'M1', Name: 'Male One', Gender: 'MALE', 'Weight Category': '-58 kg' },
    { 'Player ID': 'M2', Name: 'Male Two', Gender: 'M', 'Weight Category': '-58 kg' },
    { 'Player ID': 'F1', Name: 'Female One', Gender: 'FEMALE', 'Weight Category': '-49 kg' },
    { 'Player ID': 'F2', Name: 'Female Two', Gender: 'F', 'Weight Category': '-49 kg' }
  ]);
  XLSX.utils.book_append_sheet(workbook, players, 'Players');
  const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`);
  assert.equal(unauthorized.status, 401);
  const imported = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-SFTS-Host-Token': hostRole.hostToken },
    body: workbookBuffer
  });
  assert.equal(imported.status, 200);
  const importedBody = await imported.json();
  assert.equal(importedBody.tournament.players.length, 4);
  assert.equal(importedBody.tournament.groups.length, 2);
  assert.equal(importedBody.tournament.schedule.length, 2);
  const firstBout = importedBody.tournament.schedule[0];
  const firstBoutPlayers = new Map(importedBody.tournament.players.map(player => [player.id, player]));
  assert.equal(firstBoutPlayers.get(firstBout.redPlayerId).gender, firstBoutPlayers.get(firstBout.bluePlayerId).gender);
  assert.equal(firstBoutPlayers.get(firstBout.redPlayerId).weightCategory, firstBoutPlayers.get(firstBout.bluePlayerId).weightCategory);
  const downloaded = await fetch(`http://127.0.0.1:${port}/api/tournament/schedule.xlsx`, {
    headers: { 'X-SFTS-Host-Token': hostRole.hostToken }
  });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-type'), /spreadsheetml/);
  host.send(JSON.stringify({ type: 'host', action: 'announceBout', boutNo: 1 }));
  const announcement = await waitForMessage(host, message => message.type === 'announcement' && message.boutNo === 1);
  assert.match(announcement.text, /Bout 1:/);

  host.send(JSON.stringify({
    type: 'host',
    action: 'playerSettings',
    players: {
      RED: { playerName: 'LEE', weightCategory: '-58 kg', stateCode: 'DL', district: 'New Delhi' },
      BLUE: { playerName: 'KIM', weightCategory: '-68 kg', stateCode: 'KA', district: 'Bengaluru' }
    }
  }));
  const configuredPlayers = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.match.red.name === 'HONG' &&
    message.match.red.playerName === 'LEE' &&
    message.match.red.weightCategory === '-58 kg' &&
    message.match.red.stateCode === 'DL' &&
    message.match.red.district === 'New Delhi' &&
    message.match.blue.name === 'CHUNG' &&
    message.match.blue.playerName === 'KIM' &&
    message.match.blue.weightCategory === '-68 kg' &&
    message.match.blue.stateCode === 'KA' &&
    message.match.blue.district === 'Bengaluru'
  ));
  assert.equal(configuredPlayers.match.red.playerName, 'LEE');

  const referees = [];
  for (let corner = 1; corner <= 4; corner += 1) {
    const referee = await connect();
    referees.push(referee);
    assert.equal((await assign(referee, 'referee', corner)).type, 'roleAccepted');
  }

  referees[3].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'BLUE', points: 1 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.votes['4']);
  host.send(JSON.stringify({ type: 'host', action: 'testStart' }));
  const testState = await waitForMessage(host, message => message.type === 'state' && message.match.test.active);
  assert.deepEqual(testState.match.votes, {});
  host.send(JSON.stringify({ type: 'host', action: 'testStop' }));
  await waitForMessage(host, message => message.type === 'state' && !message.match.test.active);

  const duplicateCorner = await connect();
  const duplicateResult = await assign(duplicateCorner, 'referee', 1);
  assert.equal(duplicateResult.code, 'CORNER_BUSY');

  const duplicateHost = await connect();
  const hostResult = await assign(duplicateHost, 'host');
  assert.equal(hostResult.code, 'HOST_BUSY');

  referees[3].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'BLUE', points: 1 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.votes['4']);
  referees[3].close();
  const cleanedVotes = await waitForMessage(host, message => message.type === 'state' && !message.match.votes['4']);
  assert.equal(cleanedVotes.match.votes['4'], undefined);

  referees.slice(0, 3).forEach(referee => {
    referee.send(JSON.stringify({ type: 'ref', action: 'vote', player: 'RED', points: 2 }));
  });
  await waitForMessage(host, message => message.type === 'award' && message.player === 'RED' && message.points === 2);
  const scored = await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 2);
  assert.equal(scored.match.votes && Object.keys(scored.match.votes).length, 0);

  host.send(JSON.stringify({ type: 'host', action: 'setTime', ms: 1000 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.timerMs === 1000);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'roundEnd' && message.record.reason === 'TIME 0:00');
  const breakState = await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'BREAK');

  host.send(JSON.stringify({ type: 'host', action: 'point', player: 'RED', points: 1 }));
  const rejected = await waitForMessage(host, message => message.type === 'error' && message.code === 'ROUND_NOT_ACTIVE');
  assert.equal(rejected.code, 'ROUND_NOT_ACTIVE');

  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  const pausedBreak = await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'BREAK' && !message.match.running);
  assert.equal(pausedBreak.match.red.score, breakState.match.red.score);

  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  const resetState = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.match.phase === 'ROUND' &&
    message.match.red.score === 0 &&
    message.match.red.name === 'HONG' &&
    message.match.red.playerName === 'LEE' &&
    message.match.red.weightCategory === '-58 kg' &&
    message.match.red.stateCode === 'DL' &&
    message.match.red.district === 'New Delhi'
  ));
  assert.equal(resetState.match.blue.stateCode, 'KA');
  assert.equal(resetState.match.blue.district, 'Bengaluru');
  const remote = await connect();
  remote.send(JSON.stringify({
    type: 'remote_hello',
    protocolVersion: 1,
    deviceId: 'C4',
    sessionId: 'test-session-c4',
    firmware: 'test'
  }));
  assert.equal((await waitForMessage(remote, message => message.type === 'remote_ready')).deviceId, 'C4');
  assert.equal(remote.messages.some(message => message.type === 'state'), false);
  const compactState = await waitForMessage(remote, message => message.type === 'remote_state');
  assert.equal(compactState.deviceId, 'C4');

  const remoteEvent = JSON.stringify({
    type: 'remote_event',
    deviceId: 'C4',
    sessionId: 'test-session-c4',
    sequence: 1,
    button: 'RED_2'
  });
  remote.send(remoteEvent);
  const firstAck = await waitForMessage(remote, message => message.type === 'remote_event_ack' && message.sequence === 1);
  assert.equal(firstAck.accepted, true);
  remote.send(remoteEvent);
  const duplicateAck = await waitForMessage(remote, message => message.type === 'remote_event_ack' && message.sequence === 1);
  assert.deepEqual(duplicateAck, firstAck);

  referees[0].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'RED', points: 2 }));
  referees[1].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'RED', points: 2 }));
  await waitForMessage(host, message => message.type === 'award' && message.player === 'RED' && message.points === 2);
  const remoteAwarded = await waitForMessage(remote, message => message.type === 'remote_state' && message.red.score === 2);
  assert.equal(remoteAwarded.red.score, 2);

  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0);
  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 1 }));
  const loadedBout = await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === 1);
  assert.equal(loadedBout.match.red.playerName, firstBout.redPlayerName);
  assert.equal(loadedBout.match.blue.playerName, firstBout.bluePlayerName);
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === null);
});

test('malformed WebSocket input does not terminate a connection', async () => {
  const client = await connect();
  client.send('not-json');
  client.send(JSON.stringify(null));
  client.send(JSON.stringify({ type: 'unknown' }));
  client.send(JSON.stringify({ type: 'host', action: 'point', player: 'INVALID', points: 99 }));
  client.send(JSON.stringify({
    type: 'remote_hello',
    protocolVersion: 1,
    deviceId: 'C1',
    sessionId: 'malformed-input-test'
  }));
  assert.equal((await waitForMessage(client, message => message.type === 'remote_ready')).deviceId, 'C1');
  const state = await waitForMessage(client, message => message.type === 'remote_state');
  assert.equal(state.deviceId, 'C1');
  assert.equal(client.readyState, WebSocket.OPEN);
});

test('HTTP static endpoint is available and QR endpoint is removed', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /STRIKE FORCE TAEKWONDO SCORING SYSTEM/);
  assert.match(html, /id="playerSheetFile"/);
  assert.match(html, /id="scheduleModal"/);
  assert.doesNotMatch(html, /onclick="openTestRemotes\(\)"/);
  assert.match(html, /onclick="openTestMode\(\)">TEST REMOTES<\/button>/);

  const css = await fetch(`http://127.0.0.1:${port}/css/style.css`);
  const js = await fetch(`http://127.0.0.1:${port}/js/app.js`);
  assert.equal(css.status, 200);
  assert.equal(js.status, 200);

  const info = await fetch(`http://127.0.0.1:${port}/api/info`);
  assert.equal(info.status, 404);
});
