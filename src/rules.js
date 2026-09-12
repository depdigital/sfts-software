import { copyFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RULES_PATH = path.join(PROJECT_ROOT, 'config', 'rules.default.json');
const DEFAULT_ACTIVE_RULES_PATH = process.env.SFTS_RULES_FILE
  ? path.resolve(process.env.SFTS_RULES_FILE)
  : path.join(process.env.SFTS_DATA_DIR || path.join(process.cwd(), 'data'), 'active-rules.json');
const MAX_RULES_BYTES = 128 * 1024;
const SUPPORTED_RULE_SCHEMA_VERSION = 2;
const LEGACY_RULE_SCHEMA_VERSION = 1;
const SOFTWARE_VERSION = '3.0.0';

// Capabilities describe engine features. They are deliberately not competition rules.
const SUPPORTED_CAPABILITIES = new Set([
  'BEST_OF_THREE', 'BEST_OF_N_ROUNDS', 'FINAL_SCORE', 'POINT_GAP',
  'ROUND_GAMJEOM_LIMIT', 'MATCH_GAMJEOM_LIMIT', 'MAJORITY_VOTE',
  'TECHNICAL_COMBINATION', 'KYESHI_MANUAL_DECISION', 'GOLDEN_ROUND',
  'SUPERIORITY_DECISION', 'MANUAL_MATCH_DECISIONS', 'DYNAMIC_BREAK_DURATION',
  'SINGLE_ELIMINATION', 'TOURNAMENT_PLACEMENTS', 'TOURNAMENT_DIVISIONS', 'RULE_PACK_V2'
]);
const SUPPORTED_WINNER_METHODS = new Set([
  'FINAL_SCORE', 'POINT_GAP', 'ROUND_GAMJEOM_LIMIT', 'MATCH_GAMJEOM_LIMIT',
  'KYESHI_MANUAL_DECISION', 'GOLDEN_POINTS', 'SUPERIORITY',
  'REFEREE_STOPS_CONTEST', 'WITHDRAWAL', 'DISQUALIFICATION',
  'PUNITIVE_DECLARATION', 'UNSPORTSMANLIKE_DISQUALIFICATION'
]);
const SUPPORTED_MANUAL_DECISIONS = new Set(['RSC', 'WDR', 'DSQ', 'PUN', 'DQB']);
const SUPPORTED_TIE_OPTIONS = new Set(['GOLDEN_ROUND', 'WOO_SE_GIROK']);
const REQUIRED_TIE_OPTIONS = Object.freeze(['GOLDEN_ROUND', 'WOO_SE_GIROK']);
const SUPPORTED_SUPERIORITY_CRITERIA = new Set([
  'GOLDEN_ROUND_PUNCH', 'GOLDEN_ROUND_HIT_COUNT', 'REGULATION_ROUNDS_WON',
  'FEWER_TOTAL_GAMJEOMS', 'REFEREE_DECISION'
]);
const DEFAULT_TOURNAMENT_PLACEMENTS = Object.freeze({
  enabled: true,
  thirdPlacePolicy: 'BOTH_SEMIFINAL_LOSERS',
  labels: Object.freeze({ first: '1ST', second: '2ND', third: '3RD' })
});
const DEFAULT_TOURNAMENT_GROUP_BY = Object.freeze(['DIVISION', 'GENDER', 'CATEGORY']);
const DEFAULT_TOURNAMENT_DIVISIONS = Object.freeze([
  {
    id: 'SENIOR', label: 'SENIOR', ageLabel: '18 YEARS OLD AND ABOVE', categoryType: 'WEIGHT',
    weightCategories: {
      MALE: [
        { name: 'FINWEIGHT', limit: 'NOT EXCEEDING 54.0 KG' },
        { name: 'FLYWEIGHT', limit: 'OVER 54.1 TO 58.0 KG' },
        { name: 'BANTAMWEIGHT', limit: 'OVER 58.1 TO 63.0 KG' },
        { name: 'FEATHERWEIGHT', limit: 'OVER 63.1 TO 68.0 KG' },
        { name: 'LIGHTWEIGHT', limit: 'OVER 68.1 TO 74.0 KG' },
        { name: 'WELTERWEIGHT', limit: 'OVER 74.1 TO 80.0 KG' },
        { name: 'MIDDLEWEIGHT', limit: 'OVER 80.1 TO 87.0 KG' },
        { name: 'HEAVYWEIGHT', limit: 'OVER 87.1 KG' }
      ],
      FEMALE: [
        { name: 'FINWEIGHT', limit: 'NOT EXCEEDING 46.0 KG' },
        { name: 'FLYWEIGHT', limit: 'OVER 46.1 TO 49.0 KG' },
        { name: 'BANTAMWEIGHT', limit: 'OVER 49.1 TO 53.0 KG' },
        { name: 'FEATHERWEIGHT', limit: 'OVER 53.1 TO 57.0 KG' },
        { name: 'LIGHTWEIGHT', limit: 'OVER 57.1 TO 62.0 KG' },
        { name: 'WELTERWEIGHT', limit: 'OVER 62.1 TO 67.0 KG' },
        { name: 'MIDDLEWEIGHT', limit: 'OVER 67.1 TO 74.0 KG' },
        { name: 'HEAVYWEIGHT', limit: 'OVER 74.1 KG' }
      ]
    }
  },
  {
    id: 'JUNIOR', label: 'JUNIOR', ageLabel: '15-17 YEARS OLD', categoryType: 'WEIGHT',
    weightCategories: {
      MALE: [
        { name: 'FINWEIGHT', limit: 'NOT EXCEEDING 45.0 KG' },
        { name: 'FLYWEIGHT', limit: 'OVER 45.1 TO 48.0 KG' },
        { name: 'BANTAMWEIGHT', limit: 'OVER 48.1 TO 51.0 KG' },
        { name: 'FEATHERWEIGHT', limit: 'OVER 51.1 TO 55.0 KG' },
        { name: 'LIGHTWEIGHT', limit: 'OVER 55.1 TO 59.0 KG' },
        { name: 'WELTERWEIGHT', limit: 'OVER 59.1 TO 63.0 KG' },
        { name: 'LT MIDDLEWEIGHT', limit: 'OVER 63.1 TO 68.0 KG' },
        { name: 'MIDDLEWEIGHT', limit: 'OVER 68.1 TO 73.0 KG' },
        { name: 'LT HEAVYWEIGHT', limit: 'OVER 73.1 TO 78.0 KG' },
        { name: 'HEAVYWEIGHT', limit: 'OVER 78.1 KG' }
      ],
      FEMALE: [
        { name: 'FINWEIGHT', limit: 'NOT EXCEEDING 42.0 KG' },
        { name: 'FLYWEIGHT', limit: 'OVER 42.1 TO 44.0 KG' },
        { name: 'BANTAMWEIGHT', limit: 'OVER 44.1 TO 46.0 KG' },
        { name: 'FEATHERWEIGHT', limit: 'OVER 46.1 TO 49.0 KG' },
        { name: 'LIGHTWEIGHT', limit: 'OVER 49.1 TO 52.0 KG' },
        { name: 'WELTERWEIGHT', limit: 'OVER 52.1 TO 55.0 KG' },
        { name: 'LT MIDDLEWEIGHT', limit: 'OVER 55.1 TO 59.0 KG' },
        { name: 'MIDDLEWEIGHT', limit: 'OVER 59.1 TO 63.0 KG' },
        { name: 'LT HEAVYWEIGHT', limit: 'OVER 63.1 TO 68.0 KG' },
        { name: 'HEAVYWEIGHT', limit: 'OVER 68.1 KG' }
      ]
    }
  },
  {
    id: 'CADET', label: 'CADET', ageLabel: '12-14 YEARS OLD', categoryType: 'WEIGHT',
    weightCategories: {
      MALE: [
        { name: 'FINWEIGHT', limit: 'NOT EXCEEDING 33.0 KG' },
        { name: 'FLYWEIGHT', limit: 'OVER 33.1 TO 37.0 KG' },
        { name: 'BANTAMWEIGHT', limit: 'OVER 37.1 TO 41.0 KG' },
        { name: 'FEATHERWEIGHT', limit: 'OVER 41.1 TO 45.0 KG' },
        { name: 'LIGHTWEIGHT', limit: 'OVER 45.1 TO 49.0 KG' },
        { name: 'WELTERWEIGHT', limit: 'OVER 49.1 TO 53.0 KG' },
        { name: 'LT MIDDLEWEIGHT', limit: 'OVER 53.1 TO 57.0 KG' },
        { name: 'MIDDLEWEIGHT', limit: 'OVER 57.1 TO 61.0 KG' },
        { name: 'LT HEAVYWEIGHT', limit: 'OVER 61.1 TO 65.0 KG' },
        { name: 'HEAVYWEIGHT', limit: 'OVER 65.1 KG' }
      ],
      FEMALE: [
        { name: 'FINWEIGHT', limit: 'NOT EXCEEDING 29.0 KG' },
        { name: 'FLYWEIGHT', limit: 'OVER 29.1 TO 33.0 KG' },
        { name: 'BANTAMWEIGHT', limit: 'OVER 33.1 TO 37.0 KG' },
        { name: 'FEATHERWEIGHT', limit: 'OVER 37.1 TO 41.0 KG' },
        { name: 'LIGHTWEIGHT', limit: 'OVER 41.1 TO 44.0 KG' },
        { name: 'WELTERWEIGHT', limit: 'OVER 44.1 TO 47.0 KG' },
        { name: 'LT MIDDLEWEIGHT', limit: 'OVER 47.1 TO 51.0 KG' },
        { name: 'MIDDLEWEIGHT', limit: 'OVER 51.1 TO 55.0 KG' },
        { name: 'LT HEAVYWEIGHT', limit: 'OVER 55.1 TO 59.0 KG' },
        { name: 'HEAVYWEIGHT', limit: 'OVER 59.1 KG' }
      ]
    }
  },
  {
    id: 'SUB_JUNIOR', label: 'SUB JUNIOR', ageLabel: '11 YEARS OLD AND BELOW', categoryType: 'WEIGHT',
    weightCategories: {
      MALE: [
        { name: 'UNDER 16 KG', limit: 'NOT EXCEEDING 16.0 KG' },
        { name: 'UNDER 18 KG', limit: 'OVER 16.0 TO 18.0 KG' },
        { name: 'UNDER 21 KG', limit: 'OVER 18.0 TO 21.0 KG' },
        { name: 'UNDER 23 KG', limit: 'OVER 21.0 TO 23.0 KG' },
        { name: 'UNDER 25 KG', limit: 'OVER 23.0 TO 25.0 KG' },
        { name: 'UNDER 27 KG', limit: 'OVER 25.0 TO 27.0 KG' },
        { name: 'UNDER 29 KG', limit: 'OVER 27.0 TO 29.0 KG' },
        { name: 'UNDER 32 KG', limit: 'OVER 29.0 TO 32.0 KG' },
        { name: 'UNDER 35 KG', limit: 'OVER 32.0 TO 35.0 KG' },
        { name: 'UNDER 38 KG', limit: 'OVER 35.0 TO 38.0 KG' },
        { name: 'UNDER 41 KG', limit: 'OVER 38.0 TO 41.0 KG' },
        { name: 'UNDER 44 KG', limit: 'OVER 41.0 TO 44.0 KG' },
        { name: 'UNDER 50 KG', limit: 'OVER 44.0 TO 50.0 KG' },
        { name: 'UNDER 60 KG', limit: 'OVER 50.0 TO 60.0 KG' }
      ],
      FEMALE: [
        { name: 'UNDER 14 KG', limit: 'NOT EXCEEDING 14.0 KG' },
        { name: 'UNDER 16 KG', limit: 'OVER 14.0 TO 16.0 KG' },
        { name: 'UNDER 18 KG', limit: 'OVER 16.0 TO 18.0 KG' },
        { name: 'UNDER 20 KG', limit: 'OVER 18.0 TO 20.0 KG' },
        { name: 'UNDER 22 KG', limit: 'OVER 20.0 TO 22.0 KG' },
        { name: 'UNDER 24 KG', limit: 'OVER 22.0 TO 24.0 KG' },
        { name: 'UNDER 26 KG', limit: 'OVER 24.0 TO 26.0 KG' },
        { name: 'UNDER 29 KG', limit: 'OVER 26.0 TO 29.0 KG' },
        { name: 'UNDER 32 KG', limit: 'OVER 29.0 TO 32.0 KG' },
        { name: 'UNDER 35 KG', limit: 'OVER 32.0 TO 35.0 KG' },
        { name: 'UNDER 38 KG', limit: 'OVER 35.0 TO 38.0 KG' },
        { name: 'UNDER 41 KG', limit: 'OVER 38.0 TO 41.0 KG' },
        { name: 'UNDER 47 KG', limit: 'OVER 41.0 TO 47.0 KG' },
        { name: 'UNDER 57 KG', limit: 'OVER 47.0 TO 57.0 KG' }
      ]
    }
  }
]);

function fail(message) { throw new Error(`Invalid rules: ${message}`); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireObject(value, name) { if (!isObject(value)) fail(`${name} must be an object`); return value; }
function requireString(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  return value.trim();
}
function requireBoolean(value, name) { if (typeof value !== 'boolean') fail(`${name} must be boolean`); return value; }
function requireInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
function requireNumberArray(value, name, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !Number.isInteger(item) || item < minimum)) fail(`${name} must be a non-empty array of integers >= ${minimum}`);
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value;
}
function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) fail(`${name} must be a non-empty array of strings`);
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value;
}
function compareVersions(left, right) {
  const parse = value => String(value).split('.').map(part => Number(part));
  const a = parse(left); const b = parse(right);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** Parse JSONC safely: comments are accepted, but normal JSON syntax is still required. */
export function parseRulesText(text) {
  let result = ''; let quote = null; let escaped = false; let lineComment = false; let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]; const next = text[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') { lineComment = false; result += character; }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      else if (character === '\n' || character === '\r') result += character;
      continue;
    }
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') { quote = character; result += character; continue; }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    result += character;
  }
  if (blockComment) fail('unterminated block comment');
  return JSON.parse(result);
}

function migrateV1ToV2(v1) {
  const rules = structuredClone(v1);
  rules.schemaVersion = SUPPORTED_RULE_SCHEMA_VERSION;
  rules.match ||= {};
  rules.match.breakDurationPolicy = {
    defaultDurationSeconds: rules.match.breakDurationSeconds ?? 35,
    tiers: [{ minimumRoundDurationSeconds: 120, breakDurationSeconds: 60 }]
  };
  rules.penalties ||= {}; rules.penalties.gamJeom ||= {};
  rules.penalties.gamJeom.matchLossAt ??= null;
  rules.penalties.gamJeom.accumulateAcrossRounds ??= false;
  rules.decisions ||= {};
  rules.decisions.manualMatchDecisions ??= ['RSC', 'WDR', 'DSQ', 'PUN', 'DQB'];
  if (Array.isArray(rules.decisions.winnerMethods)) {
    rules.decisions.winnerMethods = [...new Set([
      ...rules.decisions.winnerMethods,
      'GOLDEN_POINTS',
      'SUPERIORITY'
    ])];
  }
  if (Array.isArray(rules.compatibility?.requiredCapabilities)) {
    rules.compatibility.requiredCapabilities = [...new Set([
      ...rules.compatibility.requiredCapabilities,
      'GOLDEN_ROUND',
      'SUPERIORITY_DECISION'
    ])];
  }
  rules.tieBreak = {
    afterRegulation: {
      type: 'GOLDEN_OR_WOO_SE_GIROK',
      options: [...REQUIRED_TIE_OPTIONS]
    },
    goldenRound: {
      enabled: true, durationSeconds: 60, allowTimerEdit: true, resetRegularScores: true,
      scoreToWin: 2, opponentGamJeomsToWin: 2, onTimeExpiry: 'SUPERIORITY',
      superiorityCriteria: ['GOLDEN_ROUND_PUNCH', 'GOLDEN_ROUND_HIT_COUNT', 'REGULATION_ROUNDS_WON', 'FEWER_TOTAL_GAMJEOMS', 'REFEREE_DECISION']
    },
    wooSeGirok: { enabled: true, reasonCode: 'SUP' }
  };
  rules.tournament ||= {};
  rules.tournament.placements ??= structuredClone(DEFAULT_TOURNAMENT_PLACEMENTS);
  return rules;
}

function upgradeManualTournamentTieBreak(rules) {
  if (rules.tieBreak?.afterRegulation?.type !== 'MANUAL_TOURNAMENT_RESOLUTION') return;

  rules.tieBreak.afterRegulation = {
    ...rules.tieBreak.afterRegulation,
    type: 'GOLDEN_OR_WOO_SE_GIROK',
    options: [...REQUIRED_TIE_OPTIONS]
  };
  rules.tieBreak.goldenRound = {
    durationSeconds: 60,
    allowTimerEdit: true,
    resetRegularScores: true,
    scoreToWin: 2,
    opponentGamJeomsToWin: 2,
    onTimeExpiry: 'SUPERIORITY',
    superiorityCriteria: ['GOLDEN_ROUND_PUNCH', 'GOLDEN_ROUND_HIT_COUNT', 'REGULATION_ROUNDS_WON', 'FEWER_TOTAL_GAMJEOMS', 'REFEREE_DECISION'],
    ...(rules.tieBreak.goldenRound && typeof rules.tieBreak.goldenRound === 'object' && !Array.isArray(rules.tieBreak.goldenRound)
      ? rules.tieBreak.goldenRound
      : {}),
    enabled: true
  };
  rules.tieBreak.wooSeGirok = {
    reasonCode: 'SUP',
    ...(rules.tieBreak.wooSeGirok && typeof rules.tieBreak.wooSeGirok === 'object' && !Array.isArray(rules.tieBreak.wooSeGirok)
      ? rules.tieBreak.wooSeGirok
      : {}),
    enabled: true
  };
  if (Array.isArray(rules.decisions?.winnerMethods)) {
    rules.decisions.winnerMethods = [...new Set([
      ...rules.decisions.winnerMethods,
      'GOLDEN_POINTS',
      'SUPERIORITY'
    ])];
  }
  if (Array.isArray(rules.compatibility?.requiredCapabilities)) {
    rules.compatibility.requiredCapabilities = [...new Set([
      ...rules.compatibility.requiredCapabilities,
      'GOLDEN_ROUND',
      'SUPERIORITY_DECISION'
    ])];
  }
}

function normalizeRules(input) {
  requireObject(input, 'root');
  const rules = input.schemaVersion === LEGACY_RULE_SCHEMA_VERSION ? migrateV1ToV2(input) : structuredClone(input);
  upgradeManualTournamentTieBreak(rules);
  rules.tournament ||= {};
  rules.tournament.placements ??= structuredClone(DEFAULT_TOURNAMENT_PLACEMENTS);
  if (!rules.tournament.divisions) {
    rules.tournament.divisions = structuredClone(DEFAULT_TOURNAMENT_DIVISIONS);
  }
  if (Array.isArray(rules.tournament.groupBy) && rules.tournament.groupBy.join('|') === 'GENDER|WEIGHT_CATEGORY') {
    rules.tournament.groupBy = [...DEFAULT_TOURNAMENT_GROUP_BY];
  }
  return rules;
}

function validateTournamentDivisions(value) {
  if (!Array.isArray(value) || value.length === 0) fail('tournament.divisions must be a non-empty array');
  const ids = new Set();
  for (const [divisionIndex, divisionValue] of value.entries()) {
    const name = `tournament.divisions[${divisionIndex}]`;
    const division = requireObject(divisionValue, name);
    const id = requireString(division.id, `${name}.id`);
    requireString(division.label, `${name}.label`);
    requireString(division.ageLabel, `${name}.ageLabel`);
    const normalizedId = id.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (ids.has(normalizedId)) fail('tournament.divisions must not contain duplicate ids');
    ids.add(normalizedId);
    if (division.categoryType !== 'WEIGHT' && division.categoryType !== 'GROUP') {
      fail(`${name}.categoryType must be WEIGHT or GROUP`);
    }
    if (division.categoryType === 'WEIGHT') {
      const weightCategories = requireObject(division.weightCategories, `${name}.weightCategories`);
      for (const gender of ['MALE', 'FEMALE']) {
        if (!Array.isArray(weightCategories[gender]) || weightCategories[gender].length === 0) {
          fail(`${name}.weightCategories.${gender} must be a non-empty array`);
        }
        const categoryNames = new Set();
        for (const [categoryIndex, categoryValue] of weightCategories[gender].entries()) {
          const categoryName = `${name}.weightCategories.${gender}[${categoryIndex}]`;
          const category = requireObject(categoryValue, categoryName);
          const valueName = requireString(category.name, `${categoryName}.name`);
          requireString(category.limit, `${categoryName}.limit`);
          const normalizedName = valueName.toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (categoryNames.has(normalizedName)) fail(`${name}.weightCategories.${gender} must not contain duplicate names`);
          categoryNames.add(normalizedName);
        }
      }
    } else {
      if (!Array.isArray(division.groups) || division.groups.length === 0) fail(`${name}.groups must be a non-empty array`);
      const groupNames = new Set();
      for (const [groupIndex, groupValue] of division.groups.entries()) {
        const groupName = `${name}.groups[${groupIndex}]`;
        const group = requireObject(groupValue, groupName);
        const valueName = requireString(group.name, `${groupName}.name`);
        requireString(group.ageLabel, `${groupName}.ageLabel`);
        const normalizedName = valueName.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (groupNames.has(normalizedName)) fail(`${name}.groups must not contain duplicate names`);
        groupNames.add(normalizedName);
      }
    }
  }
}

export function validateRules(input) {
  const rules = normalizeRules(input);
  if (rules.schemaVersion !== SUPPORTED_RULE_SCHEMA_VERSION) fail(`schemaVersion ${rules.schemaVersion} is not supported`);
  const metadata = requireObject(rules.ruleset, 'ruleset');
  requireString(metadata.id, 'ruleset.id'); requireString(metadata.name, 'ruleset.name'); requireString(metadata.federation, 'ruleset.federation');
  requireString(metadata.ruleVersion, 'ruleset.ruleVersion'); requireString(metadata.effectiveFrom, 'ruleset.effectiveFrom', { nullable: true }); requireString(metadata.source, 'ruleset.source');
  const compatibility = requireObject(rules.compatibility, 'compatibility');
  const minimumSoftwareVersion = requireString(compatibility.minimumSoftwareVersion, 'compatibility.minimumSoftwareVersion');
  const versionComparison = compareVersions(minimumSoftwareVersion, SOFTWARE_VERSION);
  if (versionComparison === null) fail('compatibility.minimumSoftwareVersion must use x.y.z format');
  if (versionComparison > 0) fail(`requires software ${minimumSoftwareVersion}, current software is ${SOFTWARE_VERSION}`);
  const capabilities = requireStringArray(compatibility.requiredCapabilities, 'compatibility.requiredCapabilities');
  if (capabilities.some(capability => !SUPPORTED_CAPABILITIES.has(capability))) fail('compatibility.requiredCapabilities contains an unsupported capability');

  const match = requireObject(rules.match, 'match');
  if (!['BEST_OF_THREE', 'BEST_OF_N_ROUNDS'].includes(match.format)) fail('match.format is not supported');
  requireInteger(match.rounds, 'match.rounds', { minimum: 1, maximum: 15 }); requireInteger(match.roundsRequiredToWin, 'match.roundsRequiredToWin', { minimum: 1, maximum: match.rounds });
  if (match.roundsRequiredToWin <= match.rounds / 2) fail('match.roundsRequiredToWin must make a decisive best-of-rounds match');
  requireInteger(match.roundDurationSeconds, 'match.roundDurationSeconds', { minimum: 1 }); requireInteger(match.minimumRoundDurationSeconds, 'match.minimumRoundDurationSeconds', { minimum: 1 }); requireInteger(match.maximumRoundDurationSeconds, 'match.maximumRoundDurationSeconds', { minimum: 1 });
  if (match.minimumRoundDurationSeconds > match.roundDurationSeconds || match.roundDurationSeconds > match.maximumRoundDurationSeconds) fail('match duration limits do not contain the default round duration');
  const breakPolicy = requireObject(match.breakDurationPolicy, 'match.breakDurationPolicy');
  requireInteger(breakPolicy.defaultDurationSeconds, 'match.breakDurationPolicy.defaultDurationSeconds', { minimum: 1 });
  if (!Array.isArray(breakPolicy.tiers)) fail('match.breakDurationPolicy.tiers must be an array');
  let lastThreshold = 0;
  for (const [index, tier] of breakPolicy.tiers.entries()) {
    requireObject(tier, `match.breakDurationPolicy.tiers.${index}`);
    const threshold = requireInteger(tier.minimumRoundDurationSeconds, `match.breakDurationPolicy.tiers.${index}.minimumRoundDurationSeconds`, { minimum: 1 });
    requireInteger(tier.breakDurationSeconds, `match.breakDurationPolicy.tiers.${index}.breakDurationSeconds`, { minimum: 1 });
    if (threshold <= lastThreshold) fail('match.breakDurationPolicy.tiers must be in ascending threshold order'); lastThreshold = threshold;
  }

  const scoring = requireObject(rules.scoring, 'scoring'); requireNumberArray(scoring.basePointValues, 'scoring.basePointValues', { minimum: 1 });
  if (scoring.basePointValues.join('|') !== '1|2|3') fail('scoring.basePointValues must be [1, 2, 3] for the installed remote controls');
  const basePointLabels = requireObject(scoring.basePointLabels, 'scoring.basePointLabels');
  for (const point of scoring.basePointValues) requireString(basePointLabels[String(point)], `scoring.basePointLabels.${point}`);
  const acceptedPointValues = requireNumberArray(scoring.acceptedPointValues, 'scoring.acceptedPointValues', { minimum: 1 });
  if (scoring.basePointValues.some(point => !acceptedPointValues.includes(point))) fail('scoring.acceptedPointValues must include all base point values');
  const technicalInput = requireObject(scoring.technicalInput, 'scoring.technicalInput'); requireBoolean(technicalInput.enabled, 'scoring.technicalInput.enabled'); requireInteger(technicalInput.windowMilliseconds, 'scoring.technicalInput.windowMilliseconds', { minimum: 1 });
  const eligibleBasePoints = requireNumberArray(technicalInput.eligibleBasePoints, 'scoring.technicalInput.eligibleBasePoints', { minimum: 1 });
  if (eligibleBasePoints.some(point => !scoring.basePointValues.includes(point))) fail('scoring.technicalInput.eligibleBasePoints must be base point values');
  const pointsByBasePoints = requireObject(technicalInput.pointsByBasePoints, 'scoring.technicalInput.pointsByBasePoints');
  for (const point of eligibleBasePoints) {
    const technicalPoints = requireInteger(pointsByBasePoints[String(point)], `scoring.technicalInput.pointsByBasePoints.${point}`, { minimum: 1 });
    if (!acceptedPointValues.includes(technicalPoints)) fail(`technical point value ${technicalPoints} is not accepted`);
  }
  requireInteger(scoring.gamJeomPointValue, 'scoring.gamJeomPointValue', { minimum: 0 });

  const gamJeom = requireObject(requireObject(rules.penalties, 'penalties').gamJeom, 'penalties.gamJeom');
  requireBoolean(gamJeom.awardsPointToOpponent, 'penalties.gamJeom.awardsPointToOpponent'); requireInteger(gamJeom.roundLossAt, 'penalties.gamJeom.roundLossAt', { minimum: 1 });
  if (gamJeom.matchLossAt !== null) requireInteger(gamJeom.matchLossAt, 'penalties.gamJeom.matchLossAt', { minimum: 1 });
  requireBoolean(gamJeom.accumulateAcrossRounds, 'penalties.gamJeom.accumulateAcrossRounds');
  if (gamJeom.matchLossAt !== null && !gamJeom.accumulateAcrossRounds) fail('penalties.gamJeom.matchLossAt requires accumulateAcrossRounds to be true');

  const decisions = requireObject(rules.decisions, 'decisions'); const pointGap = requireObject(decisions.pointGap, 'decisions.pointGap');
  requireBoolean(pointGap.enabled, 'decisions.pointGap.enabled'); requireInteger(pointGap.difference, 'decisions.pointGap.difference', { minimum: 1 });
  const pointGapRounds = requireNumberArray(pointGap.appliesToRounds, 'decisions.pointGap.appliesToRounds', { minimum: 1 });
  if (pointGapRounds.some(round => round > match.rounds)) fail('decisions.pointGap.appliesToRounds contains a round outside match.rounds');
  if (decisions.roundTie?.type !== 'DRAW') fail('decisions.roundTie.type must be DRAW');
  const winnerMethods = requireStringArray(decisions.winnerMethods, 'decisions.winnerMethods');
  if (!winnerMethods.includes('FINAL_SCORE') || winnerMethods.some(method => !SUPPORTED_WINNER_METHODS.has(method))) fail('decisions.winnerMethods contains an unsupported or missing winner method');
  const manualDecisions = requireStringArray(decisions.manualMatchDecisions, 'decisions.manualMatchDecisions');
  if (manualDecisions.some(decision => !SUPPORTED_MANUAL_DECISIONS.has(decision))) fail('decisions.manualMatchDecisions contains an unsupported decision');
  if (pointGap.enabled && !winnerMethods.includes('POINT_GAP')) fail('POINT_GAP must be included when decisions.pointGap.enabled is true');
  if (!winnerMethods.includes('ROUND_GAMJEOM_LIMIT')) fail('ROUND_GAMJEOM_LIMIT is required by the active Gam-jeom round-loss rule');
  if (gamJeom.matchLossAt !== null && !winnerMethods.includes('MATCH_GAMJEOM_LIMIT')) fail('MATCH_GAMJEOM_LIMIT is required when penalties.gamJeom.matchLossAt is set');

  const tieBreak = requireObject(rules.tieBreak, 'tieBreak'); const afterRegulation = requireObject(tieBreak.afterRegulation, 'tieBreak.afterRegulation');
  if (afterRegulation.type !== 'GOLDEN_OR_WOO_SE_GIROK') fail('tieBreak.afterRegulation.type is not supported');
  if (!Array.isArray(afterRegulation.options) || afterRegulation.options.some(option => !SUPPORTED_TIE_OPTIONS.has(option)) || new Set(afterRegulation.options).size !== afterRegulation.options.length) fail('tieBreak.afterRegulation.options contains an unsupported option');
  if (afterRegulation.options.length !== REQUIRED_TIE_OPTIONS.length || REQUIRED_TIE_OPTIONS.some(option => !afterRegulation.options.includes(option))) fail('tieBreak.afterRegulation.options must include GOLDEN_ROUND and WOO_SE_GIROK');
  const goldenRound = requireObject(tieBreak.goldenRound, 'tieBreak.goldenRound');
  requireBoolean(goldenRound.enabled, 'tieBreak.goldenRound.enabled'); requireInteger(goldenRound.durationSeconds, 'tieBreak.goldenRound.durationSeconds', { minimum: 1 }); requireBoolean(goldenRound.allowTimerEdit, 'tieBreak.goldenRound.allowTimerEdit'); requireBoolean(goldenRound.resetRegularScores, 'tieBreak.goldenRound.resetRegularScores');
  requireInteger(goldenRound.scoreToWin, 'tieBreak.goldenRound.scoreToWin', { minimum: 1 }); requireInteger(goldenRound.opponentGamJeomsToWin, 'tieBreak.goldenRound.opponentGamJeomsToWin', { minimum: 1 });
  if (goldenRound.onTimeExpiry !== 'SUPERIORITY') fail('tieBreak.goldenRound.onTimeExpiry is not supported');
  const criteria = requireStringArray(goldenRound.superiorityCriteria, 'tieBreak.goldenRound.superiorityCriteria');
  if (criteria.some(item => !SUPPORTED_SUPERIORITY_CRITERIA.has(item))) fail('tieBreak.goldenRound.superiorityCriteria contains an unsupported criterion');
  if (criteria.includes('REFEREE_DECISION') && criteria.at(-1) !== 'REFEREE_DECISION') fail('REFEREE_DECISION must be the final superiority criterion');
  const wooSeGirok = requireObject(tieBreak.wooSeGirok, 'tieBreak.wooSeGirok'); requireBoolean(wooSeGirok.enabled, 'tieBreak.wooSeGirok.enabled'); requireString(wooSeGirok.reasonCode, 'tieBreak.wooSeGirok.reasonCode');
  if (afterRegulation.options.includes('GOLDEN_ROUND') && !goldenRound.enabled) fail('Golden Round is selected but disabled');
  if (afterRegulation.options.includes('WOO_SE_GIROK') && !wooSeGirok.enabled) fail('Woo-se-girok is selected but disabled');
  if (afterRegulation.options.includes('GOLDEN_ROUND') && !winnerMethods.includes('GOLDEN_POINTS')) fail('GOLDEN_POINTS is required when Golden Round is selected');
  if (goldenRound.enabled && goldenRound.onTimeExpiry === 'SUPERIORITY' && !winnerMethods.includes('SUPERIORITY')) fail('SUPERIORITY is required for the configured Golden Round expiry rule');

  const voting = requireObject(rules.voting, 'voting'); if (voting.mode !== 'STRICT_MAJORITY') fail('voting.mode must be STRICT_MAJORITY');
  requireInteger(voting.minimumActiveRemotes, 'voting.minimumActiveRemotes', { minimum: 1, maximum: 4 }); requireInteger(voting.maximumActiveRemotes, 'voting.maximumActiveRemotes', { minimum: 1, maximum: 4 });
  if (voting.minimumActiveRemotes > voting.maximumActiveRemotes) fail('voting remote limits are invalid');
  const kyeShi = requireObject(requireObject(rules.medical, 'medical').kyeShi, 'medical.kyeShi'); requireBoolean(kyeShi.enabled, 'medical.kyeShi.enabled'); requireInteger(kyeShi.limitSeconds, 'medical.kyeShi.limitSeconds', { minimum: 1 });
  if (kyeShi.onLimit !== 'MANUAL_WINNER') fail('medical.kyeShi.onLimit must be MANUAL_WINNER');
  const tournament = requireObject(rules.tournament, 'tournament'); if (tournament.format !== 'SINGLE_ELIMINATION') fail('tournament.format must be SINGLE_ELIMINATION');
  if (!Array.isArray(tournament.groupBy) || tournament.groupBy.join('|') !== DEFAULT_TOURNAMENT_GROUP_BY.join('|')) fail('tournament.groupBy must be [DIVISION, GENDER, CATEGORY]');
  if (tournament.byes !== 'AUTOMATIC' || tournament.seeding !== 'SEEDED_RANDOM') fail('tournament bye/seeding policy is not supported');
  validateTournamentDivisions(tournament.divisions);
  const placements = requireObject(tournament.placements, 'tournament.placements');
  requireBoolean(placements.enabled, 'tournament.placements.enabled');
  if (placements.thirdPlacePolicy !== 'BOTH_SEMIFINAL_LOSERS') fail('tournament.placements.thirdPlacePolicy must be BOTH_SEMIFINAL_LOSERS');
  const placementLabels = requireObject(placements.labels, 'tournament.placements.labels');
  requireString(placementLabels.first, 'tournament.placements.labels.first');
  requireString(placementLabels.second, 'tournament.placements.labels.second');
  requireString(placementLabels.third, 'tournament.placements.labels.third');
  return rules;
}

export function rulesMetadata(rules) {
  const metadata = rules.ruleset;
  return { id: metadata.id, name: metadata.name, federation: metadata.federation, ruleVersion: metadata.ruleVersion, effectiveFrom: metadata.effectiveFrom, source: metadata.source, schemaVersion: rules.schemaVersion };
}
export async function readRulesFile(filePath) {
  const contents = await readFile(filePath);
  if (contents.byteLength > MAX_RULES_BYTES) throw new Error(`file is larger than ${MAX_RULES_BYTES} bytes`);
  return validateRules(parseRulesText(contents.toString('utf8')));
}
export async function loadRules({ activePath = DEFAULT_ACTIVE_RULES_PATH, defaultPath = DEFAULT_RULES_PATH, logger = console } = {}) {
  const defaults = await readRulesFile(defaultPath);
  try { return await readRulesFile(activePath); } catch (error) { if (error.code !== 'ENOENT') logger.warn(`Ignoring active rules at ${activePath}: ${error.message}`); return defaults; }
}
export const rulesPaths = Object.freeze({ default: DEFAULT_RULES_PATH, active: DEFAULT_ACTIVE_RULES_PATH, backup: `${DEFAULT_ACTIVE_RULES_PATH}.backup` });
export const rulesConstants = Object.freeze({ maxBytes: MAX_RULES_BYTES, schemaVersion: SUPPORTED_RULE_SCHEMA_VERSION, softwareVersion: SOFTWARE_VERSION });
export async function writeRulesAtomically(input, { activePath = rulesPaths.active, backupPath = rulesPaths.backup, backupRules = null } = {}) {
  const rules = validateRules(input); await mkdir(path.dirname(activePath), { recursive: true }); await mkdir(path.dirname(backupPath), { recursive: true });
  let activeExists = false;
  try { if ((await lstat(backupPath)).isSymbolicLink()) throw new Error('rules backup path must not be a symbolic link'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let backupExists = false;
  try { backupExists = (await lstat(backupPath)).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { if ((await lstat(activePath)).isSymbolicLink()) throw new Error('active rules path must not be a symbolic link'); activeExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (activeExists) await copyFile(activePath, backupPath);
  else if (!backupExists && backupRules !== null) await writeJsonAtomically(backupPath, validateRules(backupRules));
  await writeJsonAtomically(activePath, rules);
}
async function writeJsonAtomically(targetPath, value) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o640);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, targetPath);
  } catch (error) { await rm(temporaryPath, { force: true }).catch(() => {}); throw error; }
}
