import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as XLSX from 'xlsx';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDataDir = path.join(projectRoot, 'data', `backend-test-${process.pid}`);
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

async function assign(ws, role, corner, accessToken = 'test-host-token') {
  ws.send(JSON.stringify({ type: 'role', role, corner, accessToken }));
  return waitForMessage(ws, message => message.type === 'roleAccepted' || message.type === 'error');
}

before(async () => {
  serverProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SFTS_ALLOW_UNPAIRED_REMOTES: 'true',
      SFTS_DATA_DIR: testDataDir,
      SFTS_BREAK_MS: '50',
      SFTS_HOST_TOKEN: 'test-host-token'
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
  await rm(testDataDir, { recursive: true, force: true });
});

test('WebSocket roles, majority scoring, timer expiry, and phase guards work', async () => {
  const unauthorizedHost = await connect();
  assert.equal((await assign(unauthorizedHost, 'host', 0, 'wrong-token')).code, 'HOST_UNAUTHORIZED');
  unauthorizedHost.close();
  const host = await connect();
  const hostRole = await assign(host, 'host');
  assert.equal(hostRole.type, 'roleAccepted');
  assert.match(hostRole.hostToken, /^[a-f0-9]{48}$/);
  const initial = await waitForMessage(host, message => message.type === 'state');
  assert.equal(initial.match.phase, 'ROUND');

  const workbook = XLSX.utils.book_new();
  const players = XLSX.utils.json_to_sheet([
    { 'Player ID': 'M1', Name: 'Male One', Gender: 'MALE', 'Weight Category': '58 kg' },
    { 'Player ID': 'M2', Name: 'Male Two', Gender: 'M', 'Weight Category': '58 kg' },
    { 'Player ID': 'F1', Name: 'Female One', Gender: 'FEMALE', 'Weight Category': '49 kg' },
    { 'Player ID': 'F2', Name: 'Female Two', Gender: 'F', 'Weight Category': '49 kg' }
  ]);
  XLSX.utils.book_append_sheet(workbook, players, 'Players');
  const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`);
  assert.equal(unauthorized.status, 401);
  const templateResponse = await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`, {
    headers: { 'X-SFTS-Host-Token': hostRole.hostToken }
  });
  assert.equal(templateResponse.status, 200);
  const templateWorkbook = XLSX.read(Buffer.from(await templateResponse.arrayBuffer()), { type: 'buffer' });
  const templateRows = XLSX.utils.sheet_to_json(templateWorkbook.Sheets[templateWorkbook.SheetNames[0]]);
  assert.equal(templateRows.length, 16);
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
      RED: { playerName: 'LEE', weightCategory: '58 kg', stateCode: 'DL', district: 'New Delhi' },
      BLUE: { playerName: 'KIM', weightCategory: '68 kg', stateCode: 'KA', district: 'Bengaluru' }
    }
  }));
  const configuredPlayers = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.match.red.name === 'HONG' &&
    message.match.red.playerName === 'LEE' &&
    message.match.red.weightCategory === '58 kg' &&
    message.match.red.stateCode === 'DL' &&
    message.match.red.district === 'New Delhi' &&
    message.match.blue.name === 'CHUNG' &&
    message.match.blue.playerName === 'KIM' &&
    message.match.blue.weightCategory === '68 kg' &&
    message.match.blue.stateCode === 'KA' &&
    message.match.blue.district === 'Bengaluru'
  ));
  assert.equal(configuredPlayers.match.red.playerName, 'LEE');

  host.send(JSON.stringify({ type: 'host', action: 'headPoint', player: 'RED' }));
  const pausedManual = await waitForMessage(host, message => message.type === 'error' && message.code === 'ROUND_NOT_ACTIVE');
  assert.equal(pausedManual.code, 'ROUND_NOT_ACTIVE');
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);

  host.send(JSON.stringify({ type: 'host', action: 'headPoint', player: 'RED' }));
  await waitForMessage(host, message => message.type === 'scoreSound' && message.player === 'RED' && message.points === 3);
  const manualRedHead = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === 3 && message.match.red.stats.plus3 === 1
  ));
  assert.equal(manualRedHead.match.red.score, 3);
  host.send(JSON.stringify({ type: 'host', action: 'headPoint', player: 'BLUE' }));
  await waitForMessage(host, message => message.type === 'scoreSound' && message.player === 'BLUE' && message.points === 3);
  const manualBlueHead = await waitForMessage(host, message => (
    message.type === 'state' && message.match.blue.score === 3 && message.match.blue.stats.plus3 === 1
  ));
  assert.equal(manualBlueHead.match.blue.score, 3);
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0 && message.match.blue.score === 0);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);

  host.send(JSON.stringify({ type: 'host', action: 'startKyeShi' }));
  const kyeShiStarted = await waitForMessage(host, message => (
    message.type === 'state' && message.match.kyeShi?.active && message.match.kyeShi.running === true
  ));
  assert.equal(kyeShiStarted.match.running, false);
  const matchTimeDuringKyeShi = kyeShiStarted.match.timerMs;
  host.send(JSON.stringify({ type: 'host', action: 'headPoint', player: 'RED' }));
  await waitForMessage(host, message => message.type === 'error' && message.code === 'ROUND_NOT_ACTIVE');
  host.send(JSON.stringify({ type: 'host', action: 'pauseKyeShi' }));
  const kyeShiPaused = await waitForMessage(host, message => message.type === 'state' && message.match.kyeShi?.active && !message.match.kyeShi.running);
  assert.equal(kyeShiPaused.match.timerMs, matchTimeDuringKyeShi);
  host.send(JSON.stringify({ type: 'host', action: 'resumeKyeShi' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.kyeShi?.active && message.match.kyeShi.running);
  host.send(JSON.stringify({ type: 'host', action: 'endKyeShi' }));
  const kyeShiEnded = await waitForMessage(host, message => (
    message.type === 'state' && !message.match.kyeShi?.active && message.match.running === true
  ));
  assert.equal(kyeShiEnded.match.running, true);
  assert.ok(kyeShiEnded.match.timerMs <= matchTimeDuringKyeShi);

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
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);

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
    message.match.red.weightCategory === '58 kg' &&
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
  remote.send(JSON.stringify({
    type: 'remote_status', deviceId: 'C4', sessionId: 'test-session-c4', rssi: -55, battery: 82
  }));
  const telemetryState = await waitForMessage(host, message => (
    message.type === 'state' && message.remotes?.find(remoteStatus => remoteStatus.deviceId === 'C4')?.rssi === -55
  ));
  const c4Status = telemetryState.remotes.find(remoteStatus => remoteStatus.deviceId === 'C4');
  assert.equal(c4Status.rssi, -55);
  assert.equal(c4Status.battery, 82);

  const remoteEvent = JSON.stringify({
    type: 'remote_event',
    deviceId: 'C4',
    sessionId: 'test-session-c4',
    sequence: 1,
    button: 'RED_2'
  });
  remote.send(remoteEvent);
  const firstAck = await waitForMessage(remote, message => message.type === 'remote_event_ack' && message.sequence === 1);
  assert.equal(firstAck.accepted, false);
  assert.equal(firstAck.reason, 'MATCH_NOT_RUNNING');
  remote.send(remoteEvent);
  const duplicateAck = await waitForMessage(remote, message => message.type === 'remote_event_ack' && message.sequence === 1);
  assert.deepEqual(duplicateAck, firstAck);

  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0);
  host.send(JSON.stringify({ type: 'host', action: 'setTime', ms: 10000 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.timerMs === 10000);
  host.send(JSON.stringify({ type: 'host', action: 'setRemoteMode', count: 2 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.remoteCount === 2);
  remote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C4', sessionId: 'test-session-c4', sequence: 2, button: 'RED_TECHNICAL'
  }));
  const disabledRemote = await waitForMessage(remote, message => message.type === 'remote_event_ack' && message.sequence === 2);
  assert.equal(disabledRemote.reason, 'REMOTE_DISABLED');
  host.send(JSON.stringify({ type: 'host', action: 'setRemoteMode', count: 4 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.remoteCount === 4);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);
  remote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C4', sessionId: 'test-session-c4', sequence: 3, button: 'RED_2'
  }));
  await waitForMessage(remote, message => message.type === 'remote_event_ack' && message.sequence === 3 && message.reason === 'VOTE_RECORDED');

  referees[0].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'RED', points: 2 }));
  referees[1].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'RED', points: 2 }));
  await waitForMessage(host, message => message.type === 'award' && message.player === 'RED' && message.points === 2);
  const remoteAwarded = await waitForMessage(remote, message => message.type === 'remote_state' && message.red.score === 2);
  assert.equal(remoteAwarded.red.score, 2);

  referees[0].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'RED', points: 1 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.votes['1']);
  referees[0].close();
  await waitForMessage(host, message => message.type === 'state' && !message.match.votes['1']);
  const technicalRemote = await connect();
  technicalRemote.send(JSON.stringify({
    type: 'remote_hello', protocolVersion: 1, deviceId: 'C1', sessionId: 'test-session-c1', firmware: 'test'
  }));
  assert.equal((await waitForMessage(technicalRemote, message => message.type === 'remote_ready')).deviceId, 'C1');
  await waitForMessage(technicalRemote, message => message.type === 'remote_state');
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0);
  host.send(JSON.stringify({ type: 'host', action: 'setTime', ms: 10000 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.timerMs === 10000);
  host.send(JSON.stringify({ type: 'host', action: 'setRemoteMode', count: 1 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.remoteCount === 1);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);
  technicalRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1', sequence: 1, button: 'RED_TECHNICAL'
  }));
  const technicalPending = await waitForMessage(technicalRemote, message => message.type === 'remote_event_ack' && message.sequence === 1);
  assert.equal(technicalPending.reason, 'TECHNICAL_PENDING');
  technicalRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1', sequence: 2, button: 'RED_2'
  }));
  const technicalVote = await waitForMessage(technicalRemote, message => message.type === 'remote_event_ack' && message.sequence === 2);
  assert.equal(technicalVote.technical, true);
  await waitForMessage(host, message => message.type === 'award' && message.player === 'RED' && message.points === 4);
  const technicalAwarded = await waitForMessage(technicalRemote, message => message.type === 'remote_state' && message.red.score === 4);
  assert.equal(technicalAwarded.red.score, 4);
  technicalRemote.close();
  await waitForMessage(host, message => message.type === 'state' && message.remotes?.find(remoteStatus => (
    remoteStatus.deviceId === 'C1' && remoteStatus.connected === false
  )));

  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0);
  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 1 }));
  const loadedBout = await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === 1);
  assert.equal(loadedBout.match.red.playerName, firstBout.redPlayerName);
  assert.equal(loadedBout.match.blue.playerName, firstBout.bluePlayerName);
  const blockedImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-SFTS-Host-Token': hostRole.hostToken },
    body: workbookBuffer
  });
  assert.equal(blockedImport.status, 409);
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === null);

  const bracketPlayers = XLSX.utils.json_to_sheet([
    { 'Player ID': 'B1', Name: 'Bracket One', Gender: 'MALE', 'Weight Category': '58 kg' },
    { 'Player ID': 'B2', Name: 'Bracket Two', Gender: 'MALE', 'Weight Category': '58 kg' },
    { 'Player ID': 'B3', Name: 'Bracket Three', Gender: 'MALE', 'Weight Category': '58 kg' },
    { 'Player ID': 'B4', Name: 'Bracket Four', Gender: 'MALE', 'Weight Category': '58 kg' },
    { 'Player ID': 'B5', Name: 'Bracket Five', Gender: 'MALE', 'Weight Category': '58 kg' }
  ]);
  const bracketWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(bracketWorkbook, bracketPlayers, 'Players');
  const bracketImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-SFTS-Host-Token': hostRole.hostToken },
    body: XLSX.write(bracketWorkbook, { type: 'buffer', bookType: 'xlsx' })
  });
  assert.equal(bracketImport.status, 200);
  const bracketBody = await bracketImport.json();
  assert.equal(bracketBody.tournament.format, 'SINGLE_ELIMINATION');
  assert.equal(bracketBody.tournament.schedule.length, 4);
  assert.equal(bracketBody.tournament.groups[0].bracketSize, 8);
  assert.equal(bracketBody.tournament.byes.length, 3);
  assert.equal(bracketBody.tournament.schedule.filter(bout => bout.status === 'SCHEDULED').length, 2);
  assert.equal(bracketBody.tournament.schedule.filter(bout => bout.status === 'PENDING').length, 2);
  assert.ok(bracketBody.tournament.schedule.slice(2).every(bout => bout.redSourceBoutNo || bout.blueSourceBoutNo));
  const initialBoutTwo = bracketBody.tournament.schedule.find(bout => bout.boutNo === 2);

  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 1 }));
  const firstBracketLoad = await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === 1);
  host.send(JSON.stringify({ type: 'host', action: 'setTime', ms: 1000 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.timerMs === 1000);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);
  host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 15 }));
  await waitForMessage(host, message => message.type === 'roundEnd' && message.record.winner === 'RED');
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 2);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);
  host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 15 }));
  await waitForMessage(host, message => message.type === 'matchEnd' && message.winner === 'RED');
  const advanced = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.tournament.schedule.find(bout => bout.boutNo === 3)?.status === 'SCHEDULED'
  ));
  const advancedBout = advanced.tournament.schedule.find(bout => bout.boutNo === 3);
  assert.ok(advancedBout.redPlayerId && advancedBout.bluePlayerId);
  assert.ok(advancedBout.redSourceBoutNo === 1 || advancedBout.blueSourceBoutNo === 1);

  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 2 }));
  const secondBracketLoad = await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === 2);
  assert.ok(secondBracketLoad.match.matchNo > firstBracketLoad.match.matchNo);
  for (let round = 1; round <= 3; round += 1) {
    if (round > 1 || !secondBracketLoad.match.running) {
      host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
      await waitForMessage(host, message => message.type === 'state' &&
        message.match.matchNo === secondBracketLoad.match.matchNo &&
        message.match.phase === 'ROUND' && message.match.running);
    }
    host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 1 }));
    host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'BLUE', value: 1 }));
    await waitForMessage(host, message => message.type === 'roundEnd' && message.record.winner === null);
    if (round < 3) {
      await waitForMessage(host, message => message.type === 'state' &&
        message.match.matchNo === secondBracketLoad.match.matchNo &&
        message.match.phase === 'ROUND' && message.match.round === round + 1);
    }
  }
  await waitForMessage(host, message => message.type === 'matchEnd' && message.winner === null);
  const tied = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.tournament.schedule.find(bout => bout.boutNo === 2)?.status === 'TIE_PENDING'
  ));
  assert.equal(tied.tournament.schedule.find(bout => bout.boutNo === 4).status, 'PENDING');
  host.send(JSON.stringify({ type: 'host', action: 'resolveTie', boutNo: 2, winner: 'BLUE' }));
  const tieResolved = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.tournament.schedule.find(bout => bout.boutNo === 2)?.status === 'COMPLETED'
  ));
  assert.equal(tieResolved.tournament.schedule.find(bout => bout.boutNo === 2).winnerName, initialBoutTwo.bluePlayerName);
  remote.close();
  const disconnectedState = await waitForMessage(host, message => (
    message.type === 'state' && message.remotes?.find(remoteStatus => (
      remoteStatus.deviceId === 'C4' && remoteStatus.connected === false && remoteStatus.lastSeenAt !== null
    ))
  ));
  assert.equal(disconnectedState.remotes.find(remoteStatus => remoteStatus.deviceId === 'C4').battery, 82);
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
  assert.match(html, /id="redHeadButton"/);
  assert.match(html, /id="blueHeadButton"/);
  assert.doesNotMatch(html, /onclick="openTestRemotes\(\)"/);
  assert.match(html, /onclick="openTestMode\(\)">REMOTE SETTINGS<\/button>/);
  assert.match(html, /id="remoteMode"/);
  assert.match(html, />\s*BACK\s*<\/button>/);
  assert.match(html, /id="remoteInfo1"/);

  const css = await fetch(`http://127.0.0.1:${port}/css/style.css`);
  const js = await fetch(`http://127.0.0.1:${port}/js/app.js`);
  assert.equal(css.status, 200);
  const cssText = await css.text();
  assert.match(cssText, /\.bottomArea[\s\S]*z-index: 10/);
  assert.match(cssText, /\.controlGrid button[\s\S]*cursor: pointer/);
  assert.equal(js.status, 200);
  const jsText = await js.text();
  assert.match(jsText, /let lastTournament = null/);
  assert.match(jsText, /lastTournament = msg\.tournament \|\| null/);
  assert.match(jsText, /renderSchedule\(lastTournament\)/);
  assert.match(jsText, /ws\.onclose/);
  assert.match(jsText, /reconnectDelay/);
  assert.match(jsText, /renderRemoteStatuses/);
  assert.match(html, /id="hostAccessToken"/);
  assert.match(html, /id="kyeShiPanel"/);
  assert.match(jsText, /remainingMs <= 10000/);
  assert.match(jsText, /startKyeShi/);

  const info = await fetch(`http://127.0.0.1:${port}/api/info`);
  assert.equal(info.status, 404);
});
