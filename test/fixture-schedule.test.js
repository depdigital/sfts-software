import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureTemplateSheets } from '../src/fixtureTemplate.js';
import { parseFixtureRows } from '../src/fixtureImport.js';
import { buildFixtureProgression, refreshFixtureProgression } from '../src/fixtureProgression.js';
import { applyFixtureSchedule, nextScheduledWorkbookBout, validateWorkbookSchedule } from '../src/fixtureSchedule.js';
import { readRulesFile } from '../src/rules.js';

const rules = await readRulesFile(new URL('../config/rules.default.json', import.meta.url));
const sheets = createFixtureTemplateSheets(rules.tournament.divisions);
const categoryFromInput = input => ({ value: input });

function workbook() {
  const parsed = parseFixtureRows(sheets[0].rows, { categoryFromInput, playerDetails: input => input, event: {}, maxBouts: 4096, openingFixture: true, multipleCategories: true });
  assert.deepEqual(parsed.errors, []);
  return { categories: parsed.categories.map((group, index) => {
    const fixture = {
      progressionMode: 'OPENING_FIXTURE', event: group.category, players: [],
      schedule: group.bouts.map((bout, position) => ({ ...bout, boutNo: position + 1 }))
    };
    buildFixtureProgression(fixture);
    return { key: String(index), fixture };
  }) };
}

function scheduleRows() { return structuredClone(sheets.find(sheet => sheet.name === 'Schedule').rows); }

test('the complete template follows its supplied order with rest for either winner', () => {
  for (const winner of ['RED', 'BLUE']) {
    const result = workbook();
    const rows = scheduleRows();
    applyFixtureSchedule(result, rows, categoryFromInput);
    let played = 0;
    let previous = new Set();
    for (let next; (next = nextScheduledWorkbookBout(result));) {
      assert.equal(next.bout.matchOrder, played + 1);
      assert.equal(next.bout.status, 'SCHEDULED');
      const names = [next.bout.RED.playerName, next.bout.BLUE.playerName];
      assert.ok(names.every(name => !previous.has(name)));
      previous = new Set(names);
      Object.assign(next.bout, { winner, status: 'COMPLETED' });
      refreshFixtureProgression(next.fixture);
      played += 1;
    }
    assert.equal(played, result.categories.length * 8);
    validateWorkbookSchedule(result);
  }
});

test('invalid or incomplete schedules reject rather than silently rearranging the fixture', () => {
  for (const [mutate, error] of [
    [rows => rows.pop(), /every scored bout/],
    [rows => { rows[2] = [...rows[1]]; }, /repeats bout/],
    [rows => { rows[2][0] = rows[1][0]; }, /unique positive/],
    [rows => { rows[1][7] = 'Winner of WRONG'; }, /sources disagree/],
    [rows => { rows[1][9] = 0; }, /Minimum Match Gap 1/],
    [rows => { rows[2][0] = 3; rows[3][0] = 2; }, /rest gap missing/],
    [rows => { rows[1][0] = 15; rows[15][0] = 1; }, /source .* before|earlier round/]
  ]) {
    const rows = scheduleRows();
    mutate(rows);
    assert.throws(() => applyFixtureSchedule(workbook(), rows, categoryFromInput), error);
  }
});

test('schedule validation covers every possible winner and rejects out-of-order historical records', () => {
  const result = workbook();
  applyFixtureSchedule(result, scheduleRows(), categoryFromInput);
  result.categories[1].fixture.schedule.find(bout => bout.status !== 'BYE').status = 'COMPLETED';
  assert.throws(() => validateWorkbookSchedule(result), /Recorded matches/);
});

test('an odd number of categories interleaves its final group of three', () => {
  const division = structuredClone(rules.tournament.divisions[0]);
  division.weightCategories.MALE = division.weightCategories.MALE.slice(0, 2);
  division.weightCategories.FEMALE = division.weightCategories.FEMALE.slice(0, 1);
  const generated = createFixtureTemplateSheets([division]);
  const rows = generated.find(sheet => sheet.name === 'Schedule').rows;
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.slice(1, 4).map(row => row[2]), ['PRELIMINARY', 'PRELIMINARY', 'PRELIMINARY']);
  assert.deepEqual(rows.slice(-3).map(row => row[2]), ['FINAL', 'FINAL', 'FINAL']);
});
