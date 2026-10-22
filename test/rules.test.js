import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadRules,
  parseRulesText,
  readRulesFile,
  rulesMetadata,
  validateRules,
  writeRulesAtomically
} from '../src/rules.js';

async function defaultRules() {
  return readRulesFile(path.join(process.cwd(), 'config', 'rules.default.json'));
}

test('the built-in ruleset is valid and describes the current behavior', async () => {
  const rules = validateRules(await defaultRules());

  assert.equal(rules.match.format, 'BEST_OF_N_ROUNDS');
  assert.deepEqual(rules.scoring.basePointValues, [1, 2, 3]);
  assert.equal(rules.scoring.basePointLabels['1'], 'PUNCH');
  assert.equal(rules.scoring.technicalInput.pointsByBasePoints['3'], 6);
  assert.equal(rules.decisions.pointGap.difference, 15);
  assert.deepEqual(rules.decisions.roundTie, {
    type: 'SUPERIORITY',
    criteria: ['TECHNICAL_HEAD_KICKS', 'TECHNICAL_CHEST_KICKS', 'NORMAL_HEAD_KICKS'],
    unresolved: 'WOO_SE_GIROK'
  });
  assert.equal(rules.penalties.gamJeom.roundLossAt, 5);
  assert.equal(rules.tieBreak.goldenRound.scoreToWin, 2);
  assert.equal(rules.match.breakDurationPolicy.tiers[0].breakDurationSeconds, 60);
  assert.equal(rules.tournament.placements.enabled, true);
  assert.equal(rules.tournament.placements.thirdPlacePolicy, 'BOTH_SEMIFINAL_LOSERS');
  assert.deepEqual(rules.tournament.placements.labels, { first: '1ST', second: '2ND', third: '3RD' });
  assert.deepEqual(rules.tournament.groupBy, ['DIVISION', 'GENDER', 'CATEGORY']);
  assert.deepEqual(rules.tournament.divisions.map(division => division.id), ['SENIOR', 'JUNIOR', 'CADET', 'SUB_JUNIOR']);
  assert.equal(rules.tournament.divisions.find(division => division.id === 'SENIOR').weightCategories.MALE.length, 8);
  assert.equal(rules.tournament.divisions.find(division => division.id === 'JUNIOR').weightCategories.FEMALE.length, 10);
  const subJunior = rules.tournament.divisions.find(division => division.id === 'SUB_JUNIOR');
  assert.equal(subJunior.categoryType, 'WEIGHT');
  assert.equal(subJunior.weightCategories.MALE.length, 14);
  assert.equal(subJunior.weightCategories.FEMALE.length, 14);
  assert.equal(subJunior.weightCategories.MALE[0].name, 'UNDER 16 KG');
  assert.equal(subJunior.weightCategories.FEMALE[13].name, 'UNDER 57 KG');
  assert.deepEqual(rulesMetadata(rules), {
    id: 'sfts-current',
    name: 'SFTS Default Rules',
    federation: 'WTF',
    ruleVersion: '2026.1',
    effectiveFrom: null,
    source: 'Built-in SFTS rules',
    schemaVersion: 2
  });
});

test('round-tie superiority is rule-pack controlled while legacy draws remain valid', async () => {
  const rules = await defaultRules();
  rules.decisions.roundTie.criteria = ['NORMAL_HEAD_KICKS', 'TECHNICAL_HEAD_KICKS'];
  assert.deepEqual(validateRules(rules).decisions.roundTie.criteria, ['NORMAL_HEAD_KICKS', 'TECHNICAL_HEAD_KICKS']);

  rules.decisions.roundTie = { type: 'DRAW' };
  assert.deepEqual(validateRules(rules).decisions.roundTie, { type: 'DRAW' });

  rules.decisions.roundTie = {
    type: 'SUPERIORITY',
    criteria: ['TECHNICAL_HEAD_KICKS', 'UNKNOWN_KICKS'],
    unresolved: 'WOO_SE_GIROK'
  };
  assert.throws(() => validateRules(rules), /unsupported criterion/);
});

test('unsupported rule capabilities are rejected instead of being silently ignored', async () => {
  const rules = await defaultRules();
  rules.compatibility.requiredCapabilities.push('WT_SUPERIORITY');

  assert.throws(() => validateRules(rules), /unsupported capability/);
});

test('commented v2 packs and legacy v1 packs are accepted safely', async () => {
  const commented = parseRulesText(`// allowed comment\n{ "schemaVersion": 2, "url": "https://rules.example/pack" }`);
  assert.equal(commented.url, 'https://rules.example/pack');

  const olderV2 = await defaultRules();
  delete olderV2.tournament.placements;
  delete olderV2.tournament.divisions;
  olderV2.tournament.groupBy = ['GENDER', 'WEIGHT_CATEGORY'];
  olderV2.compatibility.requiredCapabilities = olderV2.compatibility.requiredCapabilities
    .filter(capability => capability !== 'TOURNAMENT_PLACEMENTS' && capability !== 'TOURNAMENT_DIVISIONS');
  const normalizedV2 = validateRules(olderV2);
  assert.equal(normalizedV2.tournament.placements.enabled, true);
  assert.equal(normalizedV2.tournament.placements.thirdPlacePolicy, 'BOTH_SEMIFINAL_LOSERS');
  assert.deepEqual(normalizedV2.tournament.groupBy, ['DIVISION', 'GENDER', 'CATEGORY']);
  assert.deepEqual(normalizedV2.tournament.divisions, (await defaultRules()).tournament.divisions);

  const legacy = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(process.cwd(), 'test', 'fixtures', 'scoring-test-pack.json'), 'utf8'));
  const migrated = validateRules(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.tieBreak.afterRegulation.type, 'GOLDEN_OR_WOO_SE_GIROK');
  assert.deepEqual(migrated.tieBreak.afterRegulation.options, ['GOLDEN_ROUND', 'WOO_SE_GIROK']);
  assert.equal(migrated.tieBreak.goldenRound.enabled, true);
  assert.equal(migrated.tieBreak.wooSeGirok.enabled, true);
  assert.ok(migrated.decisions.winnerMethods.includes('GOLDEN_POINTS'));
  assert.ok(migrated.decisions.winnerMethods.includes('SUPERIORITY'));
  assert.equal(migrated.tieBreak.goldenRound.scoreToWin, 2);
  assert.equal(migrated.match.breakDurationPolicy.defaultDurationSeconds, 35);
  assert.equal(migrated.tournament.placements.enabled, true);
  assert.equal(migrated.tournament.placements.thirdPlacePolicy, 'BOTH_SEMIFINAL_LOSERS');
});

test('previously saved v2 manual tie packs are upgraded to both supported tie choices', async () => {
  const oldRules = await defaultRules();
  oldRules.tieBreak.afterRegulation = { type: 'MANUAL_TOURNAMENT_RESOLUTION', options: [] };
  oldRules.tieBreak.goldenRound.enabled = false;
  oldRules.tieBreak.wooSeGirok.enabled = false;
  oldRules.decisions.winnerMethods = oldRules.decisions.winnerMethods
    .filter(method => method !== 'GOLDEN_POINTS' && method !== 'SUPERIORITY');
  oldRules.compatibility.requiredCapabilities = oldRules.compatibility.requiredCapabilities
    .filter(capability => capability !== 'GOLDEN_ROUND' && capability !== 'SUPERIORITY_DECISION');

  const upgraded = validateRules(oldRules);

  assert.equal(upgraded.tieBreak.afterRegulation.type, 'GOLDEN_OR_WOO_SE_GIROK');
  assert.deepEqual(upgraded.tieBreak.afterRegulation.options, ['GOLDEN_ROUND', 'WOO_SE_GIROK']);
  assert.equal(upgraded.tieBreak.goldenRound.enabled, true);
  assert.equal(upgraded.tieBreak.wooSeGirok.enabled, true);
  assert.ok(upgraded.decisions.winnerMethods.includes('GOLDEN_POINTS'));
  assert.ok(upgraded.decisions.winnerMethods.includes('SUPERIORITY'));
  assert.ok(upgraded.compatibility.requiredCapabilities.includes('GOLDEN_ROUND'));
  assert.ok(upgraded.compatibility.requiredCapabilities.includes('SUPERIORITY_DECISION'));
});

test('loadRules upgrades a persisted v2 manual tie pack during server startup', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-rules-manual-tie-'));
  const activePath = path.join(tempDir, 'active-rules.json');
  try {
    const oldRules = await defaultRules();
    oldRules.tieBreak.afterRegulation = { type: 'MANUAL_TOURNAMENT_RESOLUTION', options: [] };
    oldRules.tieBreak.goldenRound.enabled = false;
    oldRules.tieBreak.wooSeGirok.enabled = false;
    oldRules.decisions.winnerMethods = oldRules.decisions.winnerMethods
      .filter(method => method !== 'GOLDEN_POINTS' && method !== 'SUPERIORITY');
    await writeFile(activePath, JSON.stringify(oldRules));

    const loaded = await loadRules({ activePath });

    assert.deepEqual(loaded.tieBreak.afterRegulation.options, ['GOLDEN_ROUND', 'WOO_SE_GIROK']);
    assert.equal(loaded.tieBreak.goldenRound.enabled, true);
    assert.equal(loaded.tieBreak.wooSeGirok.enabled, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('v2 rule packs cannot hide either mandatory regulation tie choice', async () => {
  const rules = await defaultRules();
  rules.tieBreak.afterRegulation.options = ['GOLDEN_ROUND'];

  assert.throws(() => validateRules(rules), /must include GOLDEN_ROUND and WOO_SE_GIROK/);
});

test('unsupported tournament placement policies are rejected safely', async () => {
  const rules = await defaultRules();
  rules.tournament.placements.thirdPlacePolicy = 'BRONZE_MEDAL_BOUT';

  assert.throws(() => validateRules(rules), /thirdPlacePolicy must be BOTH_SEMIFINAL_LOSERS/);
});

test('invalid tournament division definitions are rejected safely', async () => {
  const rules = await defaultRules();
  rules.tournament.divisions[0].weightCategories.MALE = [];

  assert.throws(() => validateRules(rules), /weightCategories\.MALE must be a non-empty array/);
});

test('a valid active rules file is loaded and an invalid one falls back to defaults', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-rules-'));
  const activePath = path.join(tempDir, 'active-rules.json');
  const warnings = [];
  try {
    const activeRules = await defaultRules();
    activeRules.ruleset.ruleVersion = 'test-active';
    activeRules.decisions.pointGap.difference = 16;
    await writeFile(activePath, JSON.stringify(activeRules));

    const loaded = await loadRules({ activePath, logger: { warn: message => warnings.push(message) } });
    assert.equal(loaded.ruleset.ruleVersion, 'test-active');
    assert.equal(loaded.decisions.pointGap.difference, 16);

    await writeFile(activePath, '{"schemaVersion": 999}');
    const fallback = await loadRules({ activePath, logger: { warn: message => warnings.push(message) } });
    assert.equal(fallback.ruleset.id, 'sfts-current');
    assert.equal(fallback.decisions.pointGap.difference, 15);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rules are written atomically and the previous active pack is backed up', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-rules-write-'));
  const activePath = path.join(tempDir, 'active-rules.json');
  const backupPath = path.join(tempDir, 'active-rules.json.backup');
  try {
    const firstRules = await defaultRules();
    const secondRules = await defaultRules();
    secondRules.ruleset.ruleVersion = 'second';
    await writeRulesAtomically(firstRules, { activePath, backupPath, backupRules: firstRules });
    assert.equal((await readRulesFile(backupPath)).ruleset.ruleVersion, '2026.1');
    await writeRulesAtomically(secondRules, { activePath, backupPath });

    assert.equal((await readRulesFile(activePath)).ruleset.ruleVersion, 'second');
    assert.equal((await readRulesFile(backupPath)).ruleset.ruleVersion, '2026.1');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
