import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadRules, rulesMetadata, validateRules } from '../src/rules.js';

async function defaultRules() {
  const contents = await readFile(path.join(process.cwd(), 'config', 'rules.default.json'), 'utf8');
  return JSON.parse(contents);
}

test('the built-in ruleset is valid and describes the current behavior', async () => {
  const rules = validateRules(await defaultRules());

  assert.equal(rules.match.format, 'BEST_OF_THREE');
  assert.deepEqual(rules.scoring.basePointValues, [1, 2, 3]);
  assert.equal(rules.scoring.technicalInput.pointsByBasePoints['3'], 6);
  assert.equal(rules.decisions.pointGap.difference, 15);
  assert.equal(rules.penalties.gamJeom.roundLossAt, 5);
  assert.deepEqual(rulesMetadata(rules), {
    id: 'sfts-current',
    name: 'SFTS Current Rules',
    federation: 'SFTS',
    ruleVersion: 'current',
    effectiveFrom: null,
    source: 'Built-in SFTS rules',
    schemaVersion: 1
  });
});

test('unsupported rule capabilities are rejected instead of being silently ignored', async () => {
  const rules = await defaultRules();
  rules.compatibility.requiredCapabilities.push('WT_SUPERIORITY');

  assert.throws(() => validateRules(rules), /unsupported capability/);
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
