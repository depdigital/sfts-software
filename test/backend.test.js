import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as XLSX from 'xlsx';
import { readRulesFile } from '../src/rules.js';

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
  await mkdir(testDataDir, { recursive: true });
  const legacyDrawRules = await readRulesFile(path.join(projectRoot, 'config', 'rules.default.json'));
  legacyDrawRules.decisions.roundTie = { type: 'DRAW' };
  const testRulesPath = path.join(testDataDir, 'backend-test-rules.json');
  await writeFile(testRulesPath, JSON.stringify(legacyDrawRules));
  serverProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      SFTS_ALLOW_UNPAIRED_REMOTES: 'true',
      SFTS_DATA_DIR: testDataDir,
      SFTS_RULES_FILE: testRulesPath,
      SFTS_BREAK_MS: '50',
      SFTS_KYESHI_LIMIT_MS: '1000',
      SFTS_HOST_TOKEN: 'test-host-token',
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
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = new Promise(resolve => serverProcess.once('exit', resolve));
    serverProcess.kill();
    await exited;
  }
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
  assert.equal(initial.arenaNumber, '');
  assert.equal(initial.ruleset.id, 'sfts-current');
  assert.deepEqual(initial.scoringRules.basePointValues, [1, 2, 3]);
  assert.equal(initial.scoringRules.basePointLabels['2'], 'CHEST');
  const rulesStatus = await fetch(`http://127.0.0.1:${port}/api/rules/status`, {
    headers: { 'X-SFTS-Host-Token': hostRole.hostToken }
  });
  assert.equal(rulesStatus.status, 200);
  assert.equal((await rulesStatus.json()).activeRuleset.id, 'sfts-current');
  host.send(JSON.stringify({ type: 'host', action: 'setArenaNumber', value: '12' }));
  const arenaState = await waitForMessage(host, message => message.type === 'state' && message.arenaNumber === '12');
  assert.equal(arenaState.arenaNumber, '12');

  host.send(JSON.stringify({
    type: 'host',
    action: 'announcePlayers',
    details: {
      RED: {
        playerName: 'Manual Red',
        weightCategory: '-58 kg',
        stateCode: 'DL',
        district: 'New Delhi'
      },
      BLUE: {
        playerName: 'Manual Blue',
        weightCategory: '-58 kg',
        stateCode: 'UP',
        district: 'Noida'
      }
    }
  }));
  const playerAnnouncement = await waitForMessage(host, message => message.type === 'announcement');
  assert.equal(
    playerAnnouncement.text,
    'Manual Red, HONG, red chest guard, versus Manual Blue, CHUNG, blue chest guard; contestants, prepare for the match.'
  );

  host.send(JSON.stringify({ type: 'host', action: 'systemPower', powerAction: 'reboot' }));
  const powerScheduled = await waitForMessage(host, message => message.type === 'systemPowerScheduled');
  assert.equal(powerScheduled.action, 'reboot');
  assert.equal(powerScheduled.delayMs, 15000);
  assert.equal(powerScheduled.deadlineAt - powerScheduled.scheduledAt, 15000);
  host.send(JSON.stringify({ type: 'host', action: 'cancelSystemPower' }));
  const powerCancelled = await waitForMessage(host, message => message.type === 'systemPowerCancelled');
  assert.equal(powerCancelled.action, 'reboot');

  const workbook = XLSX.utils.book_new();
  const players = XLSX.utils.json_to_sheet([
    { 'Player ID': 'M1', Name: 'Male One', Gender: 'MALE', Division: 'SENIOR', 'Weight Category': 'FLYWEIGHT' },
    { 'Player ID': 'M2', Name: 'Male Two', Gender: 'M', Division: 'Senior', 'Weight Category': 'flyweight' },
    { 'Player ID': 'F1', Name: 'Female One', Gender: 'FEMALE', Division: 'SENIOR', 'Weight Category': 'FINWEIGHT' },
    { 'Player ID': 'F2', Name: 'Female Two', Gender: 'F', Division: 'SENIOR', 'Weight Category': 'FINWEIGHT' },
    { 'Player ID': 'J1', Name: 'Junior One', Gender: 'MALE', Division: 'JUNIOR', 'Weight Category': 'FLYWEIGHT' },
    { 'Player ID': 'J2', Name: 'Junior Two', Gender: 'M', Division: 'JUNIOR', 'Weight Category': 'flyweight' },
    { 'Player ID': 'S1', Name: 'Sub Junior One', Gender: 'MALE', Division: 'SUB JUNIOR', 'Weight Category': 'UNDER 16 KG' },
    { 'Player ID': 'S2', Name: 'Sub Junior Two', Gender: 'M', Division: 'SUB_JUNIOR', 'Weight Category': 'under 16 kg' }
  ]);
  XLSX.utils.book_append_sheet(workbook, players, 'Players');
  const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`);
  assert.equal(unauthorized.status, 401);
  const templateResponse = await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`, {
    headers: { 'X-SFTS-Host-Token': hostRole.hostToken }
  });
  assert.equal(templateResponse.status, 200);
  const templateBuffer = Buffer.from(await templateResponse.arrayBuffer());
  const templateWorkbook = XLSX.read(templateBuffer, { type: 'buffer' });
  assert.deepEqual(templateWorkbook.SheetNames, ['Players', 'Categories', 'Instructions']);
  const templateSheet = templateWorkbook.Sheets[templateWorkbook.SheetNames[0]];
  const templateRows = XLSX.utils.sheet_to_json(templateSheet);
  assert.equal(templateRows.length, 16);
  assert.deepEqual(XLSX.utils.sheet_to_json(templateSheet, { header: 1, defval: '' })[0], [
    'Player ID', 'Name', 'Gender', 'Division', 'Weight Category', 'Group', 'State Code', 'District', 'Club'
  ]);
  assert.ok(templateRows.some(row => row.Name === 'Arjun Mehta'));
  assert.ok(templateRows.every(row => row['State Code'] && row.District && row.Club));
  assert.ok(templateRows.some(row => row.Division === 'SUB JUNIOR' && row.Gender === 'MALE' && row['Weight Category'] === 'UNDER 23 KG' && !row.Group));
  assert.ok(templateRows.some(row => row.Division === 'SUB JUNIOR' && row.Gender === 'FEMALE' && row['Weight Category'] === 'UNDER 22 KG' && !row.Group));
  const categoryRows = XLSX.utils.sheet_to_json(templateWorkbook.Sheets.Categories);
  assert.ok(categoryRows.some(row => row.Division === 'SENIOR' && row.Gender === 'MALE' && row['Weight Category'] === 'FINWEIGHT'));
  assert.ok(categoryRows.some(row => row.Division === 'SUB JUNIOR' && row.Gender === 'MALE' && row['Weight Category'] === 'UNDER 16 KG'));
  assert.ok(categoryRows.some(row => row.Division === 'SUB JUNIOR' && row.Gender === 'FEMALE' && row['Weight Category'] === 'UNDER 57 KG'));
  const templateImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-SFTS-Host-Token': hostRole.hostToken },
    body: templateBuffer
  });
  assert.equal(templateImport.status, 200);
  const templateImportBody = await templateImport.json();
  assert.equal(templateImportBody.tournament.players.length, 16);
  assert.equal(templateImportBody.tournament.groups.length, 8);
  const imported = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-SFTS-Host-Token': hostRole.hostToken },
    body: workbookBuffer
  });
  assert.equal(imported.status, 200);
  const importedBody = await imported.json();
  assert.equal(importedBody.tournament.players.length, 8);
  assert.equal(importedBody.tournament.groups.length, 4);
  assert.equal(importedBody.tournament.schedule.length, 4);
  assert.equal(importedBody.tournament.placementPolicy.enabled, true);
  assert.equal(importedBody.tournament.placementPolicy.thirdPlacePolicy, 'BOTH_SEMIFINAL_LOSERS');
  const firstBout = importedBody.tournament.schedule[0];
  const firstBoutPlayers = new Map(importedBody.tournament.players.map(player => [player.id, player]));
  assert.equal(firstBoutPlayers.get(firstBout.redPlayerId).gender, firstBoutPlayers.get(firstBout.bluePlayerId).gender);
  assert.equal(firstBoutPlayers.get(firstBout.redPlayerId).division, firstBoutPlayers.get(firstBout.bluePlayerId).division);
  assert.equal(firstBoutPlayers.get(firstBout.redPlayerId).weightCategory, firstBoutPlayers.get(firstBout.bluePlayerId).weightCategory);
  const subJuniorGroup = importedBody.tournament.groups.find(group => group.division === 'SUB_JUNIOR');
  assert.equal(subJuniorGroup.categoryGroup, '');
  assert.equal(subJuniorGroup.weightCategory, 'UNDER 16 KG');
  assert.equal(importedBody.tournament.groups.filter(group => (
    group.gender === 'MALE' && group.weightCategory === 'FLYWEIGHT'
  )).length, 2);

  const invalidWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(invalidWorkbook, XLSX.utils.json_to_sheet([
    { Name: 'Invalid Category', Gender: 'FEMALE', Division: 'SENIOR', 'Weight Category': 'LT MIDDLEWEIGHT', Group: '' },
    { Name: 'Invalid Sub Junior Category', Gender: 'MALE', Division: 'SUB JUNIOR', 'Weight Category': 'UNDER 14 KG' }
  ]), 'Players');
  const invalidImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-SFTS-Host-Token': hostRole.hostToken },
    body: XLSX.write(invalidWorkbook, { type: 'buffer', bookType: 'xlsx' })
  });
  assert.equal(invalidImport.status, 400);
  const invalidImportBody = await invalidImport.json();
  assert.ok(invalidImportBody.errors.some(error => /weight category must be/.test(error)));
  const downloaded = await fetch(`http://127.0.0.1:${port}/api/tournament/schedule.xlsx`, {
    headers: { 'X-SFTS-Host-Token': hostRole.hostToken }
  });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-type'), /spreadsheetml/);
  const downloadedWorkbook = XLSX.read(Buffer.from(await downloaded.arrayBuffer()), { type: 'buffer' });
  assert.deepEqual(downloadedWorkbook.SheetNames, ['Schedule', 'Results']);
  const downloadedRows = XLSX.utils.sheet_to_json(downloadedWorkbook.Sheets.Schedule);
  assert.ok(downloadedRows.every(row => row.Division && row['Bracket ID']));
  assert.ok(downloadedRows.some(row => row.Division === 'SUB_JUNIOR' && row['Weight Category'] === 'UNDER 16 KG' && !row['Category Group']));
  host.send(JSON.stringify({ type: 'host', action: 'announceBout', boutNo: 1 }));
  const announcement = await waitForMessage(host, message => message.type === 'announcement' && message.boutNo === 1);
  assert.equal(
    announcement.text,
    `${firstBout.redPlayerName}, HONG, red chest guard, versus ${firstBout.bluePlayerName}, CHUNG, blue chest guard; contestants, prepare for the match.`
  );

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

  const firstScoreMessageOrder = [];
  const captureFirstScoreOrder = raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'state' && message.match?.red?.score === 3) firstScoreMessageOrder.push('state');
    if (message.type === 'scoreSound' && message.player === 'RED' && message.points === 3) firstScoreMessageOrder.push('scoreSound');
  };
  host.on('message', captureFirstScoreOrder);
  host.send(JSON.stringify({ type: 'host', action: 'headPoint', player: 'RED' }));
  await waitForMessage(host, message => message.type === 'scoreSound' && message.player === 'RED' && message.points === 3);
  const manualRedHead = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === 3 && message.match.red.stats.plus3 === 1
  ));
  host.off('message', captureFirstScoreOrder);
  assert.equal(manualRedHead.match.red.score, 3);
  assert.deepEqual(firstScoreMessageOrder.slice(0, 2), ['state', 'scoreSound']);
  host.send(JSON.stringify({ type: 'host', action: 'headPoint', player: 'BLUE' }));
  await waitForMessage(host, message => message.type === 'scoreSound' && message.player === 'BLUE' && message.points === 3);
  const manualBlueHead = await waitForMessage(host, message => (
    message.type === 'state' && message.match.blue.score === 3 && message.match.blue.stats.plus3 === 1
  ));
  assert.equal(manualBlueHead.match.blue.score, 3);
  host.send(JSON.stringify({ type: 'host', action: 'technicalPoint', player: 'RED', basePoints: 2 }));
  await waitForMessage(host, message => message.type === 'scoreSound' && message.player === 'RED' && message.points === 4);
  const manualRedTechnicalChest = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === 7 &&
    message.match.red.stats.plus2 === 0 && message.match.red.stats.technicalChest === 1
  ));
  assert.equal(manualRedTechnicalChest.match.operatorHistory.at(-1).action, 'TECHNICAL CHEST KICK');
  host.send(JSON.stringify({ type: 'host', action: 'technicalPoint', player: 'BLUE', basePoints: 3 }));
  await waitForMessage(host, message => message.type === 'scoreSound' && message.player === 'BLUE' && message.points === 6);
  const manualBlueTechnicalHead = await waitForMessage(host, message => (
    message.type === 'state' && message.match.blue.score === 9 &&
    message.match.blue.stats.plus3 === 1 && message.match.blue.stats.technicalHead === 1
  ));
  assert.equal(manualBlueTechnicalHead.match.operatorHistory.at(-1).action, 'TECHNICAL HEAD KICK');
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

  host.send(JSON.stringify({ type: 'host', action: 'startKyeShi' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.kyeShi?.active && message.match.kyeShi.running);
  const kyeShiLimit = await waitForMessage(host, message => (
    message.type === 'state' && message.match.kyeShi?.active && message.match.kyeShi.limitReached
  ));
  assert.equal(kyeShiLimit.match.running, false);
  host.send(JSON.stringify({ type: 'host', action: 'declareKyeShiWinner', player: 'BLUE' }));
  const kyeShiDecision = await waitForMessage(host, message => (
    message.type === 'matchEnd' && message.winner === 'BLUE' && message.reason === 'KYE-SHI DECISION'
  ));
  assert.equal(kyeShiDecision.match.roundHistory.at(-1).reason, 'KYE-SHI DECISION');
  const decisionState = await waitForMessage(host, message => (
    message.type === 'state' && message.match.phase === 'MATCH_END' && message.match.matchReason === 'KYE-SHI DECISION'
  ));
  assert.equal(decisionState.match.matchWinner, 'BLUE');
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0 && !message.match.kyeShi?.active);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);

  const referees = [];
  for (let corner = 1; corner <= 4; corner += 1) {
    const referee = await connect();
    referees.push(referee);
    assert.equal((await assign(referee, 'referee', corner)).type, 'roleAccepted');
  }

  referees[3].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'BLUE', points: 1 }));
  const initialCornerVote = await waitForMessage(host, message => message.type === 'state' && message.match.votes['4']);
  assert.equal(initialCornerVote.match.votes['4'].button, 'BLUE_1');
  host.send(JSON.stringify({ type: 'host', action: 'testStart' }));
  const testState = await waitForMessage(host, message => message.type === 'state' && message.match.test.active);
  assert.deepEqual(testState.match.votes, {});
  host.send(JSON.stringify({ type: 'host', action: 'testStop' }));
  await waitForMessage(host, message => message.type === 'state' && !message.match.test.active);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);

  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => (
    message.type === 'state' && message.match.phase === 'ROUND' &&
    message.match.roundStarted && !message.match.running
  ));
  host.send(JSON.stringify({ type: 'host', action: 'point', player: 'RED', points: 1 }));
  await waitForMessage(host, message => message.type === 'scoreSound' && message.player === 'RED' && message.points === 1);
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 1);
  host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'BLUE', value: 5 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.blue.score === 5);
  host.send(JSON.stringify({ type: 'host', action: 'editGamjeom', player: 'BLUE', value: 2 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.blue.gamjeom === 2);
  host.send(JSON.stringify({ type: 'host', action: 'gamjeom', player: 'RED' }));
  const pausedOperatorState = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.gamjeom === 1 && message.match.red.score === 1
  ));

  referees[0].send(JSON.stringify({ type: 'ref', action: 'vote', player: 'BLUE', points: 3 }));
  await new Promise(resolve => setTimeout(resolve, 100));
  host.send(JSON.stringify({ type: 'host', action: 'name', player: 'RED', name: pausedOperatorState.match.red.playerName }));
  const afterPausedRefereeVote = await waitForMessage(host, message => message.type === 'state' && (
    message.match.red.score === pausedOperatorState.match.red.score &&
    message.match.blue.score === pausedOperatorState.match.blue.score &&
    message.match.red.gamjeom === pausedOperatorState.match.red.gamjeom &&
    message.match.blue.gamjeom === pausedOperatorState.match.blue.gamjeom
  ));
  assert.equal(afterPausedRefereeVote.match.votes['1'], undefined);

  const pausedRemote = await connect();
  pausedRemote.send(JSON.stringify({
    type: 'remote_hello', protocolVersion: 1, deviceId: 'C2', sessionId: 'paused-remote-test'
  }));
  await waitForMessage(pausedRemote, message => message.type === 'remote_ready');
  await waitForMessage(pausedRemote, message => message.type === 'remote_state');
  pausedRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C2', sessionId: 'paused-remote-test', sequence: 1, button: 'BLUE_3'
  }));
  const pausedRemoteAck = await waitForMessage(pausedRemote, message => (
    message.type === 'remote_event_ack' && message.sequence === 1
  ));
  assert.equal(pausedRemoteAck.reason, 'MATCH_NOT_RUNNING');
  pausedRemote.close();

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
  const multiRemoteAward = await waitForMessage(host, message => message.type === 'award' && message.player === 'RED' && message.points === 2);
  assert.deepEqual(multiRemoteAward.corners, [1, 2, 3]);
  const scored = await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 3);
  assert.equal(scored.match.votes && Object.keys(scored.match.votes).length, 0);

  host.send(JSON.stringify({ type: 'host', action: 'setTime', ms: 1000 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.timerMs === 1000);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'roundEnd' && message.record.reason === 'TIME 0:00');
  const breakState = await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'BREAK');
  assert.deepEqual(breakState.remoteScoreHighlights.RED, []);
  assert.deepEqual(breakState.remoteScoreHighlights.BLUE, []);
  assert.equal(breakState.remoteScoreValues.RED, null);
  assert.equal(breakState.remoteScoreValues.BLUE, null);

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
  const technicalChestState = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.stats.technicalChest === 1 &&
    message.match.red.stats.technicalHead === 0
  ));
  assert.equal(technicalChestState.match.red.stats.plus2, 0);
  assert.equal(technicalChestState.remoteButtons[0], 'RED_TECHNICAL_2');
  assert.deepEqual(technicalChestState.remoteScoreHighlights.RED, [1]);
  const technicalAwarded = await waitForMessage(technicalRemote, message => message.type === 'remote_state' && message.red.score === 4);
  assert.equal(technicalAwarded.red.score, 4);
  technicalRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1', sequence: 3, button: 'RED_TECHNICAL'
  }));
  await waitForMessage(technicalRemote, message => message.type === 'remote_event_ack' && message.sequence === 3);
  technicalRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1', sequence: 4, button: 'RED_3'
  }));
  const technicalHeadVote = await waitForMessage(technicalRemote, message => message.type === 'remote_event_ack' && message.sequence === 4);
  assert.equal(technicalHeadVote.technical, true);
  const technicalHeadState = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.stats.technicalChest === 1 &&
    message.match.red.stats.technicalHead === 1
  ));
  assert.equal(technicalHeadState.match.red.stats.plus3, 0);
  assert.equal(technicalHeadState.remoteButtons[0], 'RED_TECHNICAL_3');
  assert.deepEqual(technicalHeadState.remoteScoreHighlights.RED, [1]);
  technicalRemote.close();
  await waitForMessage(host, message => message.type === 'state' && message.remotes?.find(remoteStatus => (
    remoteStatus.deviceId === 'C1' && remoteStatus.connected === false
  )));

  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0);
  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 1 }));
  const loadedBout = await waitForMessage(host, message => (
    message.type === 'state' && message.tournament.players.length === 8 && message.tournament.activeBoutNo === 1
  ));
  assert.equal(loadedBout.match.red.playerName, firstBout.redPlayerName);
  assert.equal(loadedBout.match.blue.playerName, firstBout.bluePlayerName);
  assert.equal(loadedBout.match.red.division, firstBout.division);
  const blockedImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-SFTS-Host-Token': hostRole.hostToken },
    body: workbookBuffer
  });
  assert.equal(blockedImport.status, 409);
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === null);

  const subJuniorBout = importedBody.tournament.schedule.find(bout => bout.weightCategory === 'UNDER 16 KG');
  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: subJuniorBout.boutNo }));
  const loadedSubJuniorBout = await waitForMessage(host, message => (
    message.type === 'state' && message.tournament.players.length === 8 &&
    message.tournament.activeBoutNo === subJuniorBout.boutNo
  ));
  assert.equal(loadedSubJuniorBout.match.red.division, 'SUB_JUNIOR');
  assert.equal(loadedSubJuniorBout.match.red.categoryGroup, '');
  assert.equal(loadedSubJuniorBout.match.red.weightCategory, 'UNDER 16 KG');
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => (
    message.type === 'state' && message.tournament.players.length === 8 && message.tournament.activeBoutNo === null
  ));

  const bracketPlayers = XLSX.utils.json_to_sheet([
    { 'Player ID': 'B1', Name: 'Bracket One', Gender: 'MALE', Division: 'SENIOR', 'Weight Category': 'FLYWEIGHT', Group: '' },
    { 'Player ID': 'B2', Name: 'Bracket Two', Gender: 'MALE', Division: 'SENIOR', 'Weight Category': 'FLYWEIGHT', Group: '' },
    { 'Player ID': 'B3', Name: 'Bracket Three', Gender: 'MALE', Division: 'SENIOR', 'Weight Category': 'FLYWEIGHT', Group: '' },
    { 'Player ID': 'B4', Name: 'Bracket Four', Gender: 'MALE', Division: 'SENIOR', 'Weight Category': 'FLYWEIGHT', Group: '' },
    { 'Player ID': 'B5', Name: 'Bracket Five', Gender: 'MALE', Division: 'SENIOR', 'Weight Category': 'FLYWEIGHT', Group: '' }
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
  const firstBracketLoad = await waitForMessage(host, message => (
    message.type === 'state' && message.tournament.players.length === 5 && message.tournament.activeBoutNo === 1
  ));
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
    message.tournament.players.length === 5 &&
    message.tournament.schedule.find(bout => bout.boutNo === 3)?.status === 'SCHEDULED'
  ));
  const advancedBout = advanced.tournament.schedule.find(bout => bout.boutNo === 3);
  assert.ok(advancedBout.redPlayerId && advancedBout.bluePlayerId);
  assert.ok(advancedBout.redSourceBoutNo === 1 || advancedBout.blueSourceBoutNo === 1);

  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 2 }));
  const secondBracketLoad = await waitForMessage(host, message => (
    message.type === 'state' && message.tournament.players.length === 5 && message.tournament.activeBoutNo === 2
  ));
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
  const tied = await waitForMessage(host, message => (
    message.type === 'state' && message.match.phase === 'TIE_DECISION' &&
    message.match.tieDecision?.mode === 'CHOOSE_METHOD'
  ));
  assert.deepEqual(tied.match.tieDecision.options, ['GOLDEN_ROUND', 'WOO_SE_GIROK']);
  assert.equal(tied.tournament.schedule.find(bout => bout.boutNo === 2).status, 'IN_PROGRESS');
  assert.equal(tied.tournament.schedule.find(bout => bout.boutNo === 4).status, 'PENDING');
  host.send(JSON.stringify({ type: 'host', action: 'decideWooSeGirok', player: 'BLUE' }));
  await waitForMessage(host, message => message.type === 'matchEnd' && message.winner === 'BLUE' && message.reason === 'SUP - WOO-SE-GIROK');
  const tieResolved = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.tournament.schedule.find(bout => bout.boutNo === 2)?.status === 'COMPLETED'
  ));
  assert.equal(tieResolved.tournament.schedule.find(bout => bout.boutNo === 2).winnerName, initialBoutTwo.bluePlayerName);

  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 3 }));
  await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === 3);
  host.send(JSON.stringify({ type: 'host', action: 'manualMatchDecision', player: 'RED', decision: 'RSC' }));
  await waitForMessage(host, message => message.type === 'matchEnd' && message.winner === 'RED');
  const finalReady = await waitForMessage(host, message => (
    message.type === 'state' &&
    message.tournament.schedule.find(bout => bout.boutNo === 3)?.status === 'COMPLETED' &&
    message.tournament.schedule.find(bout => bout.boutNo === 4)?.status === 'SCHEDULED'
  ));
  const finalBout = finalReady.tournament.schedule.find(bout => bout.boutNo === 4);
  host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: 4 }));
  await waitForMessage(host, message => message.type === 'state' && message.tournament.activeBoutNo === 4);
  host.send(JSON.stringify({ type: 'host', action: 'manualMatchDecision', player: 'BLUE', decision: 'RSC' }));
  await waitForMessage(host, message => message.type === 'matchEnd' && message.winner === 'BLUE');
  const categoryComplete = await waitForMessage(host, message => (
    message.type === 'state' && message.tournament.groups[0]?.resultStatus === 'COMPLETED'
  ));
  const completedGroup = categoryComplete.tournament.groups[0];
  assert.deepEqual(completedGroup.placements.map(placement => placement.place), [1, 2, 3, 3]);
  assert.equal(completedGroup.placements[0].playerId, finalBout.bluePlayerId);
  assert.equal(completedGroup.placements[1].playerId, finalBout.redPlayerId);
  assert.ok(completedGroup.placements.slice(2).every(placement => placement.basis === 'SEMIFINAL_LOSER'));
  assert.equal(new Set(completedGroup.placements.map(placement => placement.playerId)).size, 4);

  const completedDownload = await fetch(`http://127.0.0.1:${port}/api/tournament/schedule.xlsx`, {
    headers: { 'X-SFTS-Host-Token': hostRole.hostToken }
  });
  const completedWorkbook = XLSX.read(Buffer.from(await completedDownload.arrayBuffer()), { type: 'buffer' });
  const resultRows = XLSX.utils.sheet_to_json(completedWorkbook.Sheets.Results);
  assert.equal(resultRows.length, 4);
  assert.deepEqual(resultRows.map(row => row.Place), ['1ST', '2ND', '3RD', '3RD']);

  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 1);
  host.messages.length = 0;
  for (let round = 1; round <= 3; round += 1) {
    host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
    await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.running);
    host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 1 }));
    host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'BLUE', value: 1 }));
    await waitForMessage(host, message => message.type === 'roundEnd' && message.record.round === round && message.record.winner === null);
    if (round < 3) {
      await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === round + 1);
    }
  }
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'TIE_DECISION');
  host.send(JSON.stringify({ type: 'host', action: 'startGoldenRound' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'BREAK' && message.match.breakTarget === 'GOLDEN');
  const goldenRound = await waitForMessage(host, message => (
    message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 4 && message.match.goldenRound?.active
  ));
  assert.ok(goldenRound.match.roundHistory.slice(0, 3).every(record => record.voidedForGoldenRound));
  host.send(JSON.stringify({ type: 'host', action: 'setTime', ms: 1000 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.round === 4 && message.match.timerMs === 1000);
  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.round === 4 && message.match.running);
  host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 2 }));
  const goldenWinner = await waitForMessage(host, message => (
    message.type === 'matchEnd' && message.winner === 'RED' && message.reason === 'GDP - 2 POINTS'
  ));
  assert.equal(goldenWinner.match.roundHistory.at(-1).goldenRound, true);

  const defaultRulesResponse = await fetch(`http://127.0.0.1:${port}/api/rules/default`, {
    method: 'POST',
    headers: { 'X-SFTS-Host-Token': hostRole.hostToken }
  });
  assert.equal(defaultRulesResponse.status, 200);
  const defaultRulesBody = await defaultRulesResponse.json();
  assert.equal(defaultRulesBody.message, 'DEFAULT RULESET LOADED');
  assert.equal(defaultRulesBody.summary.basePointLabels['2'], 'CHEST');
  assert.equal(defaultRulesBody.summary.roundTie.type, 'SUPERIORITY');

  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.phase === 'ROUND' && message.match.round === 1);
  host.send(JSON.stringify({ type: 'host', action: 'manualMatchDecision', player: 'BLUE', decision: 'RSC' }));
  await waitForMessage(host, message => (
    message.type === 'matchEnd' && message.winner === 'BLUE' && message.reason === 'RSC - REFEREE DECLARATION'
  ));

  remote.close();
  const disconnectedState = await waitForMessage(host, message => (
    message.type === 'state' && message.remotes?.find(remoteStatus => (
      remoteStatus.deviceId === 'C4' && remoteStatus.connected === false && remoteStatus.lastSeenAt !== null
    ))
  ));
  assert.equal(disconnectedState.remotes.find(remoteStatus => remoteStatus.deviceId === 'C4').battery, 82);

  // A reboot must use a new session, while a reconnect within the same boot
  // must retain replay protection.
  host.send(JSON.stringify({ type: 'host', action: 'resetMatch' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.red.score === 0);
  host.send(JSON.stringify({ type: 'host', action: 'setRemoteMode', count: 4 }));
  await waitForMessage(host, message => message.type === 'state' && message.match.remoteCount === 4);
  const sameBoot = await connect();
  sameBoot.send(JSON.stringify({
    type: 'remote_hello', protocolVersion: 1, deviceId: 'C3', sessionId: 'boot-session-a'
  }));
  await waitForMessage(sameBoot, message => message.type === 'remote_ready');
  await waitForMessage(sameBoot, message => message.type === 'remote_state');
  sameBoot.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C3', sessionId: 'boot-session-a', sequence: 1, button: 'RED_1'
  }));
  assert.equal(
    (await waitForMessage(sameBoot, message => message.type === 'remote_event_ack' && message.sequence === 1)).reason,
    'MATCH_NOT_RUNNING'
  );
  sameBoot.close();
  await waitForMessage(host, message => message.type === 'state' && message.remotes?.find(remoteStatus => (
    remoteStatus.deviceId === 'C3' && remoteStatus.connected === false
  )));

  const sameSession = await connect();
  sameSession.send(JSON.stringify({
    type: 'remote_hello', protocolVersion: 1, deviceId: 'C3', sessionId: 'boot-session-a'
  }));
  await waitForMessage(sameSession, message => message.type === 'remote_ready');
  await waitForMessage(sameSession, message => message.type === 'remote_state');
  sameSession.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C3', sessionId: 'boot-session-a', sequence: 1, button: 'RED_1'
  }));
  assert.equal(
    (await waitForMessage(sameSession, message => message.type === 'remote_event_ack' && message.sequence === 1)).reason,
    'MATCH_NOT_RUNNING'
  );

  host.send(JSON.stringify({ type: 'host', action: 'playPause' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.running);
  sameSession.close();
  await waitForMessage(host, message => message.type === 'state' && message.remotes?.find(remoteStatus => (
    remoteStatus.deviceId === 'C3' && remoteStatus.connected === false
  )));

  const newBoot = await connect();
  newBoot.send(JSON.stringify({
    type: 'remote_hello', protocolVersion: 1, deviceId: 'C3', sessionId: 'boot-session-b'
  }));
  await waitForMessage(newBoot, message => message.type === 'remote_ready');
  await waitForMessage(newBoot, message => message.type === 'remote_state');
  newBoot.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C3', sessionId: 'boot-session-b', sequence: 1, button: 'RED_1'
  }));
  assert.equal(
    (await waitForMessage(newBoot, message => message.type === 'remote_event_ack' && message.sequence === 1)).reason,
    'VOTE_RECORDED'
  );
  newBoot.close();
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
  assert.match(html, /id="manualEntryModal"/);
  assert.match(html, /id="dataImportModal"/);
  assert.match(html, /id="manualCategoryResultsModal"/);
  assert.match(html, /id="practiceModeModal"/);
  assert.match(html, /id="practiceModeBadge"/);
  assert.match(html, />MANUAL ENTRY</);
  assert.match(html, />DATA IMPORT</);
  assert.match(html, />PRACTICE MODE</);
  assert.doesNotMatch(html, />[12]\. (?:MANUAL ENTRY|DATA IMPORT)</);
  assert.match(html, /id="scheduleModal"/);
  assert.match(html, /id="tournamentResultsList"/);
  assert.match(html, /id="redHeadButton"/);
  assert.match(html, /id="blueHeadButton"/);
  assert.doesNotMatch(html, /corner_referee\.png/);
  assert.match(html, /class="cornerRefereeLabel">C1<\/span>/);
  assert.match(html, /id="redCornerScore1" class="cornerRefereeScore"/);
  assert.match(html, /id="blueCornerScore4" class="cornerRefereeScore"/);
  assert.doesNotMatch(html, /onclick="openTestRemotes\(\)"/);
  assert.match(html, /onclick="openTestMode\(\)">REMOTE SETTINGS<\/button>/);
  assert.match(html, /onclick="openRules\(\)">RULES<\/button>/);
  assert.match(html, /id="usbRulesFile"/);
  assert.match(html, /id="refreshRulesButton"/);
  assert.match(html, /id="defaultRulesButton"/);
  assert.match(html, /id="remoteDisconnectPopup"/);
  assert.doesNotMatch(html, /ROLL BACK PREVIOUS/);
  assert.doesNotMatch(html, /PREVIEW RULE PACK/);
  assert.match(html, /id="remoteMode"/);
  assert.match(html, />\s*BACK\s*<\/button>/);
  assert.match(html, /id="remoteInfo1"/);
  assert.match(html, /id="arenaNo"/);
  assert.match(html, /onclick="openArenaNumber\(\)">ARENA NUMBER<\/button>/);
  assert.match(html, /id="arenaNumberInput"/);
  assert.match(html, /id="summaryRedTechnicalChest"/);
  assert.match(html, /id="summaryRedTechnicalHead"/);
  assert.match(html, /id="summaryBlueTechnicalChest"/);
  assert.match(html, /id="summaryBlueTechnicalHead"/);
  assert.match(html, /id="tieDecisionModal"/);
  assert.match(html, /onclick="editKickCounts\('RED'\)"/);
  assert.match(html, /onclick="editKickCounts\('BLUE'\)"/);
  assert.match(html, /onclick="startGoldenRound\(\)"/);
  assert.match(html, /PROCEED TO GOLDEN ROUND \(ROUND 4\)/);
  assert.match(html, /onclick="backFromTieDecision\(\)"/);
  assert.match(html, /DECLARE "HONG" WINNER/);
  assert.match(html, /DECLARE "CHUNG" WINNER/);
  assert.match(html, /id="matchDecisionModal"/);
  assert.match(html, /id="screensaver"/);
  assert.match(html, /src="\/assets\/sfts-logo\.png"/);
  assert.doesNotMatch(html, /class="screensaverSubtitle"/);
  assert.doesNotMatch(html, /class="screensaverPoweredBy"/);
  assert.doesNotMatch(html, /class="screensaverFooter"/);

  const css = await fetch(`http://127.0.0.1:${port}/css/style.css`);
  const js = await fetch(`http://127.0.0.1:${port}/js/app.js`);
  assert.equal(css.status, 200);
  const cssText = await css.text();
  assert.match(cssText, /\.bottomArea[\s\S]*z-index: 10/);
  assert.match(cssText, /\.hostScreen\.matchClockRunning[\s\S]*\.bottomArea/);
  assert.match(cssText, /\.screensaver[\s\S]*background-image: url\("\/assets\/tkd_cover\.png"\)/);
  assert.match(cssText, /\.screensaver[\s\S]*background-position: right center/);
  assert.match(cssText, /\.homeScreen\s*\{[^}]*height:\s*100vh[^}]*overflow:\s*hidden/);
  assert.match(cssText, /\.homeLogo\s*\{[^}]*width:\s*min\(1500px, 100%\)/);
  assert.doesNotMatch(cssText, /\.screensaver\s*\{[^}]*transition:/);
  assert.match(cssText, /\.screensaverContent img[\s\S]*animation: screensaverLogoCycle 5s ease-in-out infinite/);
  assert.match(cssText, /\.homeBtn[\s\S]*animation: homeLaunchGlow 2s ease-in-out infinite/);
  assert.match(cssText, /@keyframes homeLaunchGlow/);
  assert.match(cssText, /screensaverLogoCycle[\s\S]*transform: scale\(2\.5\)/);
  assert.match(cssText, /\.controlGrid button[\s\S]*cursor: pointer/);
  assert.match(html, /id="redChestButton"[\s\S]*src="\/assets\/chestguard\.png"/);
  assert.match(html, /id="redHeadButton"[\s\S]*src="\/assets\/headgear\.png"/);
  assert.match(html, /id="redPunchButton"[\s\S]*src="\/assets\/fist\.png"/);
  assert.match(html, /id="blueChestButton"[\s\S]*src="\/assets\/chestguard\.png"/);
  assert.match(html, /id="blueHeadButton"[\s\S]*src="\/assets\/headgear\.png"/);
  assert.match(html, /id="bluePunchButton"[\s\S]*src="\/assets\/fist\.png"/);
  assert.match(html, /manualConfiguredPoint\('RED', 'redHeadButton', event\)/);
  assert.match(html, /manualConfiguredPoint\('RED', 'redChestButton', event\)/);
  assert.match(html, /manualConfiguredPoint\('BLUE', 'blueHeadButton', event\)/);
  assert.match(html, /manualConfiguredPoint\('BLUE', 'blueChestButton', event\)/);
  assert.ok(html.indexOf('id="redHeadButton"') < html.indexOf('id="redChestButton"'));
  assert.ok(html.indexOf('id="redChestButton"') < html.indexOf('id="redPunchButton"'));
  assert.ok(html.indexOf('id="blueHeadButton"') < html.indexOf('id="blueChestButton"'));
  assert.ok(html.indexOf('id="blueChestButton"') < html.indexOf('id="bluePunchButton"'));
  assert.match(cssText, /\.scoreActionIcon[\s\S]*drop-shadow/);
  assert.match(cssText, /\.roundText\s*\{[^}]*width:\s*100%[^}]*text-align:\s*center/);
  assert.match(cssText, /\.gamRibbon b\s*\{[^}]*line-height:\s*1/);
  assert.match(cssText, /\.nameInput\s*\{[^}]*padding:\s*4px 8px clamp\(24px, 3vh, 42px\)/);
  assert.match(cssText, /\.cornerRefereeIcon\.active[\s\S]*drop-shadow/);
  assert.equal(js.status, 200);
  const jsText = await js.text();
  assert.match(jsText, /let lastTournament = null/);
  assert.match(jsText, /lastRemoteButtons\[c - 1\] \|\| v\?\.button/);
  assert.match(jsText, /renderCornerRefereeIndicators\(match\.remoteCount\)/);
  assert.match(jsText, /remoteScoreValues\[player\]/);
  const serverSource = await readFile(path.join(projectRoot, 'src/server.js'), 'utf8');
  assert.match(serverSource, /REMOTE_BUTTON_DISPLAY_MS = 250/);
  assert.match(serverSource, /REMOTE_SCORE_DISPLAY_MS = 500/);
  assert.match(jsText, /lastTournament = msg\.tournament \|\| null/);
  assert.match(jsText, /renderSchedule\(lastTournament\)/);
  assert.match(jsText, /function renderTournamentResults\(tournament\)/);
  assert.match(jsText, /\["Space", "KeyR", "KeyB", "KeyS"\]/);
  assert.match(jsText, /event\.code === "Space"\) playPause\(\)/);
  assert.match(jsText, /event\.code === "KeyR"\) manualGam\("RED"\)/);
  assert.match(jsText, /event\.code === "KeyB"\) manualGam\("BLUE"\)/);
  assert.match(jsText, /lastState\?\.phase === "ROUND" && lastState\.running === true/);
  assert.match(jsText, /toggleScreensaver\(\)/);
  assert.match(jsText, /ws\.onclose/);
  assert.match(jsText, /reconnectDelay/);
  assert.match(jsText, /renderRemoteStatuses/);
  assert.match(jsText, /renderTieDecision\(match\)/);
  assert.match(jsText, /function backFromTieDecision\(\)/);
  assert.match(jsText, /decideGoldenRoundSuperiority/);
  assert.match(jsText, /ROUND_WOO_SE_GIROK/);
  assert.match(jsText, /MATCH_WOO_SE_GIROK/);
  assert.match(jsText, /function editKickCounts\(player\)/);
  assert.match(jsText, /v\?\.button \|\| "—"/);
  assert.match(jsText, /match\.phase === "ROUND" && match\.running === true/);
  assert.match(jsText, /matchClockRunning/);
  assert.match(jsText, /action: "setArenaNumber"/);
  assert.match(jsText, /technicalChest/);
  assert.match(jsText, /technicalHead/);
  assert.match(jsText, /function winnerReasonDescription\(reason\)/);
  assert.match(jsText, /PTF: "WIN BY FINAL SCORE"/);
  assert.match(jsText, /PTG: "WIN BY POINT GAP"/);
  assert.match(jsText, /GDP: "WIN BY GOLDEN POINTS"/);
  assert.match(jsText, /SUP: "WIN BY SUPERIORITY"/);
  assert.match(jsText, /winnerReasonDescription\(match\.matchReason\)/);
  assert.match(jsText, /event\?\.ctrlKey/);
  assert.match(serverSource, /technicalPoint/);
  assert.match(html, /id="hostAccessToken"/);
  assert.match(html, /id="kyeShiPanel"/);
  assert.match(html, /id="redDeclareWinnerButton"/);
  assert.match(html, /id="blueDeclareWinnerButton"/);
  assert.match(html, /onclick="openPowerAction\('reboot'\)">REBOOT<\/button>/);
  assert.match(html, /onclick="openPowerAction\('shutdown'\)">SHUTDOWN<\/button>/);
  assert.match(html, /id="powerCountdown"/);
  assert.match(jsText, /remainingMs <= 10000/);
  assert.match(jsText, /startKyeShi/);
  assert.match(jsText, /declareKyeShiWinner/);
  assert.match(jsText, /systemPowerScheduled/);
  assert.match(jsText, /cancelSystemPower/);
  assert.match(jsText, /api\/rules\/apply/);
  assert.match(jsText, /api\/rules\/default/);
  assert.doesNotMatch(jsText, /api\/rules\/rollback/);
  assert.match(jsText, /REMOTE \$\{corner\} DISCONNECTED/);
  assert.match(jsText, /corner <= activeCount/);

  const info = await fetch(`http://127.0.0.1:${port}/api/info`);
  assert.equal(info.status, 404);
});
