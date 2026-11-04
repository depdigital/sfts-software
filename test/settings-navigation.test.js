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
  const context = vm.createContext({ $: get });
  vm.runInContext('let settingsSection = "";\n' + source.slice(source.indexOf('function openSettings()'), source.indexOf('function openMatchDecision()')), context);
  return { context, get, focused, visible: id => !get(id).classList.contains('hidden') };
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
