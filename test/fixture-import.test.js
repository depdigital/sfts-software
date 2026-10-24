import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as XLSX from 'xlsx';
import vm from 'node:vm';
import { createFixtureTemplateSheets } from '../src/fixtureTemplate.js';
import { createFileJobs } from '../src/fileJobs.js';
import { readRulesFile } from '../src/rules.js';

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

async function waitForSnapshot(predicate) {
  const deadline = Date.now() + 3000;
  do {
    const checkpoint = JSON.parse(await readFile(path.join(dataDir, 'sfts-state.json'), 'utf8'));
    if (predicate(checkpoint)) return checkpoint;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail('The expected tournament checkpoint was not saved');
}

async function startFixtureServer() {
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
}

before(startFixtureServer);

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
async function upload(token, rows, { format = 'xlsx', metadata = event, preview = false, digest, categoryKey } = {}) {
  const headers = { 'Content-Type': 'application/octet-stream', 'X-SFTS-Host-Token': token };
  if (metadata) headers['X-SFTS-Import-Event'] = encodeURIComponent(JSON.stringify(metadata));
  if (digest) headers['X-SFTS-Import-Digest'] = digest;
  if (categoryKey) headers['X-SFTS-Import-Category'] = categoryKey;
  const response = await fetch(`http://127.0.0.1:${port}/api/tournament/import${preview ? '?preview=true' : ''}`, { method: 'POST', headers, body: file(rows, format) });
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
  await new Promise(resolve => { host.once('close', resolve); host.close(); });
});

test('import UI displays supplied sides safely, keeps row order and locks match loading when busy', async () => {
  const [app, html] = await Promise.all([
    readFile(path.join(projectRoot, 'public/js/app.js'), 'utf8'),
    readFile(path.join(projectRoot, 'public/index.html'), 'utf8')
  ]);
  for (const id of ['importDivision', 'importGender', 'importWeightCategory']) assert.ok(html.includes(`<select id="${id}"`));
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
  assert.match(get('importCategorySummary').textContent, /SENIOR.*MALE.*FLYWEIGHT/);
  assert.match(get('tournamentImportStatus').textContent, /2 MATCHES IN CURRENT CATEGORY/);
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
test('reviewed opening fixture advances locally, corrects winners safely and retains shared medals', async () => {
  const host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'fixture-host-token' }));
  const role = await waitFor(host, msg => msg.type === 'roleAccepted');
  await waitFor(host, msg => msg.type === 'state');
  const metadata = { ...event, eventName: 'Independent Category', autoAdvance: true };
  const rows = Array.from({ length: 8 }, (_, i) => fixtureRow(`PRE-${i + 1}`, 'PRELIMINARY', `A${i}`, `B${i}`));
  const action = (action, details = {}) => host.send(JSON.stringify({ type: 'host', action, ...details }));
  const preview = await upload(role.hostToken, rows, { metadata, preview: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.preview, true);
  assert.equal(preview.body.tournament.schedule.length, 15);
  action('setArenaNumber', { value: '3' });
  const unchanged = await waitFor(host, msg => msg.type === 'state');
  assert.notEqual(unchanged.tournament.event.eventName, metadata.eventName, 'review must not replace the running fixture');
  assert.equal((await upload(role.hostToken, rows, { metadata })).status, 400);
  const digest = preview.body.tournament.sourceDigest;
  assert.equal((await upload(role.hostToken, rows, { metadata: { ...metadata, venue: 'Changed' }, digest })).status, 400);
  const committed = await upload(role.hostToken, rows, { metadata, digest });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  host.messages.length = 0;
  const finish = async (boutNo, winner = 'RED') => {
    action('loadBout', { boutNo });
    const loaded = await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === boutNo);
    assert.equal(loaded.match.manualBout.importedBoutNo, boutNo);
    action('manualMatchDecision', { player: winner, decision: 'RSC' });
    await waitFor(host, msg => msg.type === 'matchEnd');
    return waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[boutNo - 1].status === 'COMPLETED');
  };
  action('loadBout', { boutNo: 2 });
  assert.equal((await waitFor(host, msg => msg.type === 'error')).code, 'BOUT_OUT_OF_ORDER');
  await finish(1);
  const second = await finish(2, 'BLUE');
  assert.equal(second.tournament.schedule[8].RED.playerName, 'A0');
  assert.equal(second.tournament.schedule[8].BLUE.playerName, 'B1');
  action('correctImportedWinner', { boutNo: 1, winner: 'BLUE' });
  const corrected = await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[0].winner === 'BLUE');
  assert.equal(corrected.tournament.schedule[8].RED.playerName, 'B0');
  for (let boutNo = 3; boutNo <= 8; boutNo += 1) await finish(boutNo);
  action('loadBout', { boutNo: 9 });
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === 9);
  action('correctImportedWinner', { boutNo: 1, winner: 'RED' });
  assert.equal((await waitFor(host, msg => msg.type === 'error')).code, 'FOLLOWING_MATCH_STARTED');
  action('manualMatchDecision', { player: 'RED', decision: 'RSC' });
  await waitFor(host, msg => msg.type === 'matchEnd');
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[8].status === 'COMPLETED');
  let completed;
  for (let boutNo = 10; boutNo <= 15; boutNo += 1) completed = await finish(boutNo);
  const category = completed.manualCompetition.categories.find(item => item.id === completed.tournament.categoryId);
  assert.deepEqual(Object.values(category.placements).map(player => player.playerName), ['B0', 'A4', 'A2', 'A6']);
  const response = await fetch(`http://127.0.0.1:${port}/api/manual/categories?categoryId=${category.id}`, { headers: { 'X-SFTS-Host-Token': role.hostToken } });
  const archive = await response.json();
  assert.equal(archive.records.length, 15);
  const firstRecord = archive.records.find(record => record.manualBout.officialBoutNo === 'PRE-1');
  assert.equal(firstRecord.winner, 'BLUE');
  assert.equal(firstRecord.operatorHistory.at(-1).action, 'WINNER CORRECTION');
  const replay = await upload(role.hostToken, rows, { metadata, preview: true });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.ok(replay.body.tournament.schedule.every(bout => bout.status === 'COMPLETED'));
  assert.equal(replay.body.tournament.schedule.at(-1).winnerName, 'B0');
  const byeMetadata = { ...metadata, eventName: 'Three Competitor Category' };
  const byeRows = [fixtureRow('BYE-SF1', 'SEMIFINAL', 'X', 'Y'), {
    ...fixtureRow('BYE-SF2', 'SEMIFINAL', 'Z', 'BYE'), 'Chung Club': '', 'Chung State Code': '', 'Chung District': ''
  }];
  const byePreview = await upload(role.hostToken, byeRows, { metadata: byeMetadata, preview: true });
  assert.equal(byePreview.status, 200, JSON.stringify(byePreview.body));
  const byeCommit = await upload(role.hostToken, byeRows, { metadata: byeMetadata, digest: byePreview.body.tournament.sourceDigest });
  assert.equal(byeCommit.status, 200);
  assert.equal(byeCommit.body.tournament.schedule[1].status, 'BYE');
  host.messages.length = 0;
  const semifinal = await finish(1, 'BLUE');
  assert.equal(semifinal.tournament.schedule[2].BLUE.playerName, 'Z');
  action('saveManualCategoryPlacements', { categoryId: semifinal.tournament.categoryId, placements: { gold: 'Y|Y CLUB', silver: '', bronze1: '', bronze2: '' }, finalize: true });
  assert.equal((await waitFor(host, msg => msg.type === 'error')).code, 'CATEGORY_IN_PROGRESS');
  const byeFinal = await finish(3);
  const byeCategory = byeFinal.manualCompetition.categories.find(item => item.id === byeFinal.tournament.categoryId);
  assert.deepEqual(Object.values(byeCategory.placements).map(player => player?.playerName || null), ['Y', 'Z', 'X', null]);
  const byeArchive = await fetch(`http://127.0.0.1:${port}/api/manual/categories?categoryId=${byeCategory.id}`, { headers: { 'X-SFTS-Host-Token': role.hostToken } });
  assert.equal((await byeArchive.json()).records.length, 2, 'a BYE must not create a fake scored record');
  host.close();
});

test('USB template supports multiple categories and runs all four stages with nine competitors and seven automatic BYEs', async () => {
  const host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'fixture-host-token' }));
  const role = await waitFor(host, msg => msg.type === 'roleAccepted');
  await waitFor(host, msg => msg.type === 'state');
  const headers = {
    'X-SFTS-Host-Token': role.hostToken,
    'Content-Type': 'application/octet-stream',
    'X-SFTS-Import-Event': encodeURIComponent(JSON.stringify({ ...event, eventName: 'Template Test Tournament', autoAdvance: true }))
  };
  const download = await fetch(`http://127.0.0.1:${port}/api/tournament/template.xlsx`, { headers });
  assert.equal(download.status, 403, 'template exports are USB-only');
  const rules = await readRulesFile(path.join(projectRoot, 'config/rules.default.json'));
  const jobs = createFileJobs();
  let buffer;
  try { buffer = Buffer.from(await jobs.run('workbook', { sheets: createFixtureTemplateSheets(rules.tournament.divisions) })); }
  finally { await jobs.close(); }
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Matches', 'Categories', 'Instructions']);
  const allRows = XLSX.utils.sheet_to_json(workbook.Sheets.Matches);
  assert.equal(allRows.length, 11);
  const rows = allRows.filter(row => row.Stage === 'PRELIMINARY');
  assert.equal(rows.length, 8);
  const players = new Map(rows.flatMap(row => ['Hong', 'Chung']
    .filter(side => row[`${side} Name`] !== 'BYE')
    .map(side => [row[`${side} Name`], row[`${side} Club`]])));
  assert.equal(players.size, 9);
  for (const [name, club] of players) {
    assert.doesNotMatch(name, /Demo Player|\d/i);
    assert.doesNotMatch(club, /Demo Club|\d/i);
  }
  const byes = rows.filter(row => row['Chung Name'] === 'BYE');
  assert.equal(byes.length, 7);
  for (const row of byes) {
    for (const field of ['Chung Club', 'Chung State Code', 'Chung District']) assert.equal(row[field] || '', '');
  }
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/tournament/import?preview=true`, { method: 'POST', headers, body: buffer });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.tournament.players.length, 9);
  const categories = preview.workbook.categories;
  assert.equal(categories.length, 4);
  assert.equal(categories.reduce((total, category) => total + category.competitorCount, 0), 15);
  assert.equal(new Set(categories.map(category => category.event.division)).size, 2);
  const primaryDivision = categories.filter(category => category.event.division === categories[0].event.division);
  assert.deepEqual([...new Set(primaryDivision.map(category => category.event.gender))].sort(), ['FEMALE', 'MALE']);
  const maleCategories = primaryDivision.filter(category => category.event.gender === 'MALE');
  assert.equal(maleCategories.length, 2, 'the category dropdown has two options within one division and gender');
  assert.equal(new Set(maleCategories.map(category => category.event.weightCategory || category.event.categoryGroup)).size, 2);
  for (const category of categories.slice(1)) {
    assert.equal(category.competitorCount, 2, 'additional categories use the minimum two competitors');
    assert.equal(category.fixture.schedule.length, 1);
    assert.equal(category.fixture.schedule[0].stage, 'FINAL');
    for (const player of category.fixture.players) {
      assert.doesNotMatch(player.playerName, /Demo Player|\d/i);
      assert.doesNotMatch(player.club, /Demo Club|\d/i);
    }
  }
  assert.equal(preview.tournament.schedule.filter(bout => bout.status === 'BYE').length, 7);
  assert.equal(preview.tournament.schedule.filter(bout => bout.status !== 'BYE').length, 8);
  const startResponse = await fetch(`http://127.0.0.1:${port}/api/tournament/import`, {
    method: 'POST', headers: { ...headers, 'X-SFTS-Import-Digest': preview.tournament.sourceDigest }, body: buffer
  });
  const started = await startResponse.json();
  assert.equal(startResponse.status, 200, JSON.stringify(started));
  host.messages.length = 0;
  let fixture = started.tournament;
  let category;
  const stages = [];
  while (fixture.schedule.some(bout => !['COMPLETED', 'BYE'].includes(bout.status))) {
    const next = fixture.schedule.find(bout => !['COMPLETED', 'BYE'].includes(bout.status));
    assert.equal(next.status, 'SCHEDULED');
    stages.push(next.stage);
    host.send(JSON.stringify({ type: 'host', action: 'loadBout', boutNo: next.boutNo }));
    const loaded = await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === next.boutNo);
    for (const side of ['red', 'blue']) {
      assert.ok(players.has(loaded.match[side].playerName));
      assert.equal(loaded.match[side].club, players.get(loaded.match[side].playerName));
    }
    host.send(JSON.stringify({ type: 'host', action: 'manualMatchDecision', player: 'RED', decision: 'RSC' }));
    await waitFor(host, msg => msg.type === 'matchEnd');
    const completed = await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[next.boutNo - 1].status === 'COMPLETED');
    fixture = completed.tournament;
    category = completed.manualCompetition.categories.find(item => item.id === fixture.categoryId);
  }
  assert.deepEqual(stages, ['PRELIMINARY', 'QUARTERFINAL', 'QUARTERFINAL', 'QUARTERFINAL', 'QUARTERFINAL', 'SEMIFINAL', 'SEMIFINAL', 'FINAL']);
  assert.equal(Object.values(category.placements).filter(Boolean).length, 4);
  const archiveResponse = await fetch(`http://127.0.0.1:${port}/api/manual/categories?categoryId=${category.id}`, { headers });
  const archive = await archiveResponse.json();
  assert.equal(archive.records.length, 8, 'BYEs advance without creating scored records');
  host.close();
});

test('one workbook preserves interleaved category order, independent progress, finalization and loaded-match recovery', async () => {
  // Start with a fresh HTTP rate-limit window after the import rejection tests.
  await waitForSnapshot(snapshot => snapshot.tournament.event?.eventName === 'Template Test Tournament' && snapshot.match.phase === 'MATCH_END' && snapshot.tournament.activeBoutNo === null);
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  await startFixtureServer();
  let host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'fixture-host-token' }));
  let role = await waitFor(host, msg => msg.type === 'roleAccepted');
  await waitFor(host, msg => msg.type === 'state');
  const metadata = { ...event, eventName: 'Combined Tournament', autoAdvance: true };
  const rows = [
    fixtureRow('Z-SF', 'SEMIFINAL', 'Arjun Sen', 'Rohan Das'),
    { ...fixtureRow('FINAL-01', 'FINAL', 'Ananya Mitra', 'Meera Sanyal'), Gender: 'FEMALE' },
    { ...fixtureRow('A-BYE', 'SEMIFINAL', 'Kabir Roy', 'BYE'), 'Chung Club': '', 'Chung State Code': '', 'Chung District': '' },
    { ...fixtureRow('FINAL-01', 'FINAL', 'Ishaan Ghosh', 'Vivaan Dutta', 'FINWEIGHT'), Division: 'JUNIOR' }
  ];
  const reviewed = await upload(role.hostToken, rows, { metadata, preview: true });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const workbook = reviewed.body.workbook;
  assert.equal(workbook.categories.length, 3);
  const [seniorMale, seniorFemale, juniorMale] = workbook.categories;
  assert.deepEqual(seniorMale.fixture.schedule.slice(0, 2).map(bout => bout.officialBoutNo), ['Z-SF', 'A-BYE']);
  assert.equal(seniorMale.fixture.schedule[2].BLUE.playerName, 'Kabir Roy');
  assert.equal(seniorFemale.fixture.schedule[0].officialBoutNo, juniorMale.fixture.schedule[0].officialBoutNo, 'bout references are scoped to their category');
  const commit = await upload(role.hostToken, rows, { metadata, digest: reviewed.body.tournament.sourceDigest, categoryKey: juniorMale.key });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.tournament.event.division, 'JUNIOR');
  assert.equal(commit.body.workbook.selectedKey, juniorMale.key);
  const switchCategory = async (key, workbookId = workbook.sourceDigest) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/tournament/category`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SFTS-Host-Token': role.hostToken },
      body: JSON.stringify({ workbookId, categoryKey: key })
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await switchCategory(seniorMale.key, 'stale-file')).status, 404);
  assert.equal((await switchCategory('unknown-category')).status, 404);
  const malformed = await upload(role.hostToken, [...rows, fixtureRow('EXTRA', 'SEMIFINAL', 'Extra Athlete', 'Other Athlete')], { metadata, preview: true });
  assert.equal(malformed.status, 400, 'an invalid category rejects the complete workbook');
  host.messages.length = 0;
  const action = (action, details = {}) => host.send(JSON.stringify({ type: 'host', action, ...details }));
  const selected = await switchCategory(seniorMale.key);
  assert.equal(selected.status, 200);
  assert.equal(selected.body.tournament.schedule[0].RED.playerName, 'Arjun Sen');
  action('loadBout', { boutNo: 1 });
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === 1 && msg.match.red.playerName === 'Arjun Sen');
  assert.equal((await switchCategory(seniorFemale.key)).status, 409, 'a loaded match blocks category switching');
  assert.equal((await upload(role.hostToken, rows, { metadata, preview: true })).status, 409);
  action('manualMatchDecision', { player: 'BLUE', decision: 'RSC' });
  await waitFor(host, msg => msg.type === 'matchEnd');
  const semifinal = await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[0].status === 'COMPLETED');
  const unfinishedId = semifinal.tournament.categoryId;
  assert.equal(semifinal.tournament.schedule[2].RED.playerName, 'Rohan Das');
  assert.equal(semifinal.tournament.schedule[2].BLUE.playerName, 'Kabir Roy');
  assert.equal((await switchCategory(seniorFemale.key)).status, 200);
  host.messages.length = 0;
  action('loadBout', { boutNo: 1 });
  await waitFor(host, msg => msg.type === 'state' && msg.match.red.playerName === 'Ananya Mitra' && msg.tournament.activeBoutNo === 1);
  action('manualMatchDecision', { player: 'RED', decision: 'RSC' });
  await waitFor(host, msg => msg.type === 'matchEnd');
  const femaleFinal = await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[0].status === 'COMPLETED');
  const femaleCategory = femaleFinal.manualCompetition.categories.find(item => item.id === femaleFinal.tournament.categoryId);
  action('saveManualCategoryPlacements', { categoryId: femaleCategory.id, placements: Object.fromEntries(Object.entries(femaleCategory.placements).map(([key, player]) => [key, player?.key || ''])), finalize: true });
  await waitFor(host, msg => msg.type === 'state' && msg.fixtureWorkbook.categories.find(item => item.key === seniorFemale.key).status === 'FINALIZED');
  assert.equal((await switchCategory(juniorMale.key)).status, 200);
  host.messages.length = 0;
  action('saveManualCategoryPlacements', { categoryId: unfinishedId, placements: {}, finalize: true });
  assert.equal((await waitFor(host, msg => msg.type === 'error')).code, 'CATEGORY_IN_PROGRESS', 'inactive incomplete categories also reject finalization');
  action('loadBout', { boutNo: 1 });
  await waitFor(host, msg => msg.type === 'state' && msg.match.red.playerName === 'Ishaan Ghosh' && msg.tournament.activeBoutNo === 1);
  const checkpoint = await waitForSnapshot(snapshot => snapshot.importedWorkbook?.selectedKey === juniorMale.key && snapshot.tournament.activeBoutNo === 1);
  assert.equal(checkpoint.importedWorkbook.categories.length, 3);
  assert.equal(checkpoint.tournament.activeBoutNo, 1);
  host.close();
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  await startFixtureServer();
  host = await connect();
  host.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'fixture-host-token' }));
  role = await waitFor(host, msg => msg.type === 'roleAccepted');
  const restored = await waitFor(host, msg => msg.type === 'state');
  assert.equal(restored.fixtureWorkbook.categories.length, 3);
  assert.equal(restored.fixtureWorkbook.selectedKey, juniorMale.key);
  assert.equal(restored.tournament.activeBoutNo, 1);
  assert.equal(restored.match.red.playerName, 'Ishaan Ghosh');
  assert.equal(restored.match.running, false);
  assert.equal(restored.fixtureWorkbook.categories.find(item => item.key === seniorFemale.key).status, 'FINALIZED');
  assert.equal((await switchCategory(seniorMale.key)).status, 409);
  action('resetMatch');
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === null);
  const resumed = await switchCategory(seniorMale.key);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.tournament.schedule[0].status, 'COMPLETED');
  assert.equal(resumed.body.tournament.schedule[2].RED.playerName, 'Rohan Das');
  assert.equal(resumed.body.tournament.schedule[2].BLUE.playerName, 'Kabir Roy');
  host.messages.length = 0;
  action('loadBout', { boutNo: 3 });
  await waitFor(host, msg => msg.type === 'state' && msg.tournament.activeBoutNo === 3);
  action('manualMatchDecision', { player: 'BLUE', decision: 'RSC' });
  await waitFor(host, msg => msg.type === 'matchEnd');
  const completed = await waitFor(host, msg => msg.type === 'state' && msg.tournament.schedule[2].status === 'COMPLETED');
  assert.equal(completed.manualCompetition.categories.find(item => item.id === unfinishedId).placements.gold.playerName, 'Kabir Roy');
  const finalized = await switchCategory(seniorFemale.key);
  assert.equal(finalized.status, 200);
  assert.equal(finalized.body.tournament.schedule[0].status, 'COMPLETED');
  const reimport = await upload(role.hostToken, rows, { metadata, preview: true });
  assert.equal(reimport.status, 200, JSON.stringify(reimport.body));
  assert.equal(reimport.body.workbook.categories.find(item => item.key === seniorFemale.key).status, 'FINALIZED');
  host.close();
});
