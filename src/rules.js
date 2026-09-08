import { copyFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RULES_PATH = path.join(PROJECT_ROOT, 'config', 'rules.default.json');
const DEFAULT_ACTIVE_RULES_PATH = process.env.SFTS_RULES_FILE
  ? path.resolve(process.env.SFTS_RULES_FILE)
  : path.join(process.env.SFTS_DATA_DIR || path.join(process.cwd(), 'data'), 'active-rules.json');
const MAX_RULES_BYTES = 128 * 1024;
const SUPPORTED_RULE_SCHEMA_VERSION = 1;
const SOFTWARE_VERSION = '3.0.0';

const SUPPORTED_CAPABILITIES = new Set([
  'BEST_OF_THREE',
  'FINAL_SCORE',
  'POINT_GAP',
  'ROUND_GAMJEOM_LIMIT',
  'MAJORITY_VOTE',
  'TECHNICAL_COMBINATION',
  'KYESHI_MANUAL_DECISION',
  'GOLDEN_ROUND',
  'SUPERIORITY_DECISION',
  'MANUAL_MATCH_DECISIONS',
  'DYNAMIC_BREAK_DURATION',
  'SINGLE_ELIMINATION'
]);
const SUPPORTED_WINNER_METHODS = new Set([
  'FINAL_SCORE',
  'POINT_GAP',
  'ROUND_GAMJEOM_LIMIT',
  'KYESHI_MANUAL_DECISION',
  'GOLDEN_POINTS',
  'SUPERIORITY',
  'REFEREE_STOPS_CONTEST',
  'WITHDRAWAL',
  'DISQUALIFICATION',
  'PUNITIVE_DECLARATION',
  'UNSPORTSMANLIKE_DISQUALIFICATION'
]);

function fail(message) {
  throw new Error(`Invalid rules: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function requireString(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  return value.trim();
}

function requireInteger(value, name, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) fail(`${name} must be an integer >= ${minimum}`);
  return value;
}

function requireNumberArray(value, name, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !Number.isInteger(item) || item < minimum)) {
    fail(`${name} must be a non-empty array of integers >= ${minimum}`);
  }
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    fail(`${name} must be a non-empty array of strings`);
  }
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value;
}

function compareVersions(left, right) {
  const parse = value => String(value).split('.').map(part => Number(part));
  const a = parse(left);
  const b = parse(right);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function requireExactArray(value, expected, name) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    fail(`${name} must be [${expected.join(', ')}] for this software version`);
  }
}

export function validateRules(input) {
  const rules = structuredClone(input);
  requireObject(rules, 'root');
  if (rules.schemaVersion !== SUPPORTED_RULE_SCHEMA_VERSION) {
    fail(`schemaVersion ${rules.schemaVersion} is not supported`);
  }

  const metadata = requireObject(rules.ruleset, 'ruleset');
  requireString(metadata.id, 'ruleset.id');
  requireString(metadata.name, 'ruleset.name');
  requireString(metadata.federation, 'ruleset.federation');
  requireString(metadata.ruleVersion, 'ruleset.ruleVersion');
  requireString(metadata.effectiveFrom, 'ruleset.effectiveFrom', { nullable: true });
  requireString(metadata.source, 'ruleset.source');

  const compatibility = requireObject(rules.compatibility, 'compatibility');
  const minimumSoftwareVersion = requireString(compatibility.minimumSoftwareVersion, 'compatibility.minimumSoftwareVersion');
  const versionComparison = compareVersions(minimumSoftwareVersion, SOFTWARE_VERSION);
  if (versionComparison === null) fail('compatibility.minimumSoftwareVersion must use x.y.z format');
  if (versionComparison > 0) fail(`requires software ${minimumSoftwareVersion}, current software is ${SOFTWARE_VERSION}`);
  const capabilities = requireStringArray(compatibility.requiredCapabilities, 'compatibility.requiredCapabilities');
  if (capabilities.some(capability => !SUPPORTED_CAPABILITIES.has(capability))) {
    fail('compatibility.requiredCapabilities contains an unsupported capability');
  }

  const match = requireObject(rules.match, 'match');
  if (match.format !== 'BEST_OF_THREE') fail('match.format must be BEST_OF_THREE');
  if (match.rounds !== 3) fail('match.rounds must be 3 for this software version');
  if (match.roundsRequiredToWin !== 2) fail('match.roundsRequiredToWin must be 2 for this software version');
  requireInteger(match.roundDurationSeconds, 'match.roundDurationSeconds', { minimum: 1 });
  requireInteger(match.breakDurationSeconds, 'match.breakDurationSeconds', { minimum: 1 });
  requireInteger(match.minimumRoundDurationSeconds, 'match.minimumRoundDurationSeconds', { minimum: 1 });
  requireInteger(match.maximumRoundDurationSeconds, 'match.maximumRoundDurationSeconds', { minimum: 1 });
  if (match.minimumRoundDurationSeconds > match.roundDurationSeconds ||
      match.roundDurationSeconds > match.maximumRoundDurationSeconds) {
    fail('match duration limits do not contain the default round duration');
  }

  const scoring = requireObject(rules.scoring, 'scoring');
  requireExactArray(scoring.basePointValues, [1, 2, 3], 'scoring.basePointValues');
  if (scoring.basePointLabels === undefined) {
    scoring.basePointLabels = { '1': 'PUNCH', '2': 'CHEST', '3': 'HEAD' };
  }
  const basePointLabels = requireObject(scoring.basePointLabels, 'scoring.basePointLabels');
  for (const point of scoring.basePointValues) {
    requireString(basePointLabels[String(point)], `scoring.basePointLabels.${point}`);
  }
  const acceptedPointValues = requireNumberArray(scoring.acceptedPointValues, 'scoring.acceptedPointValues', { minimum: 1 });
  if (scoring.basePointValues.some(point => !acceptedPointValues.includes(point))) {
    fail('scoring.acceptedPointValues must include all base point values');
  }
  const technicalInput = requireObject(scoring.technicalInput, 'scoring.technicalInput');
  if (typeof technicalInput.enabled !== 'boolean') fail('scoring.technicalInput.enabled must be boolean');
  requireInteger(technicalInput.windowMilliseconds, 'scoring.technicalInput.windowMilliseconds', { minimum: 1 });
  const eligibleBasePoints = requireNumberArray(technicalInput.eligibleBasePoints, 'scoring.technicalInput.eligibleBasePoints', { minimum: 1 });
  if (eligibleBasePoints.some(point => !scoring.basePointValues.includes(point))) {
    fail('scoring.technicalInput.eligibleBasePoints must be base point values');
  }
  const pointsByBasePoints = requireObject(technicalInput.pointsByBasePoints, 'scoring.technicalInput.pointsByBasePoints');
  for (const point of eligibleBasePoints) {
    const technicalPoints = pointsByBasePoints[String(point)];
    requireInteger(technicalPoints, `scoring.technicalInput.pointsByBasePoints.${point}`, { minimum: 1 });
    if (!acceptedPointValues.includes(technicalPoints)) {
      fail(`technical point value ${technicalPoints} is not accepted by this software version`);
    }
  }
  requireInteger(scoring.gamJeomPointValue, 'scoring.gamJeomPointValue', { minimum: 1 });

  const gamJeom = requireObject(requireObject(rules.penalties, 'penalties').gamJeom, 'penalties.gamJeom');
  if (typeof gamJeom.awardsPointToOpponent !== 'boolean') fail('penalties.gamJeom.awardsPointToOpponent must be boolean');
  requireInteger(gamJeom.roundLossAt, 'penalties.gamJeom.roundLossAt', { minimum: 1 });
  if (gamJeom.matchLossAt !== null) requireInteger(gamJeom.matchLossAt, 'penalties.gamJeom.matchLossAt', { minimum: 1 });
  if (gamJeom.matchLossAt !== null || gamJeom.accumulateAcrossRounds !== false) {
    fail('match-level or cross-round gam-jeom rules are not supported in Stage 1');
  }

  const decisions = requireObject(rules.decisions, 'decisions');
  const pointGap = requireObject(decisions.pointGap, 'decisions.pointGap');
  if (typeof pointGap.enabled !== 'boolean') fail('decisions.pointGap.enabled must be boolean');
  requireInteger(pointGap.difference, 'decisions.pointGap.difference', { minimum: 1 });
  requireExactArray(pointGap.appliesToRounds, [1, 2, 3], 'decisions.pointGap.appliesToRounds');
  if (decisions.roundTie?.type !== 'DRAW') fail('decisions.roundTie.type must be DRAW');
  if (!['MANUAL_TOURNAMENT_RESOLUTION', 'GOLDEN_OR_WOO_SE_GIROK'].includes(decisions.unresolvedMatchTie?.type)) {
    fail('decisions.unresolvedMatchTie.type must be MANUAL_TOURNAMENT_RESOLUTION or GOLDEN_OR_WOO_SE_GIROK');
  }
  const winnerMethods = requireStringArray(decisions.winnerMethods, 'decisions.winnerMethods');
  if (!winnerMethods.includes('FINAL_SCORE') || winnerMethods.some(method => !SUPPORTED_WINNER_METHODS.has(method))) {
    fail('decisions.winnerMethods contains an unsupported or missing winner method');
  }

  const voting = requireObject(rules.voting, 'voting');
  if (voting.mode !== 'STRICT_MAJORITY') fail('voting.mode must be STRICT_MAJORITY');
  requireInteger(voting.minimumActiveRemotes, 'voting.minimumActiveRemotes', { minimum: 1 });
  requireInteger(voting.maximumActiveRemotes, 'voting.maximumActiveRemotes', { minimum: 1 });
  if (voting.minimumActiveRemotes > 1 || voting.maximumActiveRemotes > 4 ||
      voting.minimumActiveRemotes > voting.maximumActiveRemotes) {
    fail('voting remote limits are outside this software capability');
  }

  const kyeShi = requireObject(requireObject(rules.medical, 'medical').kyeShi, 'medical.kyeShi');
  if (typeof kyeShi.enabled !== 'boolean') fail('medical.kyeShi.enabled must be boolean');
  requireInteger(kyeShi.limitSeconds, 'medical.kyeShi.limitSeconds', { minimum: 1 });
  if (kyeShi.onLimit !== 'MANUAL_WINNER') fail('medical.kyeShi.onLimit must be MANUAL_WINNER');

  const tournament = requireObject(rules.tournament, 'tournament');
  if (tournament.format !== 'SINGLE_ELIMINATION') fail('tournament.format must be SINGLE_ELIMINATION');
  requireExactArray(tournament.groupBy, ['GENDER', 'WEIGHT_CATEGORY'], 'tournament.groupBy');
  if (tournament.byes !== 'AUTOMATIC') fail('tournament.byes must be AUTOMATIC');
  if (tournament.seeding !== 'SEEDED_RANDOM') fail('tournament.seeding must be SEEDED_RANDOM');

  return rules;
}

export function rulesMetadata(rules) {
  const metadata = rules.ruleset;
  return {
    id: metadata.id,
    name: metadata.name,
    federation: metadata.federation,
    ruleVersion: metadata.ruleVersion,
    effectiveFrom: metadata.effectiveFrom,
    source: metadata.source,
    schemaVersion: rules.schemaVersion
  };
}

export async function readRulesFile(filePath) {
  const contents = await readFile(filePath);
  if (contents.byteLength > MAX_RULES_BYTES) throw new Error(`file is larger than ${MAX_RULES_BYTES} bytes`);
  return validateRules(JSON.parse(contents.toString('utf8')));
}

export async function loadRules({ activePath = DEFAULT_ACTIVE_RULES_PATH, defaultPath = DEFAULT_RULES_PATH, logger = console } = {}) {
  const defaults = await readRulesFile(defaultPath);
  try {
    return await readRulesFile(activePath);
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`Ignoring active rules at ${activePath}: ${error.message}`);
    return defaults;
  }
}

export const rulesPaths = Object.freeze({
  default: DEFAULT_RULES_PATH,
  active: DEFAULT_ACTIVE_RULES_PATH,
  backup: `${DEFAULT_ACTIVE_RULES_PATH}.backup`
});

export const rulesConstants = Object.freeze({
  maxBytes: MAX_RULES_BYTES,
  schemaVersion: SUPPORTED_RULE_SCHEMA_VERSION,
  softwareVersion: SOFTWARE_VERSION
});

export async function writeRulesAtomically(input, {
  activePath = rulesPaths.active,
  backupPath = rulesPaths.backup,
  backupRules = null
} = {}) {
  const rules = validateRules(input);
  await mkdir(path.dirname(activePath), { recursive: true });
  await mkdir(path.dirname(backupPath), { recursive: true });

  let activeExists = false;
  try {
    if ((await lstat(backupPath)).isSymbolicLink()) throw new Error('rules backup path must not be a symbolic link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let backupExists = false;
  try {
    backupExists = (await lstat(backupPath)).isFile();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    if ((await lstat(activePath)).isSymbolicLink()) throw new Error('active rules path must not be a symbolic link');
    activeExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (activeExists) {
    await copyFile(activePath, backupPath);
  } else if (!backupExists && backupRules !== null) {
    const previousRules = validateRules(backupRules);
    const backupTemporaryPath = `${backupPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const handle = await open(backupTemporaryPath, 'wx', 0o640);
      try {
        await handle.writeFile(`${JSON.stringify(previousRules, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(backupTemporaryPath, backupPath);
    } catch (error) {
      await rm(backupTemporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  const temporaryPath = `${activePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o640);
    try {
      await handle.writeFile(`${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, activePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
