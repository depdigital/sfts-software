import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRemoteTestTracker } from '../src/remoteTest.js';

const tracker = () => createRemoteTestTracker({ windowMs: () => 1000, technicalPointsFor: value => value === 2 ? 4 : value === 3 ? 6 : null });
const normal = (player, points) => ({ player, points, technical: false, button: `${player}_${points}` });
const technical = player => ({ player, points: null, technical: true, button: `${player}_TECHNICAL` });
const combined = (player, basePoints) => ({ player, basePoints, points: basePoints === 3 ? 6 : 4, technical: true, combined: true, button: `${player}_TECHNICAL_${basePoints}` });

test('both technical checks require their exact combination for either side on every corner', () => {
  for (let corner = 1; corner <= 4; corner += 1) {
    for (const player of ['RED', 'BLUE']) {
      for (const basePoints of [2, 3]) {
        const pairs = tracker();
        assert.equal(pairs.press(corner, technical(player), 0), null);
        assert.equal(pairs.press(corner, normal(player, basePoints), 100), `${player}_TECHNICAL_${basePoints}`);
        assert.equal(pairs.press(corner, normal(player, basePoints), 200), `${player}_${basePoints}`);
        assert.equal(pairs.press(corner, technical(player), 300), `${player}_TECHNICAL_${basePoints}`);
        assert.equal(pairs.press(corner, combined(player, basePoints), 400), `${player}_TECHNICAL_${basePoints}`);
      }
    }
  }
});

test('test combinations cannot cross sides/corners, use punch, survive expiry or survive reset', () => {
  const pairs = tracker();
  pairs.press(1, technical('RED'), 0);
  assert.equal(pairs.press(2, normal('RED', 3), 100), 'RED_3');
  assert.equal(pairs.press(1, normal('BLUE', 3), 100), 'BLUE_3');
  pairs.press(1, technical('RED'), 200);
  assert.equal(pairs.press(1, normal('RED', 1), 300), 'RED_1');
  assert.equal(pairs.press(1, normal('RED', 2), 400), 'RED_2');
  pairs.press(1, technical('BLUE'), 500);
  assert.equal(pairs.press(1, normal('BLUE', 2), 1501), 'BLUE_2');
  pairs.press(1, technical('BLUE'), 1502);
  pairs.clear(1);
  assert.equal(pairs.press(1, normal('BLUE', 2), 1600), 'BLUE_2');
  pairs.press(2, technical('RED'), 1700);
  pairs.reset();
  assert.equal(pairs.press(2, normal('RED', 3), 1800), 'RED_3');
});

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); }
  };
}

async function dashboardFixture() {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/app.js', import.meta.url), 'utf8')
  ]);
  const cards = new Map();
  for (let corner = 1; corner <= 4; corner += 1) {
    const start = html.indexOf(`<div id="joy${corner}"`);
    const end = corner < 4 ? html.indexOf(`<div id="joy${corner + 1}"`, start) : html.indexOf('</section>', start);
    const markup = html.slice(start, end);
    const indicators = new Map([...markup.matchAll(/<i data-key="([^"]+)"[^>]*>([\s\S]*?)<\/i>/g)]
      .map(([, key, content]) => [key, { classList: classList(), content }]));
    cards.set(`joy${corner}`, {
      classList: classList(), indicators, markup,
      querySelector: selector => indicators.get(/data-key="([^"]+)"/.exec(selector)?.[1]) || null,
      querySelectorAll: () => [...indicators.values()]
    });
  }
  const context = vm.createContext({ $: id => cards.get(id) });
  const start = app.indexOf('function resetTestUi()');
  vm.runInContext(app.slice(start, app.indexOf('function audio()', start)), context);
  return { cards, mark: context.markTest, reset: context.resetTestUi };
}

test('all four cards have five correctly ordered checks and reuse the requested score icons', async () => {
  const { cards } = await dashboardFixture();
  for (const card of cards.values()) {
    assert.deepEqual([...card.indicators.keys()], ['RED-3', 'RED-2', 'RED-TECHNICAL-3', 'RED-TECHNICAL-2', 'RED-1', 'BLUE-3', 'BLUE-2', 'BLUE-TECHNICAL-3', 'BLUE-TECHNICAL-2', 'BLUE-1']);
    assert.doesNotMatch(card.markup, /TECHNICAL KICK/);
    for (const side of ['RED', 'BLUE']) {
      for (const [point, asset] of [[3, 'headgear'], [2, 'chestguard'], [1, 'fist']]) {
        assert.ok(card.indicators.get(`${side}-${point}`).content.includes(`/assets/${asset}.png`));
      }
    }
  }
});

test('the centre tick needs all ten distinct checks and reset clears every remote', async () => {
  const { cards, mark, reset } = await dashboardFixture();
  for (let corner = 1; corner <= 4; corner += 1) {
    const card = cards.get(`joy${corner}`);
    for (const side of ['RED', 'BLUE']) {
      mark(corner, side, null, `${side}_TECHNICAL`);
      assert.equal(card.indicators.get(`${side}-TECHNICAL-3`).classList.contains(side === 'RED' ? 'litRed' : 'litBlue'), false);
      for (const point of [3, 2, 1]) mark(corner, side, point, `${side}_${point}`);
      mark(corner, side, 6, `${side}_TECHNICAL_3`);
    }
    assert.equal(card.classList.contains('passed'), false);
    mark(corner, 'RED', 4, 'RED_TECHNICAL_2');
    assert.equal(card.classList.contains('passed'), false, 'blue technical chest is still missing');
    mark(corner, 'BLUE', 4, 'BLUE_TECHNICAL_2');
    assert.equal(card.classList.contains('passed'), true);
  }
  reset();
  for (const card of cards.values()) {
    assert.equal(card.classList.contains('passed'), false);
    assert.ok([...card.indicators.values()].every(item => !item.classList.contains('litRed') && !item.classList.contains('litBlue')));
  }
});

test('a technical combination does not substitute for an individual head/chest test', async () => {
  const { cards, mark } = await dashboardFixture();
  mark(1, 'RED', 6, 'RED_TECHNICAL_3');
  mark(1, 'RED', 4, 'RED_TECHNICAL_2');
  const card = cards.get('joy1');
  assert.equal(card.indicators.get('RED-TECHNICAL-3').classList.contains('litRed'), true);
  assert.equal(card.indicators.get('RED-TECHNICAL-2').classList.contains('litRed'), true);
  assert.equal(card.indicators.get('RED-3').classList.contains('litRed'), false);
  assert.equal(card.indicators.get('RED-2').classList.contains('litRed'), false);
  assert.equal(card.classList.contains('passed'), false);
});
