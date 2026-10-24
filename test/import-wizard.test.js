import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function node(classes = '') {
  const values = new Set(classes.split(/\s+/));
  let markup = '';
  const attributes = new Map();
  const result = {
    value: '', textContent: '', disabled: false, children: [],
    classList: {
      add: (...names) => names.forEach(name => values.add(name)),
      remove: (...names) => names.forEach(name => values.delete(name)),
      contains: name => values.has(name),
      toggle(name, on) { if (on) values.add(name); else values.delete(name); }
    },
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key)
  };
  Object.defineProperty(result, 'innerHTML', {
    get: () => markup,
    set(value) { markup = value; result.value = /<option value="([^"]+)"/.exec(value)?.[1] || ''; }
  });
  return result;
}

async function wizard() {
  const [html, app, script] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/importWizard.js', import.meta.url), 'utf8')
  ]);
  const nodes = new Map([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, node(/class="([^"]*)"/.exec(tag)?.[1])]));
  nodes.get('importWizardSteps').children = Array.from({ length: 5 }, () => node());
  const get = id => nodes.get(id);
  const event = { eventName: 'Wizard Championship', eventDate: '2026-10-24', venue: 'Hall', arenaNumber: '1', competition: 'KYORUGI', division: 'SENIOR', gender: 'MALE', weightCategory: 'FLYWEIGHT', categoryGroup: '' };
  for (const [id, key] of [['importEventName', 'eventName'], ['importEventDate', 'eventDate'], ['importVenue', 'venue'], ['importArenaNumber', 'arenaNumber'], ['importCompetition', 'competition']]) get(id).value = event[key];
  const player = name => ({ playerName: name, club: name + ' Club' });
  const fixture = {
    format: 'IMPORTED_MATCHES', progressionMode: 'OPENING_FIXTURE', event, players: [player('A'), player('B'), player('C')],
    categoryId: null, sourceDigest: 'reviewed-file', activeBoutNo: null, openingBoutCount: 2,
    schedule: [
      { boutNo: 1, officialBoutNo: 'SF-1', stage: 'SEMIFINAL', round: 1, RED: player('<A>'), BLUE: player('B'), status: 'SCHEDULED' },
      { boutNo: 2, officialBoutNo: 'SF-BYE', stage: 'SEMIFINAL', round: 1, RED: player('C'), BLUE: null, status: 'BYE' },
      { boutNo: 3, officialBoutNo: 'AUTO-R2-001', stage: 'FINAL', round: 2, RED: null, BLUE: player('C'), status: 'PENDING' }
    ]
  };
  const requests = [], actions = [], openings = [];
  const context = vm.createContext({
    $: get, document: { getElementById: get }, hostToken: 'host-session', ws: { readyState: 1 }, usbImportOnly: false,
    lastTournament: {}, lastManualCompetition: { categories: [] }, lastState: null,
    send: action => actions.push(action), toast() {}, refreshUsbFiles() {},
    requestUserPermission: async () => true,
    renderTournament() {}, closeMatchDecision() {},
    openDataImport: () => openings.push('import'),
    winnerReasonDescription: reason => reason,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, tournament: JSON.parse(JSON.stringify(fixture)) }) };
    }
  });
  vm.runInContext(script, context);
  for (const [start, end] of [
    ['function importEventDetails()', 'async function importUsbFile()'],
    ['function escapeHtml(', 'window.openHost ='],
    ['function showWinnerSlide(', 'function openTestMode()']
  ]) vm.runInContext(app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))), context);
  get('dataImportModal').classList.remove('hidden');
  return { context, get, fixture, requests, actions, openings };
}

function visibleSteps(get) {
  return Array.from({ length: 5 }, (_, i) => i).filter(i => !get(`importStep${i}`).classList.contains('hidden'));
}

test('decision cards validate the event and show one step at a time', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const eventCard = html.slice(html.indexOf('<section id="importStep0"'), html.indexOf('<section id="importStep1"'));
  assert.match(eventCard, /<button onclick="downloadPlayerTemplate\(\)">SAVE TEMPLATE TO US<\/button>/);
  const { context, get, requests } = await wizard();
  context.setImportStep(0);
  assert.deepEqual(visibleSteps(get), [0]);
  get('importArenaNumber').value = '0';
  context.importEventNext();
  assert.deepEqual(visibleSteps(get), [0]);
  assert.ok(!get('importWizardError').classList.contains('hidden'));
  get('importArenaNumber').value = '1';
  context.importEventNext();
  assert.deepEqual(visibleSteps(get), [1]);
  assert.equal(requests.length, 0);
  context.setImportStep(2);
  assert.deepEqual(visibleSteps(get), [1], 'review cannot be opened before reading a file');
});

test('preview shows category, sides and BYEs; only confirmation commits and loads the next match', async () => {
  const { context, get, requests, actions } = await wizard();
  context.importEventNext();
  await context.reviewImportFile({ file: { type: 'text/csv' } });
  assert.deepEqual(visibleSteps(get), [2]);
  assert.equal(requests[0].url, '/api/tournament/import?preview=true');
  assert.equal(context.lastTournament.event, undefined);
  assert.equal(get('importDivision').value, 'SENIOR');
  assert.match(get('importReviewSummary').textContent, /3 competitors · 1 BYEs/);
  assert.ok(get('importReviewTable').innerHTML.includes('&lt;A&gt;'));
  assert.ok(!get('importReviewTable').innerHTML.includes('<A>'));
  assert.ok(get('importReviewTable').innerHTML.includes('BYE'));
  await context.startImportedCategory();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['X-SFTS-Import-Digest'], 'reviewed-file');
  assert.deepEqual(visibleSteps(get), [3]);
  assert.match(get('importRunCard').innerHTML, /SEMIFINAL — MATCH 1 OF 1/);
  assert.match(get('importRunCard').innerHTML, /LOAD NEXT MATCH/);
  context.loadNextImportedBout();
  context.loadNextImportedBout();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].boutNo, 1);
  context.lastTournament.activeBoutNo = 1;
  context.handleImportedState({ manualBout: { importedBoutNo: 1 } });
  assert.ok(get('dataImportModal').classList.contains('hidden'));
});

test('event changes invalidate the reviewed file; USB uses the same review and digest sequence', async () => {
  const { context, get, requests } = await wizard();
  await context.reviewImportFile({ fileName: 'opening.xlsx' });
  const preview = JSON.parse(requests[0].options.body);
  assert.equal(preview.preview, true);
  assert.equal(preview.event.autoAdvance, true);
  get('importVenue').value = 'Different Hall';
  await context.startImportedCategory();
  assert.equal(requests.length, 1);
  assert.match(get('importWizardError').textContent, /review the file again/);
  get('importVenue').value = 'Hall';
  await context.startImportedCategory();
  const commit = JSON.parse(requests[1].options.body);
  assert.equal(commit.preview, false);
  assert.equal(commit.digest, 'reviewed-file');
});

test('Continue Category returns to the decision cards while manual entry retains New Match', async () => {
  const { context, get, fixture, actions, openings } = await wizard();
  context.lastTournament = fixture;
  context.lastState = { manualBout: { importedBoutNo: 1 }, red: { playerName: 'A' }, blue: { playerName: 'B' }, matchReason: 'RSC' };
  context.showWinnerSlide('RED', context.lastState);
  assert.equal(get('winnerContinueButton').textContent, 'CONTINUE CATEGORY');
  context.startNewMatch();
  assert.equal(openings.length, 1);
  assert.equal(actions.length, 0);
  context.lastState = { ...context.lastState, manualBout: { categoryId: 'manual-only' } };
  context.showWinnerSlide('RED', context.lastState);
  assert.equal(get('winnerContinueButton').textContent, 'NEW MATCH');
  context.startNewMatch();
  assert.equal(actions[0].action, 'newMatch');
});
