import { createHash } from 'node:crypto';
import { participantKey } from './fixtureProgression.js';

export const DESK_SHEET = 'Tournament Desk';
const FORMAT = 'sfts.fixtures';
const VERSION = 1;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max;
const categoryKey = values => JSON.stringify(values.map(value => String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')));
const fixtureKey = fixture => categoryKey([fixture.event.divisionLabel || fixture.event.division, fixture.event.gender, fixture.event.weightCategory, fixture.event.categoryGroup]);

// Must match Tournament Desk lib/exchange.ts, contract v1.
export function fixtureCanonical(fixture) {
  return JSON.stringify([
    fixture.divisionId, fixture.category,
    fixture.slots.map(player => player ? [player.id, player.name, player.club] : null),
    fixture.matches.map(match => [match.matchId, match.bout, match.stage, match.round, match.index, match.redSource, match.blueSource]),
  ]);
}

export const fixtureFingerprint = fixture => createHash('sha256').update(fixtureCanonical(fixture), 'utf8').digest('hex');

export function readDeskMetadata(rows) {
  if (rows === null || rows === undefined) return null; // Existing third-party workbooks remain supported.
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 8194 || JSON.stringify(rows[0]) !== JSON.stringify(['Format', 'Version', 'Chunk', 'Payload'])) throw new Error('Invalid Tournament Desk exchange sheet');
  let payload = '';
  for (const [index, row] of rows.slice(1).entries()) {
    if (row.length !== 4 || row[0] !== FORMAT || String(row[1]) !== String(VERSION) || String(row[2]) !== String(index + 1) || !text(row[3], 16000)) throw new Error('Unsupported or incomplete Tournament Desk exchange metadata');
    payload += row[3];
    if (payload.length > 4 * 1024 * 1024) throw new Error('Tournament Desk metadata exceeds 4 MB');
  }
  let metadata;
  try { metadata = JSON.parse(payload); } catch { throw new Error('Invalid Tournament Desk metadata JSON'); }
  if (!object(metadata) || metadata.format !== FORMAT || metadata.version !== VERSION || !object(metadata.event) || !text(metadata.event.id) || !text(metadata.event.name, 256) || !text(metadata.event.date, 10) || !Array.isArray(metadata.fixtures) || !metadata.fixtures.length || metadata.fixtures.length > 128) throw new Error('Unsupported Tournament Desk metadata format or version');
  return metadata;
}

export function validateDeskFixture(fixture) {
  const exchange = fixture.deskExchange;
  if (!object(exchange) || exchange.format !== FORMAT || exchange.version !== VERSION || !object(exchange.event) || !text(exchange.event.id) || !text(exchange.event.name, 256) || !text(exchange.event.date, 10)) throw new Error('Tournament Desk fixture identity is missing or invalid. Reimport a fresh Master Excel file.');
  const definition = exchange.definition;
  if (!object(definition) || !text(definition.divisionId) || !Array.isArray(definition.category) || definition.category.length !== 4 || !definition.category.every(value => typeof value === 'string' && value.length <= 64) || categoryKey(definition.category) !== fixtureKey(fixture) || !Array.isArray(definition.slots) || definition.slots.length !== fixture.openingBoutCount * 2 || !Array.isArray(definition.matches) || definition.matches.length !== fixture.schedule.length) throw new Error('Tournament Desk metadata does not match the imported category');
  const playerIds = new Set(), identities = new Set();
  for (const player of definition.slots) {
    if (player === null) continue;
    if (!object(player) || !text(player.id) || !text(player.name, 64) || !text(player.club, 64) || playerIds.has(player.id)) throw new Error('Invalid or duplicate Tournament Desk player ID');
    const key = participantKey({ playerName: player.name, club: player.club });
    if (identities.has(key)) throw new Error('Repeated Tournament Desk competitor identity');
    identities.add(key); playerIds.add(player.id);
  }
  const ids = new Set();
  for (const [index, match] of definition.matches.entries()) {
    const bout = fixture.schedule[index];
    if (!object(match) || !text(match.matchId) || ids.has(match.matchId) || match.bout !== bout.officialBoutNo || match.stage !== bout.stage || match.round !== bout.round || !Number.isSafeInteger(match.index) || match.index < 0) throw new Error('Tournament Desk match identity or bracket position differs');
    ids.add(match.matchId);
    const roundIndex = fixture.schedule.slice(0, index).filter(item => item.round === bout.round).length;
    const sourceId = number => number ? definition.matches[number - 1]?.matchId : null;
    if (match.index !== roundIndex || match.redSource !== sourceId(bout.redSourceBoutNo) || match.blueSource !== sourceId(bout.blueSourceBoutNo)) throw new Error('Tournament Desk winner sources differ from the approved bracket');
    if (index < fixture.openingBoutCount) for (const [side, offset] of [['RED', 0], ['BLUE', 1]]) {
      const expected = definition.slots[index * 2 + offset];
      const actual = bout[side];
      if (expected === null ? actual !== null : !actual || expected.name !== actual.playerName || expected.club !== actual.club) throw new Error('Tournament Desk opening competitors or corners differ');
    }
  }
  if (!text(definition.fingerprint, 64) || !/^[a-f0-9]{64}$/.test(definition.fingerprint) || definition.fingerprint !== fixtureFingerprint(definition)) throw new Error('Tournament Desk fixture fingerprint is invalid');
  return definition;
}

export function validateDeskRecords(fixture, records) {
  for (const record of records.filter(record => fixture.categoryId && record.manualBout?.categoryId === fixture.categoryId)) {
    if (record.manualBout.deskEventId !== fixture.deskExchange.event.id || record.manualBout.deskFixtureFingerprint !== fixture.deskExchange.definition.fingerprint) throw new Error('Saved scoreboard results belong to another or unlinked Tournament Desk fixture. Preserve that event before importing these fixtures.');
  }
}

export function attachDeskMetadata(workbook, metadata, records = []) {
  if (!metadata) return;
  if (!workbook || metadata.fixtures.length !== workbook.categories.length) throw new Error('Tournament Desk exchange requires all approved Matches and Schedule categories');
  const byCategory = new Map();
  const divisions = new Set(), matchIds = new Set();
  for (const definition of metadata.fixtures) {
    if (!object(definition) || !Array.isArray(definition.category)) throw new Error('Invalid Tournament Desk category metadata');
    const key = categoryKey(definition.category);
    if (byCategory.has(key) || divisions.has(definition.divisionId)) throw new Error('Duplicate Tournament Desk category metadata');
    byCategory.set(key, definition); divisions.add(definition.divisionId);
  }
  for (const { fixture } of workbook.categories) {
    const definition = byCategory.get(fixtureKey(fixture));
    fixture.deskExchange = { format: FORMAT, version: VERSION, event: metadata.event, definition };
    validateDeskFixture(fixture);
    for (const match of definition.matches) {
      if (matchIds.has(match.matchId)) throw new Error('Repeated Tournament Desk match ID across categories');
      matchIds.add(match.matchId);
    }
    // Do not silently attach results from a similarly named event or regenerated draw.
    validateDeskRecords(fixture, records);
  }
}

export function exportDeskResults(workbook, arenaNumber = '') {
  if (!workbook?.categories?.length) throw new Error('Import a fresh Tournament Desk Master Excel file before exporting its results.');
  const fixtures = [], results = [], seen = new Set();
  let eventId = null;
  for (const { fixture } of workbook.categories) {
    if (fixture.recoveryError) throw new Error('A category needs recovery review before its results can be exported.');
    const definition = validateDeskFixture(fixture);
    const id = fixture.deskExchange.event.id;
    if (eventId && eventId !== id) throw new Error('Cannot combine different Tournament Desk events');
    eventId = id;
    if (fixtures.some(ref => ref.divisionId === definition.divisionId)) throw new Error('Duplicate Tournament Desk division');
    fixtures.push({ divisionId: definition.divisionId, fingerprint: definition.fingerprint });
    const players = new Map(definition.slots.filter(Boolean).map(player => [participantKey({ playerName: player.name, club: player.club }), player.id]));
    for (const [index, bout] of fixture.schedule.entries()) {
      if (bout.status !== 'COMPLETED') continue;
      const matchId = definition.matches[index].matchId;
      const hongId = players.get(participantKey(bout.RED)), chungId = players.get(participantKey(bout.BLUE));
      if (!hongId || !chungId || hongId === chungId || !['RED', 'BLUE'].includes(bout.winner) || seen.has(matchId)) throw new Error('A completed scoreboard result has invalid participants or winner');
      seen.add(matchId);
      results.push({ divisionId: definition.divisionId, matchId, hongId, chungId, winnerId: bout.winner === 'RED' ? hongId : chungId });
    }
  }
  if (results.length > 8192) throw new Error('Too many completed results in this exchange');
  return { format: 'sfts.results', version: VERSION, eventId, exportedAt: new Date().toISOString(), arenaNumber, fixtures, results };
}
