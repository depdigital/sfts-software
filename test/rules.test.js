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
  assert.equal(rules.penalties.gamJeom.roundLossAt, 5);
  assert.equal(rules.tieBreak.goldenRound.scoreToWin, 2);
  assert.equal(rules.match.breakDurationPolicy.tiers[0].breakDurationSeconds, 60);
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

test('unsupported rule capabilities are rejected instead of being silently ignored', async () => {
  const rules = await defaultRules();
  rules.compatibility.requiredCapabilities.push('WT_SUPERIORITY');

  assert.throws(() => validateRules(rules), /unsupported capability/);
});

test('commented v2 packs and legacy v1 packs are accepted safely', async () => {
  const commented = parseRulesText(`// allowed comment\n{ "schemaVersion": 2, "url": "https://rules.example/pack" }`);
  assert.equal(commented.url, 'https://rules.example/pack');

  const legacy = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(process.cwd(), 'test', 'fixtures', 'scoring-test-pack.json'), 'utf8'));
  const migrated = validateRules(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.tieBreak.goldenRound.scoreToWin, 2);
  assert.equal(migrated.match.breakDurationPolicy.defaultDurationSeconds, 35);
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
