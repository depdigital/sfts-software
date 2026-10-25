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
  return workbook?.schedulePolicy ? scheduledWorkbookBouts(workbook).find(item => item.bout.status !== 'COMPLETED') || null : null;
}

// Validate all possible winners, so the approved order never depends on a predicted result.
export function validateWorkbookSchedule(workbook, { contiguous = false } = {}) {
  if (!workbook?.schedulePolicy) return;
  if (workbook.schedulePolicy.minimumMatchGap !== 1) throw new Error('Minimum Match Gap must be 1');
  const possible = new Map();
  for (const { key, fixture } of workbook.categories) {
    const byNumber = new Map();
    for (const bout of fixture.schedule) {
      const players = new Set();
      for (const [side, prefix] of [['RED', 'red'], ['BLUE', 'blue']]) {
        const source = bout[`${prefix}SourceBoutNo`];
        if (source) {
          for (const player of byNumber.get(source) || []) players.add(player);
        } else if (bout[side]) players.add(participantKey(bout[side]));
      }
      byNumber.set(bout.boutNo, players);
      possible.set(`${key}:${bout.boutNo}`, players);
    }
  }
  const entries = scheduledWorkbookBouts(workbook);
  const orders = new Set();
  let previous;
  let unfinished = false;
  const roundByCategory = new Map();
  const orderByBout = new Map(entries.map(item => [`${item.key}:${item.bout.boutNo}`, item.bout.matchOrder]));
  for (const [index, entry] of entries.entries()) {
    const { key, fixture, bout } = entry;
    if (!Number.isSafeInteger(bout.matchOrder) || bout.matchOrder < 1 || bout.matchOrder > MAX_SCHEDULE_ROWS || orders.has(bout.matchOrder) || (contiguous && bout.matchOrder !== index + 1)) {
      throw new Error('Schedule Match Order must be unique positive integers, starting at 1 without gaps on import');
    }
    orders.add(bout.matchOrder);
    if (bout.round < (roundByCategory.get(key) || 1)) throw new Error(`Schedule runs ${bout.officialBoutNo} before its category's earlier round is complete`);
    roundByCategory.set(key, bout.round);
    for (const number of [bout.redSourceBoutNo, bout.blueSourceBoutNo].filter(Boolean)) {
      const source = fixture.schedule[number - 1];
      if (source.status !== 'BYE' && !(orderByBout.get(`${key}:${number}`) < bout.matchOrder)) throw new Error(`Schedule must place source ${source.officialBoutNo} before ${bout.officialBoutNo}`);
    }
    if (unfinished && ['COMPLETED', 'IN_PROGRESS', 'TIE_PENDING'].includes(bout.status)) throw new Error('Recorded matches do not follow this Schedule. Preserve the scored order when exporting a revised fixture');
    if (bout.status !== 'COMPLETED') unfinished = true;
    const players = possible.get(`${key}:${bout.boutNo}`);
    if (previous && [...players].some(player => possible.get(`${previous.key}:${previous.bout.boutNo}`).has(player))) {
      throw new Error(`One-match rest gap missing between ${previous.bout.officialBoutNo} (order ${previous.bout.matchOrder}) and ${bout.officialBoutNo} (order ${bout.matchOrder}). Insert another category's match`);
    }
    previous = entry;
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
  workbook.schedulePolicy = { minimumMatchGap: 1 };
  validateWorkbookSchedule(workbook, { contiguous: true });
}
