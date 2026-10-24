import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as XLSX from 'xlsx';
import vm from 'node:vm';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(projectRoot, 'data', `fixture-import-test-${process.pid}`);
const port = 31000 + (process.pid % 1000);
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
      SFTS_HOST_TOKEN: 'fixture-host-token',
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


const event = { eventName: 'Fixture Championship', eventDate: '2026-10-24', venue: 'Fixture Hall', arenaNumber: '3', competition: 'KYORUGI' };
const fixtureRow = (number, stage, red, blue, weight = 'FLYWEIGHT') => ({
  'Bout Number': number, Stage: stage, Division: 'SENIOR', Gender: 'MALE', 'Weight Category': weight,
  'Hong Name': red, 'Hong Club': red + ' Club', 'Hong State Code': 'WB', 'Hong District': 'Nadia',
  'Chung Name': blue, 'Chung Club': blue + ' Club', 'Chung State Code': 'WB', 'Chung District': 'Nadia'
});
function file(rows, format = 'xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Matches');
  return XLSX.write(book, { type: 'buffer', bookType: format });
}
async function upload(token, rows, { format = 'xlsx', metadata = event } = {}) {
  const headers = { 'Content-Type': 'application/octet-stream', 'X-SFTS-Host-Token': token };
  if (metadata) headers['X-SFTS-Import-Event'] = encodeURIComponent(JSON.stringify(metadata));
  const response = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, { method: 'POST', headers, body: file(rows, format) });
  return { status: response.status, body: await response.json() };
}
test('explicit category fixtures validate atomically and share manual results without advancement', async () => {
  const host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'fixture-host-token' }));
  const role = await waitFor(host, msg => msg.type === 'roleAccepted');
  await waitFor(host, msg => msg.type === 'state');
  const rows = [fixtureRow('SF-B', 'SEMIFINAL', 'A', 'B'), fixtureRow('SF-A', 'SEMIFINAL', 'C', 'D'), fixtureRow('FINAL-9', 'FINAL', 'A', 'D')];
  const action = (action, details = {}) => host.send(JSON.stringify({ type: 'host', action, ...details }));
  for (const format of ['xlsx', 'xls', 'csv']) {
    const imported = await upload(role.hostToken, rows, { format });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.deepEqual(imported.body.tournament.schedule.map(bout => bout.officialBoutNo), ['SF-B', 'SF-A', 'FINAL-9']);
    assert.deepEqual(imported.body.tournament.schedule.map(bout => [bout.redPlayerName, bout.bluePlayerName]), [['A', 'B'], ['C', 'D'], ['A', 'D']]);
    assert.deepEqual(imported.body.tournament.groups, []);
    assert.deepEqual(imported.body.tournament.byes, []);
  }
  const invalidFiles = [
    [rows, { metadata: null }],
    [[{ Name: 'Old roster', Gender: 'M', Division: 'SENIOR' }], {}],
    [[rows[0], { ...rows[1], 'Weight Category': 'FINWEIGHT' }], {}],
    [[rows[0], { ...rows[1], 'Bout Number': 'sf-b' }], {}],
    [[{ ...rows[0], Stage: 'UNKNOWN' }], {}],
    [[{ ...rows[0], 'Hong State Code': 'XX' }], {}],
    [[{ ...rows[0], 'Hong Club': '' }], {}],
    [[{ ...rows[0], 'Hong Name': 'WINNER OF BOUT 1' }], {}],
    [[{ ...rows[0], 'Hong Name': 'X'.repeat(65) }], {}],
    [[{ ...rows[0], 'Chung Name': 'A', 'Chung Club': 'A Club' }], {}],
    [[rows[0]], { metadata: { ...event, eventDate: '2026-02-30' } }],
    [Array.from({ length: 501 }, (_, i) => ({ ...rows[0], 'Bout Number': String(i) })), {}]
  ];
  for (const [input, options] of invalidFiles) {
    const failed = await upload(role.hostToken, input, options);
    assert.equal(failed.status, 400, JSON.stringify(failed.body));
  }
  host.messages.length = 0;
  action('loadBout', { boutNo: 1 });
  const loaded = await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === 1);
  const categoryId = loaded.match.manualBout.categoryId;
  assert.equal(loaded.match.manualBout.stage, 'SEMIFINAL');
  assert.equal(loaded.match.red.club, 'A Club');
  assert.equal(loaded.arenaNumber, '3');
  assert.equal(loaded.tournament.categoryId, categoryId);
  assert.equal((await upload(role.hostToken, rows)).status, 409);
  action('loadBout', { boutNo: 2 });
  assert.equal((await waitFor(host, msg => msg.type === 'error')).code, 'MATCH_BUSY');
  action('resetMatch');
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === null);
  action('loadBout', { boutNo: 1 });
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === 1);
  action('manualMatchDecision', { player: 'RED', decision: 'RSC' });
  await waitFor(host, msg => msg.type === 'matchEnd');
  const semifinal = await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[0].status === 'COMPLETED');
  assert.equal(semifinal.manualCompetition.categories[0].placements.bronze1.playerName, 'B');
  assert.equal(semifinal.tournament.schedule[2].redPlayerName, 'A');
  assert.equal(semifinal.tournament.schedule[2].bluePlayerName, 'D');
  assert.equal(semifinal.tournament.schedule[2].status, 'SCHEDULED');
  const resumed = await upload(role.hostToken, rows);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.tournament.schedule[0].status, 'COMPLETED');
  assert.equal((await upload(role.hostToken, [{ ...rows[0], 'Hong Name': 'Changed' }])).status, 400);
  host.messages.length = 0;
  action('loadBout', { boutNo: 2 });
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === 2);
  action('manualMatchDecision', { player: 'BLUE', decision: 'RSC' });
  await waitFor(host, msg => msg.type === 'matchEnd');
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[1].status === 'COMPLETED');
  action('loadBout', { boutNo: 3 });
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === 3);
  action('manualMatchDecision', { player: 'BLUE', decision: 'RSC' });
  await waitFor(host, msg => msg.type === 'matchEnd');
  const finished = await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[2].status === 'COMPLETED');
  const category = finished.manualCompetition.categories.find(item => item.id === categoryId);
  assert.deepEqual(Object.values(category.placements).map(player => player.playerName), ['D', 'A', 'B', 'C']);
  const archived = await fetch(`http://127.0.0.1:${port}/api/manual/categories?categoryId=${categoryId}`, { headers: { 'X-SFTS-Host-Token': role.hostToken } });
  const archive = await archived.json();
  assert.equal(archive.records.length, 3);
  assert.ok(archive.records.every(record => record.source === 'MANUAL'));
  const reimported = await upload(role.hostToken, rows);
  assert.ok(reimported.body.tournament.schedule.every(bout => bout.status === 'COMPLETED'));
  const newCategory = await upload(role.hostToken, [fixtureRow('OTHER-1', 'FINAL', 'E', 'F', 'FINWEIGHT')]);
  assert.equal(newCategory.status, 200);
  host.messages.length = 0;
  action('loadBout', { boutNo: 1 });
  const next = await waitFor(host, msg => msg.type === 'state' && msg.match.red.playerName === 'E');
  assert.equal(next.manualCompetition.categories.length, 2);
  assert.equal(next.manualCompetition.categories.find(item => item.id === categoryId).placements.gold.playerName, 'D');
  action('resetMatch');
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === null);
  const placements = Object.fromEntries(Object.entries(category.placements).map(([place, player]) => [place, player.key]));
  action('saveManualCategoryPlacements', { categoryId, placements, finalize: true });
  await waitFor(host, msg => msg.type === 'state' && msg.manualCompetition.categories.find(item => item.id === categoryId)?.status === 'FINALIZED');
  assert.equal((await upload(role.hostToken, rows)).status, 400);
});

test('import UI displays supplied sides safely, keeps row order and locks match loading when busy', async () => {
  const [app, html] = await Promise.all([
    readFile(path.join(projectRoot, 'public/js/app.js'), 'utf8'),
    readFile(path.join(projectRoot, 'public/index.html'), 'utf8')
  ]);
  for (const id of ['importDivision', 'importGender', 'importWeightCategory']) assert.ok(html.includes(`id="${id}" readonly`));
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '' });
    return elements.get(id);
  };
  const context = vm.createContext({
    $: get, lastManualCompetition: { categories: [] },
    lastState: { running: false, phase: 'ROUND', roundStarted: false, roundHistory: [], red: { score: 0, gamjeom: 0 }, blue: { score: 0, gamjeom: 0 } }
  });
  for (const [from, to] of [
    ['function renderTournament(', 'async function downloadFile('],
    ['function renderTournamentResults(', 'function downloadTournamentSchedule('],
    ['function escapeHtml(', 'window.openHost =']
  ]) vm.runInContext(app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from))), context);
  const fixture = {
    format: 'IMPORTED_MATCHES', event: { ...event, division: 'SENIOR', gender: 'MALE', weightCategory: 'FLYWEIGHT' },
    activeBoutNo: null, schedule: [
      { boutNo: 1, officialBoutNo: 'SF-B', stage: 'SEMIFINAL', RED: { playerName: '<script>Hong</script>', club: 'Hong & Club' }, BLUE: { playerName: 'Chung', club: 'Blue Club' }, status: 'SCHEDULED' },
      { boutNo: 2, officialBoutNo: 'SF-A', stage: 'SEMIFINAL', RED: { playerName: 'Next Hong', club: 'Club' }, BLUE: { playerName: 'Next Chung', club: 'Club' }, status: 'SCHEDULED' }
    ]
  };
  context.renderTournament(fixture);
  context.renderSchedule(fixture);
  assert.equal(get('importDivision').value, 'SENIOR');
  assert.equal(get('importGender').value, 'MALE');
  assert.equal(get('importWeightCategory').value, 'FLYWEIGHT');
  const table = get('scheduleTable').innerHTML;
  assert.ok(table.indexOf('SF-B') < table.indexOf('SF-A'));
  assert.ok(table.includes('&lt;script&gt;Hong&lt;/script&gt;'));
  assert.ok(table.includes('Hong &amp; Club'));
  assert.ok(!table.includes('<script>'));
  assert.match(table, /HONG \/ RED/);
  assert.match(table, /loadScheduledBout\(1\)/);
  context.lastState.roundStarted = true;
  context.renderSchedule(fixture);
  assert.match(get('scheduleTable').innerHTML, /loadScheduledBout\(1\)" disabled/);
  assert.ok(get('tournamentResultsList').innerHTML.includes('openManualCategoryResults(true)'));
});
