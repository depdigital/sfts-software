import { participantKey } from './fixtureProgression.js';

export const SCHEDULE_HEADERS = [
  'Match Order', 'Bout Number', 'Stage', 'Division', 'Gender', 'Weight Category', 'Group',
  'Hong Source', 'Chung Source', 'Minimum Match Gap'
];
export const MAX_SCHEDULE_ROWS = 8192;

export const fixtureCategoryKey = event => JSON.stringify(['division', 'gender', 'weightCategory', 'categoryGroup'].map(key => event[key] || ''));

export function fixtureSourceLabel(fixture, bout, side) {
  const source = bout[side === 'RED' ? 'redSourceBoutNo' : 'blueSourceBoutNo'];
  return source ? `Winner of ${fixture.schedule.find(item => item.boutNo === source).officialBoutNo}` : bout[side]?.playerName || 'BYE';
}

export function scheduledWorkbookBouts(workbook) {
  return workbook.categories.flatMap(category => category.fixture.schedule
    .filter(bout => bout.status !== 'BYE')
    .map(bout => ({ ...category, bout })))
    .sort((a, b) => a.bout.matchOrder - b.bout.matchOrder);
}

export function nextScheduledWorkbookBout(workbook) {
  const category = workbook?.schedulePolicy && workbook.categories.find(item => item.key === workbook.selectedKey);
  const bout = category?.fixture.schedule.filter(item => !['COMPLETED', 'BYE'].includes(item.status)).sort((a, b) => a.matchOrder - b.matchOrder)[0];
  return bout ? { ...category, bout } : null;
}

export function playersNeedingRest(bout, lastRecord) {
  if (!bout || !lastRecord) return [];
  const previous = new Set([lastRecord.red, lastRecord.blue].filter(player => player?.playerName).map(participantKey));
  return [bout.RED, bout.BLUE].filter(player => player && previous.has(participantKey(player))).map(player => player.playerName);
}

// Running order belongs to each category. Cross-category rest gaps are supplied
// by the operator and checked against the last completed match when loading.
export function validateWorkbookSchedule(workbook) {
  if (!workbook?.schedulePolicy) return;
  if (workbook.schedulePolicy.minimumMatchGap !== 1) throw new Error('Minimum Match Gap must be 1');
  for (const { key, fixture } of workbook.categories) {
    const entries = fixture.schedule.filter(bout => bout.status !== 'BYE').sort((a, b) => a.matchOrder - b.matchOrder);
    const orders = new Set();
    const orderByBout = new Map(entries.map(bout => [bout.boutNo, bout.matchOrder]));
    let round = 1;
    let unfinished = false;
    for (const bout of entries) {
      if (!Number.isSafeInteger(bout.matchOrder) || bout.matchOrder < 1 || bout.matchOrder > MAX_SCHEDULE_ROWS || orders.has(bout.matchOrder)) throw new Error(`Schedule Match Order must be unique positive integers within each category (${key})`);
      orders.add(bout.matchOrder);
      if (bout.round < round) throw new Error(`Schedule runs ${bout.officialBoutNo} before its category's earlier round is complete`);
      round = bout.round;
      for (const number of [bout.redSourceBoutNo, bout.blueSourceBoutNo].filter(Boolean)) {
        const source = fixture.schedule[number - 1];
        if (source.status !== 'BYE' && !(orderByBout.get(number) < bout.matchOrder)) throw new Error(`Schedule must place source ${source.officialBoutNo} before ${bout.officialBoutNo}`);
      }
      if (unfinished && ['COMPLETED', 'IN_PROGRESS', 'TIE_PENDING'].includes(bout.status)) throw new Error('Recorded matches do not follow this category Schedule. Preserve its scored order when revising the fixture');
      if (bout.status !== 'COMPLETED') unfinished = true;
    }
  }
}

export function applyFixtureSchedule(workbook, rows, categoryFromInput) {
  const normalize = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const headers = (rows[0] || []).map(normalize);
  const columns = Object.fromEntries(SCHEDULE_HEADERS.map(label => {
    const indices = headers.flatMap((header, index) => header === normalize(label) ? [index] : []);
    if (indices.length !== 1) throw new Error(`Schedule requires exactly one ${label} column`);
    return [label, indices[0]];
  }));
  const expected = scheduledWorkbookBouts(workbook);
  if (rows.length - 1 !== expected.length || expected.length > MAX_SCHEDULE_ROWS) throw new Error('Schedule must contain every scored bout exactly once, excluding BYEs');
  const categories = new Map(workbook.categories.map(category => [fixtureCategoryKey(category.fixture.event), category]));
  const seen = new Set();
  for (const [index, row] of rows.slice(1).entries()) {
    const get = label => String(row[columns[label]] ?? '').trim();
    const parsed = categoryFromInput({ division: get('Division'), gender: get('Gender'), weightCategory: get('Weight Category'), categoryGroup: get('Group') });
    if (!parsed.error && ((get('Group') && parsed.value.weightCategory) || (get('Weight Category') && parsed.value.categoryGroup))) throw new Error(`Schedule row ${index + 2}: use Weight Category or Group, not both`);
    const category = !parsed.error && categories.get(fixtureCategoryKey(parsed.value));
    const bout = category?.fixture.schedule.find(item => item.officialBoutNo.toUpperCase() === get('Bout Number').toUpperCase());
    if (!bout || bout.status === 'BYE') throw new Error(`Schedule row ${index + 2}: unknown category/bout or BYE`);
    const id = `${category.key}:${bout.boutNo}`;
    if (seen.has(id)) throw new Error(`Schedule repeats bout ${bout.officialBoutNo}`);
    seen.add(id);
    if (get('Stage') !== bout.stage || get('Hong Source') !== fixtureSourceLabel(category.fixture, bout, 'RED') || get('Chung Source') !== fixtureSourceLabel(category.fixture, bout, 'BLUE')) throw new Error(`Schedule row ${index + 2}: stage or competitor sources disagree with Matches`);
    if (!/^[1-9]\d*$/.test(get('Match Order')) || get('Minimum Match Gap') !== '1') throw new Error(`Schedule row ${index + 2}: use a positive Match Order and Minimum Match Gap 1`);
    bout.matchOrder = Number(get('Match Order'));
  }
  workbook.schedulePolicy = { minimumMatchGap: 1, scope: 'CATEGORY' };
  validateWorkbookSchedule(workbook);
}
