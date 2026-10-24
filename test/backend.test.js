import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { request } from 'node:http';
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

function connect(options) {
  return new Promise((resolve, reject) => {
    const ws = options ? new WebSocket(url, options) : new WebSocket(url);
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

async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.close();
  await closed;
  clients.delete(ws);
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
      SFTS_KIOSK_MODE: 'true',
      SFTS_AUTH_TIMEOUT_MS: '700',
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

test('compact updates preserve full initial snapshots and refresh bulk data on host changes', async () => {
  const host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'test-host-token', supportsStatePatch: true }));
  await waitForMessage(host, msg => msg.type === 'roleAccepted');
  const initial = await waitForMessage(host, msg => msg.type === 'state');
  assert.ok(initial.tournament);
  assert.ok(initial.manualCompetition);
  const remote = await connect();
  remote.send(JSON.stringify({ type: 'remote_hello', deviceId: 'C4', sessionId: 'compact-state-test', protocolVersion: 2 }));
  await waitForMessage(remote, msg => msg.type === 'remote_ready');
  const patch = await waitForMessage(host, msg => msg.type === 'statePatch');
  assert.ok(patch.match);
  assert.equal(Object.hasOwn(patch, 'tournament'), false);
  host.send(JSON.stringify({ type: 'host', action: 'setArenaNumber', value: '7' }));
  const updated = await waitForMessage(host, msg => msg.type === 'state' && msg.arenaNumber === '7');
  assert.ok(updated.tournament);
  assert.equal(updated.match.red.score, 0);
  host.send(JSON.stringify({ type: 'host', action: 'setArenaNumber', value: '' }));
  await waitForMessage(host, msg => msg.type === 'state' && msg.arenaNumber === '');
  await closeSocket(remote);
  await closeSocket(host);
});

test('WebSocket roles, majority scoring, timer expiry, and phase guards work', async () => {
  await assert.rejects(connect({ headers: { Origin: 'https://example.invalid' } }), /403/);

  const trustedKioskPage = await connect({ headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal((await assign(trustedKioskPage, 'host', 0, '')).type, 'roleAccepted');
  await closeSocket(trustedKioskPage);

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
  const disabledPdfExport = await fetch(`http://127.0.0.1:${port}/api/manual/categories/pdf-usb`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SFTS-Host-Token': hostRole.hostToken
    },
    body: JSON.stringify({ categoryId: 'test-category' })
  });
  assert.equal(disabledPdfExport.status, 403);
  assert.equal((await disabledPdfExport.json()).message, 'USB PDF EXPORT IS DISABLED ON THIS DEPLOYMENT');
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

  const event = { eventName: 'Imported Test Event', eventDate: '2026-10-24', venue: 'Test Hall', arenaNumber: '7', competition: 'KYORUGI' };
  const importHeaders = { 'Content-Type': 'application/octet-stream', 'X-SFTS-Host-Token': hostRole.hostToken, 'X-SFTS-Import-Event': encodeURIComponent(JSON.stringify(event)) };
  const fixtureRow = (bout, red, blue, stage = 'PRELIMINARY', division = 'SUB JUNIOR', weight = 'UNDER 16 KG') => ({
    'Bout Number': bout, Stage: stage, Division: division, Gender: 'MALE', 'Weight Category': weight,
    'Hong Name': red, 'Hong Club': 'Hong Club', 'Chung Name': blue, 'Chung Club': 'Chung Club'
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(Array.from({ length: 4 }, (_, i) => fixtureRow(`B-${i + 1}`, `Red ${i}`, `Blue ${i}`))), 'Matches');
  const workbookBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`)).status, 401);
  const templateResponse = await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`, { headers: { 'X-SFTS-Host-Token': hostRole.hostToken } });
  assert.equal(templateResponse.status, 200);
  const templateBuffer = Buffer.from(await templateResponse.arrayBuffer());
  const templateWorkbook = XLSX.read(templateBuffer, { type: 'buffer' });
  assert.deepEqual(templateWorkbook.SheetNames, ['Matches', 'Categories', 'Instructions']);
  assert.equal(XLSX.utils.sheet_to_json(templateWorkbook.Sheets.Matches).length, 1);
  const templateImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, { method: 'POST', headers: importHeaders, body: templateBuffer });
  assert.equal(templateImport.status, 200);
  await templateImport.arrayBuffer();
  const imported = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, { method: 'POST', headers: importHeaders, body: workbookBuffer });
  assert.equal(imported.status, 200);
  const importedBody = await imported.json();
  assert.equal(importedBody.tournament.format, 'IMPORTED_MATCHES');
  assert.equal(importedBody.tournament.players.length, 8);
  assert.equal(importedBody.tournament.groups.length, 0);
  assert.equal(importedBody.tournament.byes.length, 0);
  assert.equal(importedBody.tournament.schedule.length, 4);
  const firstBout = importedBody.tournament.schedule[0];
  assert.equal(firstBout.redPlayerName, 'Red 0');
  assert.equal(firstBout.bluePlayerName, 'Blue 0');
  const invalidWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(invalidWorkbook, XLSX.utils.json_to_sheet([fixtureRow('BAD', 'Invalid Red', 'Invalid Blue', 'FINAL', 'SUB JUNIOR', 'UNDER 14 KG')]), 'Matches');
  const invalidImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, { method: 'POST', headers: importHeaders, body: XLSX.write(invalidWorkbook, { type: 'buffer', bookType: 'xlsx' }) });
  assert.equal(invalidImport.status, 400);
  assert.ok((await invalidImport.json()).errors.some(error => /weight category/.test(error)));
  const downloaded = await fetch(`http://127.0.0.1:${port}/api/tournament/schedule.xlsx`, { headers: { 'X-SFTS-Host-Token': hostRole.hostToken } });
  assert.equal(downloaded.status, 200);
  const downloadedWorkbook = XLSX.read(Buffer.from(await downloaded.arrayBuffer()), { type: 'buffer' });
  assert.deepEqual(downloadedWorkbook.SheetNames, ['Schedule', 'Results']);
  assert.deepEqual(XLSX.utils.sheet_to_json(downloadedWorkbook.Sheets.Schedule).map(row => row['Bout Number']), ['B-1', 'B-2', 'B-3', 'B-4']);
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

  host.send(JSON.stringify({ type: 'host', action: 'editScore', player: 'RED', value: 1e100 }));
  assert.equal((await waitForMessage(host, msg => msg.type === 'error')).code, 'INVALID_SCORE');

  const firstScoreMessageOrder = [];
  const captureFirstScoreOrder = raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'state' && message.match?.red?.score === 3) firstScoreMessageOrder.push('state');
    if (message.type === 'scoreSound' && message.player === 'RED' && message.points === 3) firstScoreMessageOrder.push('scoreSound');
  };
  host.on('message', captureFirstScoreOrder);
  host.send(JSON.stringify({ type: 'host', action: 'headPoint', player: 'RED' }));
  const normalHeadSound = await waitForMessage(
    host,
    message => message.type === 'scoreSound' && message.player === 'RED' && message.points === 3
  );
  assert.equal(normalHeadSound.basePoints, 3);
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
  const technicalChestSound = await waitForMessage(
    host,
    message => message.type === 'scoreSound' && message.player === 'RED' && message.points === 4
  );
  assert.equal(technicalChestSound.basePoints, 2);
  const manualRedTechnicalChest = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === 7 &&
    message.match.red.stats.plus2 === 0 && message.match.red.stats.technicalChest === 1
  ));
  assert.equal(manualRedTechnicalChest.match.operatorHistory.at(-1).action, 'TECHNICAL CHEST KICK');
  host.send(JSON.stringify({ type: 'host', action: 'technicalPoint', player: 'BLUE', basePoints: 3 }));
  const technicalHeadSound = await waitForMessage(
    host,
    message => message.type === 'scoreSound' && message.player === 'BLUE' && message.points === 6
  );
  assert.equal(technicalHeadSound.basePoints, 3);
  const manualBlueTechnicalHead = await waitForMessage(host, message => (
    message.type === 'state' && message.match.blue.score === 9 &&
    message.match.blue.stats.plus3 === 1 && message.match.blue.stats.technicalHead === 1
  ));
  assert.equal(manualBlueTechnicalHead.match.operatorHistory.at(-1).action, 'TECHNICAL HEAD KICK');

  host.send(JSON.stringify({
    type: 'host', action: 'correctScoringAction', player: 'RED', direction: 'ADD', actionKey: 'NORMAL_1'
  }));
  const addedMissedPunch = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === 8 && message.match.red.stats.plus1 === 1
  ));
  assert.equal(addedMissedPunch.match.operatorHistory.at(-1).action, 'ADD MISSED PUNCH');
  assert.deepEqual(addedMissedPunch.match.operatorHistory.at(-1).details, {
    type: 'SCORING_ACTION_CORRECTION',
    direction: 'ADD',
    actionKey: 'NORMAL_1',
    basePoints: 1,
    awardedPoints: 1,
    technical: false,
    stat: 'plus1',
    statFrom: 0,
    statTo: 1
  });

  host.send(JSON.stringify({
    type: 'host', action: 'correctScoringAction', player: 'RED', direction: 'REMOVE', actionKey: 'NORMAL_1'
  }));
  await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === 7 && message.match.red.stats.plus1 === 0
  ));

  host.send(JSON.stringify({
    type: 'host', action: 'correctScoringAction', player: 'BLUE', direction: 'ADD', actionKey: 'TECHNICAL_2'
  }));
  const addedTechnicalChest = await waitForMessage(host, message => (
    message.type === 'state' && message.match.blue.score === 13 && message.match.blue.stats.technicalChest === 1
  ));
  assert.equal(addedTechnicalChest.match.operatorHistory.at(-1).details.awardedPoints, 4);
  host.send(JSON.stringify({
    type: 'host', action: 'correctScoringAction', player: 'BLUE', direction: 'REMOVE', actionKey: 'TECHNICAL_2'
  }));
  await waitForMessage(host, message => (
    message.type === 'state' && message.match.blue.score === 9 && message.match.blue.stats.technicalChest === 0
  ));

  host.send(JSON.stringify({ type: 'host', action: 'correctGamjeom', player: 'RED', direction: 'ADD' }));
  const addedGamjeomCorrection = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.gamjeom === 1 && message.match.blue.score === 10
  ));
  assert.equal(addedGamjeomCorrection.match.operatorHistory.at(-1).details.opponentPointValue, 1);
  host.send(JSON.stringify({ type: 'host', action: 'correctGamjeom', player: 'RED', direction: 'REMOVE' }));
  await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.gamjeom === 0 && message.match.blue.score === 9
  ));

  host.send(JSON.stringify({
    type: 'host', action: 'advancedScoreCorrection', player: 'RED', value: 11, reason: ''
  }));
  const missingCorrectionReason = await waitForMessage(host, message => message.type === 'error');
  assert.equal(missingCorrectionReason.code, 'CORRECTION_REASON_REQUIRED');
  host.send(JSON.stringify({
    type: 'host', action: 'advancedScoreCorrection', player: 'RED', value: 11,
    reason: 'Recovery after verified scoreboard interruption'
  }));
  const advancedScoreCorrection = await waitForMessage(host, message => (
    message.type === 'state' && message.match.red.score === 11
  ));
  assert.equal(advancedScoreCorrection.match.red.stats.technicalChest, 1);
  assert.deepEqual(advancedScoreCorrection.match.operatorHistory.at(-1).details, {
    type: 'ADVANCED_SCORE_CORRECTION',
    reason: 'Recovery after verified scoreboard interruption',
    scoreOnly: true
  });

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
  const remoteTechnicalChestSound = await waitForMessage(
    host,
    message => message.type === 'scoreSound' && message.player === 'RED' && message.points === 4
  );
  assert.equal(remoteTechnicalChestSound.basePoints, 2);
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
  technicalRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1', sequence: 5, button: 'BLUE_1'
  }));
  assert.equal(
    (await waitForMessage(technicalRemote, message => message.type === 'remote_event_ack' && message.sequence === 5)).reason,
    'POINT_AWARDED'
  );
  await waitForMessage(host, message => message.type === 'state' && message.match.blue.score === 1);
  technicalRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1', sequence: 6, button: 'BLUE_1'
  }));
  const rapidRepeatAck = await waitForMessage(technicalRemote, message => message.type === 'remote_event_ack' && message.sequence === 6);
  assert.equal(rapidRepeatAck.reason, 'POINT_AWARDED');
  assert.equal((await waitForMessage(host, message => message.type === 'scoreUpdate' &&
    message.blueScore === 2)).blueScore, 2);
  await waitForMessage(host, message => message.type === 'state' && message.match.blue.score === 2);
  technicalRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1', sequence: 6, button: 'BLUE_1'
  }));
  assert.deepEqual(
    await waitForMessage(technicalRemote, message => message.type === 'remote_event_ack' && message.sequence === 6),
    rapidRepeatAck
  );
  technicalRemote.close();
  await waitForMessage(host, message => message.type === 'state' && message.remotes?.find(remoteStatus => (
    remoteStatus.deviceId === 'C1' && remoteStatus.connected === false
  )));
  const versionTwoRemote = await connect();
  versionTwoRemote.send(JSON.stringify({
    type: 'remote_hello', protocolVersion: 2, deviceId: 'C1', sessionId: 'test-session-c1-v2', firmware: 'test-v2'
  }));
  assert.equal((await waitForMessage(versionTwoRemote, message => message.type === 'remote_ready')).protocolVersion, 2);
  await waitForMessage(versionTwoRemote, message => message.type === 'remote_state');
  versionTwoRemote.send(JSON.stringify({
    type: 'remote_status', deviceId: 'C1', sessionId: 'test-session-c1-v2',
    rssi: -61, battery: 74, outboxDepth: 2, droppedInputs: 0,
    droppedEvents: 1, retryCount: 3, reconnectCount: 2, lastAckSequence: 6
  }));
  await waitForMessage(versionTwoRemote, message => message.type === 'remote_status_ack');
  const deliveryState = await waitForMessage(host, message => message.type === 'state' &&
    message.remotes?.find(remoteStatus => remoteStatus.deviceId === 'C1')?.outboxDepth === 2);
  assert.equal(deliveryState.remotes.find(remoteStatus => remoteStatus.deviceId === 'C1').droppedEvents, 1);
  assert.equal(deliveryState.remotes.find(remoteStatus => remoteStatus.deviceId === 'C1').protocolVersion, 2);
  versionTwoRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-v2', sequence: 1,
    button: 'BLUE_TECHNICAL_2', ageMs: 0
  }));
  assert.equal(
    (await waitForMessage(versionTwoRemote, message => message.type === 'remote_event_ack' && message.sequence === 1)).reason,
    'POINT_AWARDED'
  );
  await waitForMessage(host, message => message.type === 'state' && message.match.blue.score === 6);
  versionTwoRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-v2', sequence: 2,
    button: 'BLUE_1', ageMs: 2501
  }));
  const expiredAck = await waitForMessage(versionTwoRemote, message => message.type === 'remote_event_ack' && message.sequence === 2);
  assert.equal(expiredAck.reason, 'EVENT_EXPIRED');
  assert.equal((await waitForMessage(host, message => message.type === 'remoteRejected' &&
    message.corner === 1 && message.sequence === 2)).reason, 'EVENT_EXPIRED');
  versionTwoRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-v2', sequence: 2,
    button: 'BLUE_1', ageMs: 0
  }));
  assert.deepEqual(
    await waitForMessage(versionTwoRemote, message => message.type === 'remote_event_ack' && message.sequence === 2),
    expiredAck
  );
  versionTwoRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-v2', sequence: 4,
    button: 'BLUE_1', ageMs: 0
  }));
  assert.equal(
    (await waitForMessage(versionTwoRemote, message => message.type === 'remote_event_ack' && message.sequence === 4)).reason,
    'POINT_AWARDED'
  );
  versionTwoRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-v2', sequence: 3,
    button: 'BLUE_1', ageMs: 0
  }));
  assert.equal(
    (await waitForMessage(versionTwoRemote, message => message.type === 'remote_event_ack' && message.sequence === 3)).reason,
    'POINT_AWARDED'
  );
  await waitForMessage(host, message => message.type === 'state' && message.match.blue.score === 8);
  const replacementRemote = await connect();
  replacementRemote.send(JSON.stringify({
    type: 'remote_hello', protocolVersion: 2, deviceId: 'C1', sessionId: 'test-session-c1-reboot', firmware: 'test-v2'
  }));
  assert.equal((await waitForMessage(replacementRemote, message => message.type === 'remote_ready')).sessionId, 'test-session-c1-reboot');
  await waitForMessage(replacementRemote, message => message.type === 'remote_state');
  replacementRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-reboot', sequence: 1,
    button: 'BLUE_1', ageMs: 0
  }));
  assert.equal(
    (await waitForMessage(replacementRemote, message => message.type === 'remote_event_ack' && message.sequence === 1)).reason,
    'POINT_AWARDED'
  );
  await waitForMessage(host, message => message.type === 'state' && message.match.blue.score === 9);
  host.send(JSON.stringify({ type: 'host', action: 'testStart' }));
  await waitForMessage(host, message => message.type === 'state' && message.match.test.active);
  replacementRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-reboot', sequence: 2,
    button: 'RED_TECHNICAL', ageMs: 0
  }));
  assert.equal((await waitForMessage(replacementRemote, message =>
    message.type === 'remote_event_ack' && message.sequence === 2)).reason, 'TECHNICAL_PENDING');
  const pendingTest = await waitForMessage(host, message => message.type === 'state' && message.match.test.active);
  assert.equal(pendingTest.match.test.presses['1-RED_TECHNICAL'], undefined);
  replacementRemote.send(JSON.stringify({
    type: 'remote_event', deviceId: 'C1', sessionId: 'test-session-c1-reboot', sequence: 3,
    button: 'RED_TECHNICAL_3', ageMs: 0
  }));
  assert.equal((await waitForMessage(host, message => message.type === 'testPress' &&
    message.button === 'RED_TECHNICAL_3')).points, 6);
  await waitForMessage(host, message => message.type === 'state' &&
    message.match.test.presses['1-RED_TECHNICAL_3'] && message.match.blue.score === 9);
  host.send(JSON.stringify({ type: 'host', action: 'testStop' }));
  await waitForMessage(host, message => message.type === 'state' && !message.match.test.active);
  replacementRemote.close();
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

  const bracketWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(bracketWorkbook, XLSX.utils.json_to_sheet([
    fixtureRow('P1', 'Bracket One', 'Bracket Five', 'PRELIMINARY', 'SENIOR', 'FLYWEIGHT'),
    fixtureRow('S2', 'Bracket Three', 'Bracket Four', 'SEMIFINAL', 'SENIOR', 'FLYWEIGHT'),
    fixtureRow('S3', 'Bracket One', 'Bracket Two', 'SEMIFINAL', 'SENIOR', 'FLYWEIGHT'),
    fixtureRow('F4', 'Bracket One', 'Bracket Four', 'FINAL', 'SENIOR', 'FLYWEIGHT')
  ]), 'Matches');
  const bracketImport = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST', headers: importHeaders, body: XLSX.write(bracketWorkbook, { type: 'buffer', bookType: 'xlsx' })
  });
  assert.equal(bracketImport.status, 200);
  const bracketBody = await bracketImport.json();
  assert.equal(bracketBody.tournament.format, 'IMPORTED_MATCHES');
  assert.equal(bracketBody.tournament.schedule.length, 4);
  assert.equal(bracketBody.tournament.byes.length, 0);
  assert.ok(bracketBody.tournament.schedule.every(bout => bout.status === 'SCHEDULED'));
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
  assert.equal(advancedBout.redPlayerName, 'Bracket One');
  assert.equal(advancedBout.redSourceBoutNo, undefined);

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
  assert.equal(tied.tournament.schedule.find(bout => bout.boutNo === 4).status, 'SCHEDULED');
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
    message.type === 'state' && message.tournament.schedule[3].status === 'COMPLETED'
  ));
  const completedGroup = categoryComplete.manualCompetition.categories.find(category => category.id === categoryComplete.tournament.categoryId);
  assert.equal(completedGroup.placements.gold.playerName, finalBout.bluePlayerName);
  assert.equal(completedGroup.placements.silver.playerName, finalBout.redPlayerName);
  assert.equal(completedGroup.placements.bronze1.playerName, 'Bracket Three');
  assert.equal(completedGroup.placements.bronze2.playerName, 'Bracket Two');

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

test('browser origin, DNS rebinding and malformed coercions cannot bypass the backend boundary', async () => {
  const spoofedStatus = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}/`, { headers: { Host: `attacker.invalid:${port}` } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(spoofedStatus, 403);
  const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/manual/categories`, {
    headers: { Origin: 'https://attacker.invalid', 'X-SFTS-Host-Token': 'test-host-token' }
  });
  assert.equal(crossOrigin.status, 403);
  const validPage = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(validPage.status, 200);
  assert.equal(validPage.headers.get('x-content-type-options'), 'nosniff');
  assert.match(validPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const client = await connect();
  client.send(JSON.stringify({ type: 'role', role: 'host', corner: { valueOf: null, toString: null } }));
  assert.equal((await waitForMessage(client, msg => msg.type === 'error')).code, 'INVALID_MESSAGE');
  client.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'wrong-token' }));
  assert.equal((await waitForMessage(client, msg => msg.type === 'error')).code, 'HOST_UNAUTHORIZED');
  await closeSocket(client);
});

test('idle unauthenticated sockets expire while authenticated remotes remain usable', async () => {
  const idle = await connect();
  const closed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Unauthenticated socket did not expire')), 2000);
    idle.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(closed, 1006);
  clients.delete(idle);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});

test('HTTP static endpoint is available and QR endpoint is removed', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /STRIKE FORCE TAEKWONDO SCORING SYSTEM/);
  assert.match(html, /class="homeSportsIntro" src="\/assets\/sfsports-logo-launch\.png" width="720" height="489"/);
  assert.match(html, /SFTS v3\.0\.0[\s\S]*AN SF SPORTS PRODUCT/);
  assert.match(html, /&copy; 2026 SF SPORTS\. ALL RIGHTS RESERVED\./);
  assert.doesNotMatch(html, /Official technology partner/i);
  assert.doesNotMatch(html, /class="homeSportsBy"/);
  assert.doesNotMatch(html, /Powered by Strike Force Combat Academy/i);
  assert.match(html, /id="playerSheetFile"/);
  assert.match(html, /id="manualEntryModal"/);
  assert.match(html, /id="manualWizardSteps"/);
  assert.match(html, /id="manualWizardReview"/);
  assert.match(html, /id="manualDeleteCategoryButton"/);
  assert.match(html, /id="manualDeleteCategoryModal"/);
  assert.match(html, /id="manualDeleteCategoryConfirmation"/);
  assert.match(html, /id="dataImportModal"/);
  assert.match(html, /id="manualCategoryResultsModal"/);
  assert.match(html, /id="manualIncludeBoutSummary"/);
  assert.match(html, /id="manualIncludeFullAudit"/);
  assert.match(html, /id="manualIncludeCornerRefereeHistory"/);
  assert.match(html, /id="manualToggleReportPreviewButton"/);
  assert.match(html, /id="manualPdfUsbStatus"/);
  assert.match(html, /id="manualSavePdfButton"[^>]*onclick="saveManualCategoryPdfToUsb\(\)"/);
  assert.doesNotMatch(html, /onclick="printManualCategory\(\)"/);
  assert.doesNotMatch(html, /id="manualPrintSummaryButton"/);
  assert.doesNotMatch(html, /id="manualPrintFullButton"/);
  assert.match(html, /id="manualPlacementSource"/);
  assert.match(html, />NEXT BOUT IN THIS CATEGORY</);
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
  assert.match(html, /onclick="openCornerEditor\('RED'\)">CORRECT HONG<\/button>/);
  assert.match(html, /onclick="openCornerEditor\('BLUE'\)">CORRECT CHUNG<\/button>/);
  assert.match(html, /id="cornerEditModal"/);
  assert.match(html, /onclick="openScoringCorrection\('ADD'\)">ADD MISSED SCORING ACTION<\/button>/);
  assert.match(html, /onclick="openScoringCorrection\('REMOVE'\)">REMOVE WRONG SCORING ACTION<\/button>/);
  const appScriptResponse = await fetch(`http://127.0.0.1:${port}/js/app.js`);
  assert.equal(appScriptResponse.status, 200);
  const appScript = await appScriptResponse.text();
  assert.match(appScript, /\/samples\/punch_sample\.wav/);
  assert.match(appScript, /\/samples\/chest_kick_sample\.wav/);
  assert.match(appScript, /\/samples\/head_kick_sample\.wav/);
  assert.match(appScript, /\/samples\/round_over\.wav/);
  assert.match(appScript, /\/samples\/ss-track\.wav/);
  assert.match(appScript, /screensaverSoundPlayer\.loop = true/);
  assert.match(appScript, /setScreensaverSoundPlaying\(visible\)/);
  for (const sample of ['punch_sample.wav', 'chest_kick_sample.wav', 'head_kick_sample.wav', 'round_over.wav', 'ss-track.wav']) {
    const response = await fetch(`http://127.0.0.1:${port}/samples/${sample}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /audio\/wav/);
    assert.ok((await response.arrayBuffer()).byteLength > 44);
  }
  assert.match(appScript, /window\.saveManualCategoryPdfToUsb = saveManualCategoryPdfToUsb;/);
  assert.match(appScript, /window\.refreshManualPdfUsbStatus = refreshManualPdfUsbStatus;/);
  assert.match(appScript, /<span>TECHNICAL OFFICIAL<\/span><span>ARENA INCHARGE<\/span><span>ORGANIZER<\/span>/);
  assert.doesNotMatch(appScript, /REFEREE CHAIR|FEDERATION REPRESENTATIVE/);
  assert.doesNotMatch(appScript, /window\.printManualCategory/);
  assert.match(html, /onclick="correctSelectedGamjeom\('ADD'\)">ADD MISSED GAM-JEOM<\/button>/);
  assert.match(html, /onclick="correctSelectedGamjeom\('REMOVE'\)">REMOVE WRONG GAM-JEOM<\/button>/);
  assert.match(html, /onclick="openAdvancedCorrections\(\)">ADVANCED CORRECTIONS<\/button>/);
  assert.match(html, /id="advancedCorrectionsModal"/);
  assert.match(html, /id="advancedCorrectionReason"/);
  assert.match(html, /Scoring-action counts and Gam-jeom totals will not change/);
  assert.doesNotMatch(html, /ADVANCED SCORE ADJUSTMENT/);
  assert.doesNotMatch(html, /onclick="editGam\('/);
  assert.doesNotMatch(html, /EDIT KICK COUNTS/);
  assert.match(html, /onclick="startGoldenRound\(\)"/);
  assert.match(html, /PROCEED TO GOLDEN ROUND \(ROUND 4\)/);
  assert.match(html, /onclick="backFromTieDecision\(\)"/);
  assert.match(html, /DECLARE "HONG" WINNER/);
  assert.match(html, /DECLARE "CHUNG" WINNER/);
  assert.match(html, /id="matchDecisionModal"/);
  assert.match(html, /id="screensaver"/);
  assert.match(html, /class="screensaverLogo screensaverSftsLogo" src="\/assets\/sfts-logo\.png"/);
  assert.match(html, /class="screensaverLogo screensaverSportsLogo" src="\/assets\/sfsports-logo-launch\.png"/);
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
  assert.match(cssText, /\.homeSportsIntro\s*\{[^}]*animation:\s*homeSportsBrandSequence 10s ease-in-out infinite/);
  assert.match(cssText, /\.homeBrandSequence\s*\{[^}]*height:\s*min\(60vh, 960px\)[^}]*overflow:\s*hidden/);
  assert.match(cssText, /\.homeSportsIntro\s*\{[^}]*width:\s*min\(56vw, 980px\)[^}]*max-height:\s*75%[^}]*object-fit:\s*contain/);
  assert.doesNotMatch(cssText, /\.homeSportsIntro\s*\{[^}]*filter:/);
  assert.match(cssText, /\.homeSftsSequence\s*\{[^}]*animation:\s*homeSftsBrandSequence 10s ease-in-out infinite/);
  assert.match(cssText, /@keyframes homeSftsBrandSequence/);
  assert.match(cssText, /\.homeLogo\s*\{[^}]*width:\s*min\(1500px, 100%\)/);
  assert.doesNotMatch(cssText, /\.screensaver\s*\{[^}]*transition:/);
  assert.match(cssText, /\.screensaver\.visible \.screensaverSftsLogo\s*\{[^}]*animation: screensaverSftsLogoCycle 10s ease-in-out infinite/);
  assert.match(cssText, /\.screensaverSportsLogo\s*\{[^}]*width: min\(42vw, 560px\)[^}]*max-height: 40vh/);
  assert.match(cssText, /\.screensaver\.visible \.screensaverSportsLogo\s*\{[^}]*animation: screensaverSportsLogoCycle 10s linear infinite/);
  assert.match(cssText, /\.homeBtn::before[\s\S]*animation: homeLaunchGlow 1\.45s ease-in-out infinite/);
  assert.match(cssText, /\.homeBtn:active[\s\S]*scale\(0\.985\)/);
  assert.match(cssText, /@keyframes homeLaunchGlow/);
  assert.match(cssText, /screensaverSftsLogoCycle[\s\S]*40%[\s\S]*transform: scale\(2\.5\)/);
  assert.match(cssText, /screensaverSportsLogoCycle[\s\S]*49\.99%[\s\S]*opacity: 0[\s\S]*50%[\s\S]*99\.99%[\s\S]*opacity: 1/);
  assert.match(cssText, /\.controlGrid button[\s\S]*cursor: pointer/);
  assert.match(cssText, /\.controlGrid\s*\{[^}]*grid-template-columns:\s*repeat\(6, 1fr\)/);
  assert.match(cssText, /\.controlGrid \.secondaryControl\s*\{[^}]*grid-column:\s*span 3/);
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
  assert.match(jsText, /AUTOMATIC_SCREENSAVER_BREAK_MS = 35_000/);
  assert.match(jsText, /AUTOMATIC_SCREENSAVER_DELAY_MS = 15_000/);
  assert.match(jsText, /syncAutomaticBreakScreensaver\(lastState\)/);
  assert.match(jsText, /if \(automaticScreensaverStarted\) setScreensaverVisible\(false\)/);
  assert.match(jsText, /ws\.onclose/);
  assert.match(jsText, /reconnectDelay/);
  assert.match(jsText, /renderRemoteStatuses/);
  assert.match(jsText, /renderTieDecision\(match\)/);
  assert.match(jsText, /function backFromTieDecision\(\)/);
  assert.match(jsText, /decideGoldenRoundSuperiority/);
  assert.match(jsText, /ROUND_WOO_SE_GIROK/);
  assert.match(jsText, /MATCH_WOO_SE_GIROK/);
  assert.match(jsText, /function scoringCorrectionDefinitions\(\)/);
  assert.match(jsText, /scoringRules\?\.basePointLabels/);
  assert.match(jsText, /technicalInput\.pointsByBasePoints/);
  assert.match(jsText, /action: "correctScoringAction"/);
  assert.match(jsText, /action: "correctGamjeom"/);
  assert.match(jsText, /action: "advancedScoreCorrection"/);
  assert.match(jsText, /function manualWizardValidation\(step\)/);
  assert.match(jsText, /action: "deleteManualCategory"/);
  assert.match(jsText, /function manualCategoryDeleteConfirmationPhrase\(category\)/);
  assert.match(jsText, /deleteRecords: Boolean\(confirmation\)/);
  assert.match(serverSource, /function correctScoringAction\(player, direction, actionKey\)/);
  assert.match(serverSource, /function deleteManualCategory\(categoryId, \{ deleteRecords = false, confirmation = '' \} = \{\}\)/);
  assert.match(serverSource, /MANUAL_CATEGORY_DELETE_CONFIRMATION_REQUIRED/);
  assert.match(serverSource, /SCORING_ACTION_CORRECTION/);
  assert.match(serverSource, /CORRECTION_REASON_REQUIRED/);
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
  assert.match(html, /id="roundSummaryScoreboardButton" class="hidden"/);
  assert.match(jsText, /roundSummaryScoreboardButton\?\.classList\.toggle\("hidden", match\.phase === "BREAK"\)/);
  assert.match(jsText, /match\.phase === "ROUND" && !match\.roundStarted[\s\S]*roundOverlay[\s\S]*classList\.add\("hidden"\)/);
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

test('restart stack refreshes missing production dependencies before restarting services', async () => {
  const script = await readFile(path.join(projectRoot, 'deployment', 'scripts', 'restart-stack.sh'), 'utf8');
  const dependencyInstall = script.indexOf('ci --omit=dev');
  const scoreboardRestart = script.indexOf('systemctl restart "${SCOREBOARD_SERVICE}"');
  assert.ok(dependencyInstall >= 0, 'restart script must install production dependencies when required');
  assert.ok(scoreboardRestart > dependencyInstall, 'dependencies must be installed before the scoreboard restarts');
  assert.match(script, /runuser -u "\$\{SERVICE_USER\}"/);
  assert.match(script, /npm is not installed/);
});

test('kiosk deployment blocks browser escapes and installs recovery controls', async () => {
  const [launcher, labwcConfig, policyTemplate, installer, restartScript, appScript, html] = await Promise.all([
    readFile(path.join(projectRoot, 'deployment', 'scripts', 'start-kiosk.sh'), 'utf8'),
    readFile(path.join(projectRoot, 'deployment', 'config', 'labwc-kiosk-rc.xml'), 'utf8'),
    readFile(path.join(projectRoot, 'deployment', 'config', 'chromium-kiosk-policy.json'), 'utf8'),
    readFile(path.join(projectRoot, 'deployment', 'install.sh'), 'utf8'),
    readFile(path.join(projectRoot, 'deployment', 'scripts', 'restart-stack.sh'), 'utf8'),
    readFile(path.join(projectRoot, 'public', 'js', 'app.js'), 'utf8'),
    readFile(path.join(projectRoot, 'public', 'index.html'), 'utf8')
  ]);

  for (const key of ['C-t', 'C-n', 'C-l', 'C-w', 'C-S-j', 'C-o', 'C-p', 'S-Escape', 'Menu', 'F6']) {
    assert.ok(labwcConfig.includes(`<keybind key="${key}" />`), `missing blocked kiosk key: ${key}`);
  }
  assert.match(labwcConfig, /key="C-A-S-r"[\s\S]*pkill[\s\S]*sfts-scoreboard-kiosk/);

  const policy = JSON.parse(policyTemplate.replaceAll('@PORT@', '8080'));
  assert.deepEqual(policy.URLBlocklist, ['*']);
  assert.ok(policy.URLAllowlist.includes('http://127.0.0.1:8080'));
  assert.equal(policy.NewTabPageLocation, 'http://127.0.0.1:8080/');
  assert.equal(policy.DeveloperToolsAvailability, 2);
  assert.equal(policy.IncognitoModeAvailability, 1);
  assert.equal(policy.BrowserGuestModeEnabled, false);
  assert.deepEqual(policy.ExtensionInstallBlocklist, ['*']);

  assert.match(launcher, /Chromium exited with status/);
  assert.match(launcher, /\|\| browser_status=/);
  assert.match(launcher, /--disable-background-mode/);
  assert.match(installer, /sfts-scoreboard-kiosk\.json/);
  assert.match(installer, /while true; do .*KIOSK_SCRIPT.*sleep 2; done &/);
  assert.match(restartScript, /Installing Chromium kiosk policies/);
  assert.match(restartScript, /KIOSK_AUTOSTART_DEST/);
  assert.match(restartScript, /while true; do .*KIOSK_SCRIPT.*sleep 2; done &/);
  assert.match(appScript, /event\.ctrlKey[\s\S]*event\.altKey[\s\S]*event\.metaKey[\s\S]*event\.shiftKey/);
  assert.match(appScript, /addEventListener\("contextmenu"/);
  assert.match(appScript, /addEventListener\("drop"/);
  assert.match(html, /id="serverConnectionStatus"/);
});
