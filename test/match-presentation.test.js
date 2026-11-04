import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function dashboard() {
  const source = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      nodes.set(id, {
        textContent: '', disabled: false, isContentEditable: false,
        classList: {
          add: (...names) => names.forEach(name => classes.add(name)),
          remove: (...names) => names.forEach(name => classes.delete(name)),
          contains: name => classes.has(name),
          toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
        }
      });
    }
    return nodes.get(id);
  };
  const timers = new Map();
  const listeners = [];
  const actions = [];
  let time = 0;
  let serial = 0;
  const context = vm.createContext({
    document: { getElementById: get, addEventListener: (type, listener) => listeners.push(listener) },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    send: action => actions.push(action), winnerReasonDescription: reason => reason,
    renderRemoteMode() {}, renderCornerRefereeIndicators() {}, playerMetaText() {}, formatTime() {},
    renderKyeShi() {}, renderKyeShiWinnerButtons() {}, renderTieDecision() {}, closeMatchDecision() {},
    manualGam: player => actions.push({ action: 'gamjeom', player }), toggleScreensaver() {}, toast() {}
  });
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  vm.runInContext(source.slice(0, source.indexOf('function connectSocket()')), context);
  vm.runInContext(section('document.addEventListener("keydown",', 'document.addEventListener("contextmenu",'), context);
  vm.runInContext(section('function renderState(', 'function renderTimerUpdate('), context);
  vm.runInContext(section('function playPause()', 'function resetRoundTimer()'), context);
  vm.runInContext(section('function showRoundSummary(', 'function openTestMode()'), context);
  return {
    context, get, timers, actions,
    state(match, render = true) {
      context.testMatch = match;
      vm.runInContext('lastState = testMatch; role = "host";', context);
      if (render) context.renderState(match);
    },
    key(code, target = get('host')) {
      let prevented = false;
      listeners[0]({ code, target, preventDefault: () => { prevented = true; } });
      return prevented;
    },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].callback();
      }
      time = end;
    }
  };
}

function match(phase = 'MATCH_END', extra = {}) {
  const side = (playerName, score) => ({ playerName, name: playerName, score, gamjeom: 1,
    stats: { plus1: 1, plus2: 1, plus3: 1, technicalChest: 1, technicalHead: 0 } });
  return {
    phase, mode: 'COMPETITION', matchNo: 7, round: 2, running: phase === 'BREAK',
    roundStarted: false, startedAt: '2026-11-04T10:00:00Z', timerMs: 0,
    matchWinner: 'RED', matchReason: 'PTF - WON 2 ROUNDS',
    red: side('Red Competitor', 10), blue: side('Blue Competitor', 4), votes: {}, ...extra
  };
}

test('break keyboard controls and focused play-button activation cannot send timer/scoring commands', async () => {
  const page = await dashboard();
  page.state(match('BREAK', { timerMs: 35000 }));
  for (const code of ['Space', 'KeyR', 'KeyB', 'KeyS']) assert.equal(page.key(code), true);
  assert.equal(page.key('Space', page.get('playBtn')), true);
  page.context.playPause();
  assert.deepEqual(page.actions, []);
  assert.equal(page.get('playBtn').disabled, true);
  page.state(match('ROUND', { timerMs: 60000, matchWinner: null }));
  page.key('Space');
  assert.equal(page.get('playBtn').disabled, false);
  assert.equal(page.actions[0].action, 'playPause');
});

test('final scorecard stays visible for eight seconds before the winner screen appears', async () => {
  const page = await dashboard();
  const final = match();
  page.state(final);
  page.context.scheduleWinnerSlide('RED', final);
  assert.equal(page.get('roundTitle').textContent, 'FINAL SCORECARD');
  assert.equal(page.get('breakTimeText').classList.contains('hidden'), true);
  assert.equal(page.get('summaryRedScore').textContent, 10);
  assert.equal(page.get('summaryBlueScore').textContent, 4);
  assert.equal(page.get('roundOverlay').classList.contains('hidden'), false);
  assert.equal(page.get('winnerSlide').classList.contains('hidden'), true);
  page.advance(7999);
  assert.equal(page.get('winnerSlide').classList.contains('hidden'), true);
  page.advance(1);
  assert.equal(page.get('roundOverlay').classList.contains('hidden'), true);
  assert.equal(page.get('winnerSlide').classList.contains('hidden'), false);
  assert.equal(page.get('winnerNameText').textContent, 'Red Competitor');
  assert.equal(page.get('winnerSlide').classList.contains('redWinner'), true);
  assert.deepEqual(page.actions, [], 'presentation must not send match-control commands');
});

test('repeated final states and duplicate match-end messages do not restart the eight-second wait', async () => {
  const page = await dashboard();
  const final = match();
  page.state(final);
  page.context.scheduleWinnerSlide('RED', final);
  page.advance(4000);
  page.state(structuredClone(final));
  page.context.scheduleWinnerSlide('RED', structuredClone(final));
  assert.equal(page.timers.size, 1);
  page.advance(4000);
  assert.equal(page.get('winnerSlide').classList.contains('hidden'), false);
  page.context.scheduleWinnerSlide('RED', final);
  assert.equal(page.timers.size, 0);
});

test('resetting or loading another match cancels a pending winner screen', async () => {
  for (const replacement of [match('ROUND'), match('MATCH_END', { matchNo: 8 })]) {
    const page = await dashboard();
    const final = match();
    page.state(final);
    page.context.scheduleWinnerSlide('RED', final);
    page.advance(1000);
    page.state(replacement);
    assert.equal(page.timers.size, 0);
    page.advance(8000);
    assert.equal(page.get('winnerSlide').classList.contains('hidden'), true);
  }
});

test('new-match actions cancel the delay and practice results use the same presentation timing', async () => {
  const page = await dashboard();
  const final = match('MATCH_END', { mode: 'PRACTICE', matchWinner: 'BLUE', matchReason: 'RSC' });
  page.state(final);
  page.context.scheduleWinnerSlide('BLUE', final);
  page.advance(8000);
  assert.equal(page.get('winnerNameText').textContent, 'Blue Competitor');
  assert.equal(page.get('winnerSlide').classList.contains('blueWinner'), true);
  page.context.startNewMatch();
  assert.equal(page.get('winnerSlide').classList.contains('hidden'), true);
  page.context.scheduleWinnerSlide('BLUE', final);
  page.context.startNewMatch();
  assert.equal(page.timers.size, 0);
  page.advance(8000);
  assert.equal(page.get('winnerSlide').classList.contains('hidden'), true);
});
