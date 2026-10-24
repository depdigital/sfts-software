import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function launchPage() {
  const [app, html] = await Promise.all([
    readFile(new URL('../public/js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  ]);
  const sockets = [];
  const timers = new Map();
  const screens = [];
  const animations = [];
  const notices = [];
  let timerId = 0;
  const statusClasses = new Set(['hidden']);
  const status = {
    textContent: '',
    classList: { toggle(name, enabled) { if (enabled) statusClasses.add(name); else statusClasses.delete(name); } }
  };
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    open() { this.readyState = 1; this.onopen(); }
    message(data) { this.onmessage({ data: JSON.stringify(data) }); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const context = vm.createContext({
    WebSocket: Socket, location: { protocol: 'http:', host: '127.0.0.1:8080' },
    document: { getElementById: id => id === 'serverConnectionStatus' ? status : id === 'hostAccessToken' ? { value: 'test-access-token' } : null },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    showScreen: name => screens.push(name), requestAnimationFrame: callback => animations.push(callback),
    playLaunchBranding() {}, toast: text => notices.push(text)
  });
  // Run the actual page startup and socket handlers, without unrelated audio/DOM setup.
  const startup = app.slice(0, app.indexOf('preloadPointSounds();'));
  const send = app.slice(app.indexOf('function send(data)'), app.indexOf('function toast(text)'));
  const launch = app.slice(app.indexOf('function openHost()'), app.indexOf('function playLaunchBranding()'));
  vm.runInContext(`${startup}\n${send}\n${launch}`, context);
  return {
    context, sockets, timers, screens, animations, notices, statusClasses, html,
    retry() {
      assert.equal(timers.size, 1);
      const [id, { callback }] = timers.entries().next().value;
      timers.delete(id);
      callback();
    }
  };
}

test('idle launch page creates no unauthenticated sockets or reconnect timers', async () => {
  const page = await launchPage();
  assert.equal(page.sockets.length, 0);
  assert.equal(page.timers.size, 0);
  page.context.connectSocket();
  assert.equal(page.sockets.length, 0);
  assert.ok(page.statusClasses.has('hidden'));
  assert.match(page.html, /id="serverConnectionStatus" class="serverConnectionStatus hidden"/);
});

test('Launch opens one socket, authenticates immediately and waits for host acceptance', async () => {
  const page = await launchPage();
  page.context.openHost();
  page.context.openHost();
  assert.equal(page.sockets.length, 1);
  assert.deepEqual(page.screens, []);
  assert.ok(!page.statusClasses.has('hidden'));
  const socket = page.sockets[0];
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'role', role: 'host', corner: 0, accessToken: 'test-access-token', supportsStatePatch: true }]);
  assert.deepEqual(page.screens, []);
  socket.message({ type: 'roleAccepted', role: 'host', hostToken: 'session-token' });
  assert.deepEqual(page.screens, ['host']);
  assert.equal(page.animations.length, 1);
  assert.equal(page.timers.size, 0);
});

test('a launched scoreboard reconnects and ignores events from its previous socket', async () => {
  const page = await launchPage();
  page.context.openHost();
  const first = page.sockets[0];
  first.open();
  first.message({ type: 'roleAccepted', role: 'host', hostToken: 'first-session' });
  first.close();
  assert.equal(vm.runInContext('hostToken', page.context), '');
  page.retry();
  const second = page.sockets[1];
  second.open();
  assert.equal(second.sent[0].role, 'host');
  second.message({ type: 'roleAccepted', role: 'host', hostToken: 'second-session' });
  first.onclose();
  first.onerror();
  assert.equal(vm.runInContext('hostToken', page.context), 'second-session');
  assert.equal(page.timers.size, 0);
  assert.ok(page.statusClasses.has('hidden'));
  assert.equal(page.animations.length, 1, 'reconnecting must not replay the launch animation');
});

test('rejected host access returns home without a reconnect loop and permits an explicit retry', async () => {
  for (const code of ['HOST_UNAUTHORIZED', 'HOST_BUSY']) {
    const page = await launchPage();
    page.context.openHost();
    page.sockets[0].open();
    page.sockets[0].message({ type: 'error', code, message: 'Host access rejected' });
    assert.deepEqual(page.screens, ['home']);
    assert.equal(page.timers.size, 0);
    assert.ok(page.statusClasses.has('hidden'));
    assert.deepEqual(page.notices, ['Host access rejected']);
    page.context.openHost();
    assert.equal(page.sockets.length, 2);
  }
});
