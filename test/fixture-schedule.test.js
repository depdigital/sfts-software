import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureTemplateSheets } from '../src/fixtureTemplate.js';
import { parseFixtureRows } from '../src/fixtureImport.js';
import { buildFixtureProgression, refreshFixtureProgression } from '../src/fixtureProgression.js';
import { applyFixtureSchedule, nextScheduledWorkbookBout, validateWorkbookSchedule, playersNeedingRest, SCHEDULE_HEADERS, fixtureSourceLabel } from '../src/fixtureSchedule.js';
import { readRulesFile } from '../src/rules.js';

const rules = await readRulesFile(new URL('../config/rules.default.json', import.meta.url));
const sheets = createFixtureTemplateSheets(rules.tournament.divisions);
const categoryFromInput = input => ({ value: input });

function workbook() {
  const parsed = parseFixtureRows(sheets[0].rows, { categoryFromInput, playerDetails: input => input, event: {}, maxBouts: 4096, openingFixture: true, multipleCategories: true });
  assert.deepEqual(parsed.errors, []);
  return { selectedKey: '0', categories: parsed.categories.map((group, index) => {
    const fixture = {
      progressionMode: 'OPENING_FIXTURE', event: group.category, players: [],
      schedule: group.bouts.map((bout, position) => ({ ...bout, boutNo: position + 1 }))
    };
    buildFixtureProgression(fixture);
    return { key: String(index), fixture };
  }) };
}

function scheduleRows() { return structuredClone(sheets.find(sheet => sheet.name === 'Schedule').rows); }

test('each category has one BYE and stays selected through all rounds with a manual gap before its final', () => {
  for (const winner of ['RED', 'BLUE']) {
    const result = workbook();
    applyFixtureSchedule(result, scheduleRows(), categoryFromInput);
    for (const category of result.categories) {
      result.selectedKey = category.key;
      assert.equal(category.fixture.schedule.filter(bout => bout.status === 'BYE').length, 1);
      let played = 0;
      let lastRecord;
      for (let next; (next = nextScheduledWorkbookBout(result));) {
        assert.equal(next.key, category.key, 'selection must never change automatically');
        assert.equal(next.bout.matchOrder, played + 1);
        assert.equal(next.bout.status, 'SCHEDULED');
        if (next.bout.stage === 'FINAL') {
          assert.equal(playersNeedingRest(next.bout, lastRecord).length, 1);
          lastRecord = { red: { playerName: 'Other category red', club: 'Other Club' }, blue: { playerName: 'Other category blue', club: 'Other Club' } };
        }
        assert.deepEqual(playersNeedingRest(next.bout, lastRecord), []);
        lastRecord = { red: next.bout.RED, blue: next.bout.BLUE };
        Object.assign(next.bout, { winner, status: 'COMPLETED' });
        refreshFixtureProgression(next.fixture);
        played += 1;
      }
      assert.equal(played, 14);
      assert.equal(nextScheduledWorkbookBout(result), null, 'completed category must not advance to another category');
    }
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
    [rows => { rows[1][0] = 15; rows[15][0] = 1; }, /source .* before|earlier round/]
  ]) {
    const rows = scheduleRows();
    mutate(rows);
    assert.throws(() => applyFixtureSchedule(workbook(), rows, categoryFromInput), error);
  }
});

test('manual category switching preserves independent progress and rejects skipped bouts within a category', () => {
  const result = workbook();
  applyFixtureSchedule(result, scheduleRows(), categoryFromInput);
  result.categories[1].fixture.schedule.find(bout => bout.status !== 'BYE').status = 'COMPLETED';
  validateWorkbookSchedule(result);
  result.categories[1].fixture.schedule.filter(bout => bout.status !== 'BYE')[2].status = 'COMPLETED';
  assert.throws(() => validateWorkbookSchedule(result), /Recorded matches/);
});

test('categories have independent match numbers and do not require pairs', () => {
  const division = structuredClone(rules.tournament.divisions[0]);
  division.weightCategories.MALE = division.weightCategories.MALE.slice(0, 2);
  division.weightCategories.FEMALE = division.weightCategories.FEMALE.slice(0, 1);
  const generated = createFixtureTemplateSheets([division]);
  const rows = generated.find(sheet => sheet.name === 'Schedule').rows;
  assert.equal(rows.length, 43);
  assert.deepEqual(rows.slice(1, 15).map(row => row[0]), Array.from({ length: 14 }, (_, index) => index + 1));
  assert.equal(rows[14][2], 'FINAL');
  assert.equal(rows[15][0], 1);
  assert.equal(rows[15][2], 'PRELIMINARY');
  division.weightCategories.MALE = [];
  assert.equal(createFixtureTemplateSheets([division]).find(sheet => sheet.name === 'Schedule').rows.length, 15);
});

test('a smaller three-player bracket accepts a manually supplied gap after its only semifinal', () => {
  const player = playerName => ({ playerName, club: 'Small Club' });
  const event = { division: 'SENIOR', gender: 'MALE', weightCategory: 'FINWEIGHT', categoryGroup: '' };
  const fixture = { progressionMode: 'OPENING_FIXTURE', event, players: [], schedule: [
    { boutNo: 1, officialBoutNo: 'SF-1', stage: 'SEMIFINAL', RED: player('A'), BLUE: player('B') },
    { boutNo: 2, officialBoutNo: 'SF-BYE', stage: 'SEMIFINAL', RED: player('C'), BLUE: null }
  ] };
  buildFixtureProgression(fixture);
  const result = { selectedKey: 'small', categories: [{ key: 'small', fixture }] };
  const rows = [SCHEDULE_HEADERS, ...fixture.schedule.filter(bout => bout.status !== 'BYE').map((bout, index) => [
    index + 1, bout.officialBoutNo, bout.stage, event.division, event.gender, event.weightCategory, '',
    fixtureSourceLabel(fixture, bout, 'RED'), fixtureSourceLabel(fixture, bout, 'BLUE'), 1
  ])];
  applyFixtureSchedule(result, rows, categoryFromInput);
  const semifinal = nextScheduledWorkbookBout(result).bout;
  Object.assign(semifinal, { status: 'COMPLETED', winner: 'BLUE' });
  refreshFixtureProgression(fixture);
  const final = nextScheduledWorkbookBout(result).bout;
  assert.equal(final.stage, 'FINAL');
  assert.deepEqual(playersNeedingRest(final, { red: semifinal.RED, blue: semifinal.BLUE }), ['B']);
  assert.deepEqual(playersNeedingRest(final, { red: player('Other Hong'), blue: player('Other Chung') }), []);
});
