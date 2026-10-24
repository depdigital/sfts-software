import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('dashboard applies compact scores without discarding cached tournament data and replaces caches on full resync', async () => {
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL('../public/js/state.js', import.meta.url), 'utf8'), context);
  const merge = context.SftsState.merge;
  const initial = { type: 'state', match: { red: { score: 0 } }, tournament: { players: ['player'] }, manualCompetition: { categories: ['category'] }, matchHistory: [] };
  const patch = { type: 'statePatch', match: { red: { score: 2 } } };
  assert.equal(merge(null, patch), null);
  const applied = merge(initial, patch);
  assert.equal(applied.match.red.score, 2);
  assert.equal(applied.tournament, initial.tournament);
  assert.equal(applied.manualCompetition, initial.manualCompetition);
  assert.equal(applied.type, 'state');
  const fresh = { type: 'state', tournament: { players: [] } };
  assert.equal(merge(applied, fresh), fresh);
});
