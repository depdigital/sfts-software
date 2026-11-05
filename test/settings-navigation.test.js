import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function settings() {
  const [html, source] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/app.js', import.meta.url), 'utf8')
  ]);
  const nodes = new Map();
  const focused = [];
  for (const [tag, id] of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const classes = new Set((/class="([^"]*)"/.exec(tag)?.[1] || '').split(/\s+/));
    nodes.set(id, {
      textContent: '', focus: () => focused.push(id),
      querySelector: () => ({ focus: () => focused.push(`${id}:first-action`) }),
      classList: {
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
      }
    });
  }
  const get = id => nodes.get(id);
  const sent = [];
  const context = vm.createContext({
    $: get, send: message => sent.push(message), clearInterval: () => {},
    showScreen: id => {
      for (const screen of ['host', 'testMode']) get(screen).classList.toggle('hidden', screen !== id);
    },
    displayPlayerName: (_state, player) => player,
    lastState: { phase: 'ROUND' },
    scoringRules: { manualMatchDecisions: ['RSC', 'WDR'] },
    document: { querySelectorAll: () => [] }
  });
  vm.runInContext(`
    let settingsSection = "", manualDecisionCode = "", powerAction = "";
    let powerActionScheduled = false, powerBackPending = false;
    let powerCountdownTimer = null, powerDeadlineAt = 0;
  ` + source.slice(source.indexOf('function openSettings()'), source.indexOf('function openMatchDecision()')), context);
  for (const name of [
    'openMatchDecision', 'closeMatchDecision', 'backFromMatchDecision', 'selectManualDecision',
    'closeAdvancedCorrections', 'closeArenaNumber', 'closeRules', 'closeTimerEditor',
    'closeHistory', 'closeCornerRefereeHistory', 'closeTestMode', 'powerActionLabel',
    'openPowerAction', 'confirmPowerAction', 'cancelPowerAction', 'backFromPowerAction', 'closePowerModal'
  ]) {
    const start = source.indexOf(`function ${name}(`);
    const next = /^(?:async )?function /m.exec(source.slice(start + 1));
    vm.runInContext(source.slice(start, next ? start + 1 + next.index : undefined), context);
  }
  return { context, get, focused, sent, html, visible: id => !get(id).classList.contains('hidden') };
}

test('Settings opens at its four-category menu with all action submenus hidden', async () => {
  const { context, get, visible, focused } = await settings();
  context.openSettings();
  assert.equal(visible('settingsModal'), true);
  assert.equal(visible('settingsHome'), true);
  assert.equal(visible('settingsBack'), false);
  for (const panel of ['settingsMatch', 'settingsSetup', 'settingsRecords', 'settingsPower']) assert.equal(visible(panel), false);
  assert.equal(get('settingsTitle').textContent, 'SETTINGS');
  assert.equal(focused.at(-1), 'settingsMatchButton');
});

test('each category shows only its own actions and Back restores the main menu and keyboard focus', async () => {
  const { context, get, visible, focused } = await settings();
  const groups = [
    ['match', 'settingsMatch', 'MATCH CONTROLS'], ['setup', 'settingsSetup', 'SETUP'],
    ['records', 'settingsRecords', 'RECORDS'], ['power', 'settingsPower', 'POWER']
  ];
  context.openSettings();
  for (const [key, panel, title] of groups) {
    context.openSettingsSection(key);
    assert.equal(visible('settingsHome'), false);
    assert.equal(visible('settingsBack'), true);
    assert.equal(get('settingsTitle').textContent, title);
    assert.deepEqual(groups.filter(([, id]) => visible(id)).map(([, id]) => id), [panel]);
    assert.equal(focused.at(-1), `${panel}:first-action`);
    context.openSettingsSection();
    assert.equal(visible('settingsHome'), true);
    assert.equal(visible('settingsBack'), false);
    assert.equal(get('settingsTitle').textContent, 'SETTINGS');
    assert.equal(focused.at(-1), `${panel}Button`);
  }
});

test('reopening Settings resets the submenu and unknown categories cannot reveal other controls', async () => {
  const { context, visible, get } = await settings();
  context.openSettings();
  context.openSettingsSection('power');
  for (const invalid of ['unknown', '__proto__', 'constructor']) context.openSettingsSection(invalid);
  assert.equal(get('settingsTitle').textContent, 'POWER');
  context.closeSettings();
  assert.equal(visible('settingsModal'), false);
  context.openSettings();
  assert.equal(visible('settingsHome'), true);
  assert.equal(visible('settingsPower'), false);
  assert.equal(get('settingsTitle').textContent, 'SETTINGS');
});

test('each detail screen has a working Back button to its own Settings category', async () => {
  const { context, get, visible, html, sent } = await settings();
  for (const [id, panel, title] of [
    ['timerModal', 'settingsMatch', 'MATCH CONTROLS'],
    ['advancedCorrectionsModal', 'settingsMatch', 'MATCH CONTROLS'],
    ['arenaNumberModal', 'settingsSetup', 'SETUP'],
    ['rulesModal', 'settingsSetup', 'SETUP'],
    ['historyModal', 'settingsRecords', 'RECORDS'],
    ['cornerRefereeHistoryModal', 'settingsRecords', 'RECORDS'],
    ['testMode', 'settingsSetup', 'SETUP']
  ]) {
    context.closeSettings();
    get(id).classList.remove('hidden');
    const start = html.indexOf(`<section id="${id}"`);
    const end = html.indexOf('<section id="', start + 1);
    const markup = html.slice(start, end === -1 ? undefined : end);
    const handler = /onclick="([^"]+)"[^>]*>BACK<\/button>/.exec(markup)?.[1];
    assert.ok(handler, `${id} needs a Back button`);
    vm.runInContext(handler, context);
    assert.equal(visible(id), false, `${id} closes`);
    assert.equal(visible('settingsModal'), true);
    assert.equal(visible(panel), true);
    assert.equal(get('settingsTitle').textContent, title);
    if (id === 'testMode') {
      assert.equal(visible('host'), true);
      assert.equal(sent.at(-1).action, 'testStop');
    }
    context.openSettingsSection();
    assert.equal(visible('settingsHome'), true);
  }
  assert.equal(sent.length, 1, 'Back must not save or submit an action');
});

test('Match Decision Back returns from winner selection to decisions, then Match Controls', async () => {
  const { context, visible, get, sent } = await settings();
  context.openSettings();
  context.openSettingsSection('match');
  context.openMatchDecision();
  context.selectManualDecision('RSC');
  assert.equal(visible('manualDecisionOptions'), false);
  context.backFromMatchDecision();
  assert.equal(visible('matchDecisionModal'), true);
  assert.equal(visible('manualDecisionOptions'), true);
  assert.equal(visible('manualDecisionWinnerActions'), false);
  assert.equal(visible('settingsModal'), false);
  context.backFromMatchDecision();
  assert.equal(visible('matchDecisionModal'), false);
  assert.equal(visible('settingsMatch'), true);
  assert.equal(visible('settingsModal'), true);
  assert.equal(get('settingsTitle').textContent, 'MATCH CONTROLS');
  assert.equal(sent.length, 0);
});

test('power Back returns immediately before starting and waits for cancellation after starting', async () => {
  for (const action of ['reboot', 'shutdown']) {
    const { context, visible, get, sent } = await settings();
    context.openSettings();
    context.openSettingsSection('power');
    context.openPowerAction(action);
    context.backFromPowerAction();
    assert.equal(visible('powerModal'), false);
    assert.equal(visible('settingsModal'), true);
    assert.equal(visible('settingsPower'), true);
    assert.equal(sent.length, 0);

    context.openPowerAction(action);
    context.confirmPowerAction();
    context.backFromPowerAction();
    assert.deepEqual(sent.map(message => message.action), ['systemPower', 'cancelSystemPower']);
    assert.equal(visible('powerModal'), true);
    assert.equal(visible('settingsModal'), false);
    assert.equal(get('powerBackButton').disabled, true);
    // The server acknowledges cancellation by calling closePowerModal.
    context.closePowerModal();
    assert.equal(visible('powerModal'), false);
    assert.equal(visible('settingsModal'), true);
    assert.equal(visible('settingsPower'), true);
    assert.equal(get('powerBackButton').disabled, false);
  }
});
