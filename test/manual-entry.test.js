import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(projectRoot, 'data', `manual-entry-test-${process.pid}`);
const port = 21000 + (process.pid % 1000);
const wsUrl = `ws://127.0.0.1:${port}`;
let server;
const clients = new Set();

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.messages = [];
    socket.waiters = [];
    clients.add(socket);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      const index = socket.waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = socket.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        socket.messages.push(message);
      }
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitFor(socket, predicate, timeoutMs = 3000) {
  const queued = socket.messages.findIndex(predicate);
  if (queued >= 0) return Promise.resolve(socket.messages.splice(queued, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    waiter.timer = setTimeout(() => {
      const index = socket.waiters.indexOf(waiter);
      if (index >= 0) socket.waiters.splice(index, 1);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    socket.waiters.push(waiter);
  });
}

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SFTS_ALLOW_UNPAIRED_REMOTES: 'true',
      SFTS_DATA_DIR: dataDir,
      SFTS_HOST_TOKEN: 'manual-entry-host-token',
      SFTS_USB_IMPORT_ONLY: 'false'
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
    server.stdout.on('data', onData);
    server.stderr.on('data', chunk => { output += String(chunk); });
  });
});

after(async () => {
  for (const socket of clients) socket.close();
  if (server && server.exitCode === null) {
    await new Promise(resolve => {
      server.once('exit', resolve);
      server.kill();
    });
  }
  await rm(dataDir, { recursive: true, force: true });
});

test('manual categories are rulepack validated and preserve official bout evidence', async () => {
  const host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'manual-entry-host-token' }));
  const role = await waitFor(host, message => message.type === 'roleAccepted');
  const initial = await waitFor(host, message => message.type === 'state');
  assert.deepEqual(initial.manualCompetition.categories, []);
  assert.equal(initial.scoringRules.tournament.divisions.find(item => item.id === 'SUB_JUNIOR').categoryType, 'GROUP');

  const details = {
    eventName: 'Nadia District Championship 2026',
    eventDate: '2026-09-10',
    venue: 'Nadia Indoor Stadium',
    arenaNumber: '2',
    competition: 'KYORUGI',
    division: 'SUB_JUNIOR',
    gender: 'MALE',
    weightCategory: '',
    categoryGroup: 'GROUP 9',
    officialBoutNo: 'SJ-G0-01',
    stage: 'FINAL',
    RED: { playerName: 'Aarav Sen', club: 'Nadia TKD Academy', stateCode: 'WB', district: 'Nadia' },
    BLUE: { playerName: 'Rohan Das', club: 'Krishnanagar Club', stateCode: 'WB', district: 'Nadia' }
  };
  host.send(JSON.stringify({ type: 'host', action: 'saveManualBout', details }));
  const invalid = await waitFor(host, message => message.type === 'error' && message.code === 'INVALID_MANUAL_CATEGORY');
  assert.match(invalid.message, /active rulepack/i);

  details.categoryGroup = 'GROUP 0';
  host.send(JSON.stringify({ type: 'host', action: 'saveManualBout', details }));
  const loaded = await waitFor(host, message => message.type === 'state' && message.match.manualBout?.officialBoutNo === 'SJ-G0-01');
  const category = loaded.manualCompetition.categories[0];
  assert.equal(category.division, 'SUB_JUNIOR');
  assert.equal(category.categoryGroup, 'GROUP 0');
  assert.equal(loaded.match.red.club, 'Nadia TKD Academy');
  assert.equal(loaded.match.red.weightCategory, '');

  host.send(JSON.stringify({ type: 'host', action: 'setRemoteMode', count: 1 }));
  await waitFor(host, message => message.type === 'state' && message.match.remoteCount === 1);
  const remote = await connect();
  remote.send(JSON.stringify({ type: 'remote_hello', protocolVersion: 1, deviceId: 'C1', sessionId: 'manual-category-test' }));
  await waitFor(remote, message => message.type === 'remote_ready');
  await waitFor(remote, message => message.type === 'remote_state');

  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitFor(host, message => message.type === 'state' && message.match.running);
  remote.send(JSON.stringify({ type: 'remote_event', deviceId: 'C1', sessionId: 'manual-category-test', sequence: 1, button: 'RED_1' }));
  await waitFor(remote, message => message.type === 'remote_event_ack' && message.sequence === 1);
  await waitFor(host, message => message.type === 'state' && message.match.red.score === 1);
  host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 2 }));
  await waitFor(host, message => message.type === 'state' && message.match.red.score === 2);
  host.send(JSON.stringify({ type: 'host', action: 'saveManualBout', details: { ...details, categoryId: category.id } }));
  await waitFor(host, message => message.type === 'error' && message.code === 'MATCH_IN_PROGRESS');

  host.send(JSON.stringify({ type: 'host', action: 'manualMatchDecision', player: 'RED', decision: 'RSC' }));
  await waitFor(host, message => message.type === 'matchEnd' && message.winner === 'RED');
  const completed = await waitFor(host, message => message.type === 'state' && message.match.phase === 'MATCH_END');
  assert.equal(completed.matchHistory[0].roundCount, 1);
  assert.equal(completed.matchHistory[0].rounds, undefined);

  const archiveResponse = await fetch(`http://127.0.0.1:${port}/api/manual/categories?categoryId=${encodeURIComponent(category.id)}`, {
    headers: { 'X-SFTS-Host-Token': role.hostToken }
  });
  assert.equal(archiveResponse.status, 200);
  const archive = await archiveResponse.json();
  assert.equal(archive.records.length, 1);
  assert.equal(archive.records[0].manualBout.categoryId, category.id);
  assert.equal(archive.records[0].cornerRefereeHistory.length, 1);
  assert.equal(archive.records[0].cornerRefereeHistory[0].cornerReferee, 'C1-RED');
  assert.equal(archive.records[0].operatorHistory[0].action, 'SCORE EDIT');
  assert.equal(archive.records[0].operatorHistory[0].from, 1);
  assert.equal(archive.records[0].operatorHistory[0].to, 2);
  assert.equal(archive.records[0].red.club, 'Nadia TKD Academy');

  await new Promise(resolve => setTimeout(resolve, 300));
  const liveSnapshot = JSON.parse(await readFile(path.join(dataDir, 'sfts-state.json'), 'utf8'));
  const officialArchive = JSON.parse(await readFile(path.join(dataDir, 'manual-results.json'), 'utf8'));
  assert.equal(liveSnapshot.manualMatchRecords, undefined);
  assert.equal(officialArchive.records[0].manualBout.officialBoutNo, 'SJ-G0-01');

  const redKey = 'AARAV SEN|NADIA TKD ACADEMY';
  const blueKey = 'ROHAN DAS|KRISHNANAGAR CLUB';
  host.send(JSON.stringify({
    type: 'host',
    action: 'saveManualCategoryPlacements',
    categoryId: category.id,
    finalize: true,
    placements: { gold: redKey, silver: blueKey, bronze1: '', bronze2: '' }
  }));
  const finalized = await waitFor(host, message => message.type === 'state' && message.manualCompetition.categories[0]?.status === 'FINALIZED');
  assert.equal(finalized.manualCompetition.categories[0].placements.gold.playerName, 'Aarav Sen');
  assert.equal(finalized.manualCompetition.categories[0].placements.silver.playerName, 'Rohan Das');
});
