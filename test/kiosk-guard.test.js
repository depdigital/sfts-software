import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installKioskGuard } from '../deployment/kiosk-guard/guard.js';

const ROOT = 'http://127.0.0.1:8080/';
const dashboard = (id = 1, extra = {}) => ({ id, url: ROOT, title: 'SFTS Dashboard', status: 'complete', active: true, ...extra });

function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}

async function launch(initialTabs = [dashboard()], root = ROOT) {
  let tabs = structuredClone(initialTabs);
  let time = 0;
  const updates = [];
  const removed = [];
  const created = [];
  const logs = [];
  const scheduled = [];
  const alarms = [];
  const browser = {
    tabs: {
      query: async () => structuredClone(tabs),
      update: async (id, change) => { updates.push({ id, ...change }); return Object.assign(tabs.find(tab => tab.id === id), change); },
      remove: async id => { removed.push(id); tabs = tabs.filter(tab => tab.id !== id); },
      create: async change => { const tab = { id: 99, ...change }; created.push(tab); tabs.push(tab); return tab; },
      onCreated: event(), onUpdated: event(), onActivated: event(), onRemoved: event()
    },
    webNavigation: { onBeforeNavigate: event(), onErrorOccurred: event() },
    alarms: { create: async (...args) => alarms.push(args), onAlarm: event() }
  };
  const guard = installKioskGuard(browser, root, {
    now: () => time, log: message => logs.push(message),
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); }
  });
  await guard.check('test startup');
  return {
    browser, guard, updates, removed, created, logs, scheduled, alarms,
    replace: value => { tabs = structuredClone(value); },
    advance: value => { time += value; }
  };
}

test('idle dashboard remains untouched across every screen and periodic health check', async () => {
  const page = await launch();
  // Screens are overlays in the same document, so none require navigation.
  for (const screen of ['home', 'host', 'manual entry', 'import', 'practice', 'schedule', 'results', 'settings', 'screensaver']) {
    page.browser.alarms.onAlarm.emit({ name: 'sfts-kiosk-health' });
    await page.guard.check(screen);
    page.advance(60_000);
  }
  assert.deepEqual(page.updates, []);
  assert.deepEqual(page.removed, []);
  assert.deepEqual(page.created, []);
  assert.equal(page.alarms[0][1].periodInMinutes, 0.5);
});

test('policy-blocked navigation recovers even when its displayed URL still matches the dashboard', async () => {
  const page = await launch();
  page.browser.webNavigation.onErrorOccurred.emit({ tabId: 1, frameId: 0, url: ROOT, error: 'net::ERR_BLOCKED_BY_ADMINISTRATOR' });
  await page.guard.check('failure delivered');
  assert.deepEqual(page.updates, [{ id: 1, url: ROOT, active: true }]);
  assert.ok(page.logs.some(log => log.includes('ERR_BLOCKED_BY_ADMINISTRATOR')));
});

test('guard recovers error pages present before it started, including same-URL error documents', async () => {
  for (const url of ['chrome-error://chromewebdata/', 'chrome://newtab/', 'about:blank', 'https://example.invalid/', ROOT]) {
    const page = await launch([dashboard(1, { url, title: 'This page is blocked' })]);
    assert.deepEqual(page.updates, [{ id: 1, url: ROOT, active: true }], url);
  }
});

test('new tabs and windows close without reloading the working dashboard or erasing its draft', async () => {
  const page = await launch();
  page.replace([dashboard(1, { active: false }), dashboard(2, { url: 'chrome://newtab/', title: 'Blocked' })]);
  page.browser.tabs.onCreated.emit({ id: 2 });
  await page.guard.check('extra tab delivered');
  assert.deepEqual(page.removed, [2]);
  assert.deepEqual(page.updates, [{ id: 1, active: true }]);
});

test('a blocked extra tab cannot force a reload of the healthy primary dashboard', async () => {
  const page = await launch();
  page.replace([dashboard(), dashboard(2, { url: 'https://example.invalid/', title: 'Blocked' })]);
  page.browser.webNavigation.onErrorOccurred.emit({ tabId: 2, frameId: 0, url: 'https://example.invalid/', error: 'net::ERR_BLOCKED_BY_ADMINISTRATOR' });
  await page.guard.check('extra tab blocked');
  assert.deepEqual(page.removed, [2]);
  assert.deepEqual(page.updates, []);
});

test('downloads, cancelled navigations and subframe failures do not reload the scoreboard', async () => {
  const page = await launch();
  for (const details of [
    { tabId: 1, frameId: 0, url: `${ROOT}api/tournament/schedule.xlsx`, error: 'net::ERR_ABORTED' },
    { tabId: 1, frameId: 2, url: ROOT, error: 'net::ERR_BLOCKED_BY_ADMINISTRATOR' }
  ]) page.browser.webNavigation.onErrorOccurred.emit(details);
  await page.guard.check('ignored failures');
  assert.deepEqual(page.updates, []);
});

test('repeated navigation failures retry with a delay instead of flooding the local server', async () => {
  const page = await launch();
  const failure = { tabId: 1, frameId: 0, url: ROOT, error: 'net::ERR_CONNECTION_REFUSED' };
  page.browser.webNavigation.onErrorOccurred.emit(failure);
  await page.guard.check('first failure');
  for (let i = 0; i < 20; i += 1) page.browser.webNavigation.onErrorOccurred.emit(failure);
  await page.guard.check('failure burst');
  assert.equal(page.updates.length, 1);
  assert.equal(page.scheduled.length, 1);
  assert.equal(page.scheduled[0].delay, 3000);
  page.advance(3000);
  page.scheduled.shift().callback();
  await page.guard.check('retry delivered');
  assert.equal(page.updates.length, 2);
  assert.equal(page.scheduled.length, 0);
});

test('health checks do not reload a legitimately loading dashboard and honor a custom port', async () => {
  const root = 'http://127.0.0.1:9090/';
  const page = await launch([dashboard(1, { url: 'about:blank', pendingUrl: root, title: '', status: 'loading' })], root);
  assert.deepEqual(page.updates, []);
  page.replace([dashboard(1, { url: root, title: 'Connection failed' })]);
  await page.guard.check('server error');
  assert.deepEqual(page.updates, [{ id: 1, url: root, active: true }]);
});

test('guard preserves an existing healthy dashboard and recreates one if all tabs are gone', async () => {
  const page = await launch([dashboard(1, { url: 'chrome://newtab/', title: 'Blocked' }), dashboard(2)]);
  assert.deepEqual(page.removed, [1]);
  assert.deepEqual(page.updates, []);
  page.replace([]);
  page.browser.tabs.onRemoved.emit(2);
  await page.guard.check('all tabs closed');
  assert.deepEqual(page.created, [{ id: 99, url: ROOT, active: true }]);
});

test('packaged guard is force-installed on both deployment paths without weakening kiosk restrictions', async () => {
  const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [manifestText, policyText, launcher, installer, restart, guardInstaller] = await Promise.all([
    read('deployment/kiosk-guard/manifest.json'), read('deployment/config/chromium-kiosk-policy.json'),
    read('deployment/scripts/start-kiosk.sh'), read('deployment/install.sh'),
    read('deployment/scripts/restart-stack.sh'), read('deployment/scripts/install-kiosk-guard.sh')
  ]);
  const manifest = JSON.parse(manifestText);
  const id = 'a'.repeat(32);
  const policy = JSON.parse(policyText.replaceAll('@PORT@', '8080').replaceAll('@GUARD_ID@', id));
  assert.deepEqual(policy.ExtensionInstallAllowlist, [id]);
  assert.deepEqual(policy.ExtensionInstallBlocklist, ['*']);
  assert.deepEqual(policy.ExtensionInstallForcelist, [`${id};${ROOT}kiosk-guard/update.xml`]);
  assert.equal(policy.DeveloperToolsAvailability, 2);
  assert.deepEqual(manifest.permissions, ['tabs', 'webNavigation', 'alarms']);
  assert.doesNotMatch(launcher, /--(?:disable-extensions|load-extension|disable-background-networking)/);
  assert.match(installer, /bash "\$\{PROJECT_DIR\}\/deployment\/scripts\/install-kiosk-guard\.sh" "\$\{kiosk_port\}"/);
  assert.match(restart, /bash "\$\{PROJECT_DIR\}\/deployment\/scripts\/install-kiosk-guard\.sh" "\$\{SERVER_PORT\}"/);
  assert.match(guardInstaller, /package-kiosk-guard\.js/);
  assert.match(guardInstaller, /\/etc\/sfts\/kiosk-guard-signing\.pem/);
});

async function navigationPage() {
  const listeners = new Map();
  const source = await readFile(new URL('../public/js/navigationGuard.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document: { addEventListener: (name, handler) => listeners.set(name, handler) },
    location: { origin: 'http://127.0.0.1:8080' }
  });
  return (name, extra = {}) => {
    let prevented = false;
    let stopped = false;
    listeners.get(name)({ key: '', target: {}, preventDefault: () => { prevented = true; },
      stopImmediatePropagation: () => { stopped = true; }, ...extra });
    return { prevented, stopped };
  };
}

test('all-screen navigation guard blocks browser shortcuts while preserving typing, editing and scoring keys', async () => {
  const emit = await navigationPage();
  for (const keys of [
    { key: 'F5' }, { key: 'r', ctrlKey: true }, { key: 'R', ctrlKey: true, shiftKey: true },
    { key: 'l', ctrlKey: true }, { key: 't', ctrlKey: true }, { key: 'w', ctrlKey: true },
    { key: 'ArrowLeft', altKey: true }, { key: 'Home', altKey: true }, { key: 'BrowserBack' }
  ]) assert.deepEqual(emit('keydown', keys), { prevented: true, stopped: true });
  for (const keys of [
    { key: ' ' }, { key: 'r' }, { key: 'b' }, { key: 's' }, { key: 'Enter' }, { key: 'Escape' },
    { key: 'a', ctrlKey: true }, { key: 'c', ctrlKey: true }, { key: 'v', ctrlKey: true }, { key: 'z', ctrlKey: true }
  ]) assert.deepEqual(emit('keydown', keys), { prevented: false, stopped: false });
});

test('navigation guard blocks links, form submissions and middle-click while permitting local blob downloads', async () => {
  const emit = await navigationPage();
  const anchor = (href, download = false) => ({ closest: () => ({ href, hasAttribute: name => name === 'download' && download }) });
  assert.equal(emit('auxclick').prevented, true);
  assert.equal(emit('submit').prevented, true);
  for (const href of ['https://example.invalid', ROOT, 'blob:https://example.invalid/123']) {
    assert.equal(emit('click', { target: anchor(href) }).prevented, true);
  }
  assert.equal(emit('click', { target: anchor(`blob:${ROOT}123`, true) }).prevented, false);
  assert.equal(emit('click').prevented, false);
});
