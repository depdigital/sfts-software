import express from "express";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { MAX_WORKBOOK_ROWS, parseFixtureRows } from './fixtureImport.js';
import { buildFixtureProgression, refreshFixtureProgression, isAutomaticFixture, nextFixtureBout, fixtureDescendants, participantKey } from './fixtureProgression.js';
import { createFileJobs } from './fileJobs.js';
import { createFixtureTemplateSheets } from './fixtureTemplate.js';
import { createRemoteTestTracker } from './remoteTest.js';
import { readBoundedFile } from './safeFiles.js';
import { createNetworkGuard, createRateLimiter, isLoopback, normalizeAddress } from './networkGuard.js';
import { createTts } from "./tts.js";
import { createPersistence } from "./persistence.js";
import { createManualArchive } from "./manualArchive.js";
import { roundTieSuperiority } from "./roundTie.js";
import {
  loadRules,
  parseRulesText,
  readRulesFile,
  rulesConstants,
  rulesMetadata,
  rulesPaths,
  validateRules,
  writeRulesAtomically
} from "./rules.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'remote-config.json');

function loadRemoteConfig() {
  try {
    const config = JSON.parse(readFileSync(REMOTE_CONFIG_PATH, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('configuration must be a JSON object');
    }
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.error(`Could not load ${REMOTE_CONFIG_PATH}: ${error.message}`);
    process.exit(1);
  }
}

const remoteConfig = loadRemoteConfig();
let rules = await loadRules();
let activeRulesMetadata = rulesMetadata(rules);
const configuredRemoteTokens = remoteConfig.remoteTokens && typeof remoteConfig.remoteTokens === 'object'
  ? remoteConfig.remoteTokens
  : {};
const PORT = Number(process.env.PORT || remoteConfig.port || 8080);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer from 1 to 65535');
let ROUND_MS_DEFAULT = rules.match.roundDurationSeconds * 1000;
let MIN_TIMER_MS = rules.match.minimumRoundDurationSeconds * 1000;
let MAX_TIMER_MS = rules.match.maximumRoundDurationSeconds * 1000;
const TIMER_TICK_MS = 50;
const TIMER_DISPLAY_UPDATE_MS = 100;
let KYESHI_LIMIT_MS = Number.isFinite(Number(process.env.SFTS_KYESHI_LIMIT_MS))
  ? Math.max(1_000, Number(process.env.SFTS_KYESHI_LIMIT_MS))
  : rules.medical.kyeShi.limitSeconds * 1000;
const HEARTBEAT_MS = 10_000;
const REMOTE_LIVENESS_TIMEOUT_MS = HEARTBEAT_MS * 3;
const REMOTE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WS_PAYLOAD = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const REMOTE_PROTOCOL_VERSION = 2;
const REMOTE_IDS = new Set(['C1', 'C2', 'C3', 'C4']);
const REMOTE_ACK_CACHE_SIZE = 100;
const WS_MESSAGE_LIMIT = 120;
const WS_MESSAGE_WINDOW_MS = 1000;
const VOTE_SETTLE_MS = 750;
const VOTE_WINDOW_MS = 750;
const REMOTE_EVENT_MAX_AGE_MS = 2500;
const COALESCED_HOST_ACTIONS = new Set([
  'point', 'headPoint', 'technicalPoint', 'gamjeom', 'editScore', 'editGamjeom', 'editRoundTieStats',
  'correctScoringAction', 'correctGamjeom', 'advancedScoreCorrection'
]);
const HOST_ACTIONS = new Set([
  'systemPower', 'cancelSystemPower', 'startKyeShi', 'pauseKyeShi', 'resumeKyeShi', 'endKyeShi',
  'declareKyeShiWinner', 'startGoldenRound', 'decideWooSeGirok', 'decideGoldenRoundSuperiority',
  'manualMatchDecision', 'playPause', 'setTime', 'resetRoundTimer', 'playerSettings', 'saveManualBout',
  'deleteManualCategory', 'saveManualCategoryPlacements', 'announcePractice', 'loadPractice',
  'setArenaNumber', 'announcePlayers', 'name', 'advancedScoreCorrection', 'editScore', 'editGamjeom',
  'editRoundTieStats', 'correctScoringAction', 'correctGamjeom', 'point', 'technicalPoint', 'headPoint',
  'gamjeom', 'nextRound', 'resetMatch', 'newMatch', 'nextManualBout', 'loadBout', 'announceBout',
  'resolveTie', 'correctImportedWinner', 'setRemoteMode', 'testStart', 'testStop'
]);
let TECHNICAL_COMBO_WINDOW_MS = rules.scoring.technicalInput.windowMilliseconds;
let MIN_ACTIVE_REMOTES = rules.voting.minimumActiveRemotes;
let MAX_ACTIVE_REMOTES = rules.voting.maximumActiveRemotes;
const SYSTEM_POWER_DELAY_MS = 15_000;
const SYSTEMCTL_BIN = '/usr/bin/systemctl';
const LSBLK_BIN = '/usr/bin/lsblk';
const UDISKSCTL_BIN = '/usr/bin/udisksctl';
const USB_IMPORT_ONLY = process.env.SFTS_USB_IMPORT_ONLY === 'true';
const USB_EXPECTED_UUID = String(process.env.SFTS_USB_UUID || '').trim().toLowerCase();
const USB_ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const USB_RULE_ALLOWED_EXTENSIONS = new Set(['.json']);
const USB_TEMPLATE_FILE = 'sfts-match-template.xlsx';
const KIOSK_MODE = process.env.SFTS_KIOSK_MODE === 'true';
const KIOSK_ORIGIN = new URL(`http://127.0.0.1:${PORT}`).origin;
const INDIAN_STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CG', 'DD', 'DL', 'DN', 'GA', 'GJ',
  'HR', 'HP', 'JK', 'JH', 'KA', 'KL', 'LA', 'LD', 'MP', 'MH', 'MN', 'ML',
  'MZ', 'NL', 'OD', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TS', 'TR', 'UK', 'UP', 'WB'
]);

const app = express();
const server = http.createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false });
const networkGuard = createNetworkGuard({ port: PORT });
const fileJobs = createFileJobs();
const AUTH_TIMEOUT_MS = Math.max(500, Math.min(30_000, Number(process.env.SFTS_AUTH_TIMEOUT_MS) || 10_000));
server.on('upgrade', (request, socket, head) => {
  const peer = normalizeAddress(socket.remoteAddress || '');
  const local = isLoopback(peer);
  let peerCount = 0;
  let externalCount = 0;
  for (const client of wss.clients) {
    if (client.peerAddress === peer) peerCount += 1;
    if (!isLoopback(client.peerAddress)) externalCount += 1;
  }
  const reject = status => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  if (!networkGuard.trustedRequest(request, { websocket: true })) return reject('403 Forbidden');
  // Reserve capacity for the local host even if LAN clients fill their quota.
  if (wss.clients.size >= 32 || (!local && externalCount >= 24) || peerCount >= (local ? 24 : 8) || !networkGuard.upgrades.take(peer)) {
    return reject('429 Too Many Requests');
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});
server.maxHeadersCount = 64;
server.maxConnections = 64;
app.disable('x-powered-by');
app.set('query parser', 'simple');
app.use(networkGuard.httpMiddleware);
const publicDir = path.join(PROJECT_ROOT, 'public');
const samplesDir = path.join(PROJECT_ROOT, 'samples');
const tts = createTts();
let stateStorageHealthy = true;
let archiveStorageHealthy = true;
const persistence = createPersistence({ onStatus: ok => {
  stateStorageHealthy = ok;
  emit({ type: 'storageStatus', ok: stateStorageHealthy && archiveStorageHealthy });
} });
const manualArchive = createManualArchive({ dataDir: persistence.dataDir, onStatus: ok => {
  archiveStorageHealthy = ok;
  emit({ type: 'storageStatus', ok: stateStorageHealthy && archiveStorageHealthy });
} });
const hostAccessToken = String(process.env.SFTS_HOST_TOKEN || '').trim() || crypto.randomBytes(24).toString('hex');
app.use('/samples', express.static(samplesDir, { index: false }));
app.use(express.static(publicDir));

app.get('/api/tts/audio/:file', (req, res) => {
  const audioBuffer = tts.audioBuffer(req.params.file);
  if (audioBuffer) {
    res.type('audio/wav');
    res.send(audioBuffer);
    return;
  }
  const audioFile = tts.audioPath(req.params.file);
  if (!audioFile) {
    res.status(404).end();
    return;
  }
  res.type('audio/wav');
  res.sendFile(audioFile, error => {
    if (error && !res.headersSent) res.status(error.statusCode || 404).end();
  });
});

function getLocalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "localhost";
}

const baseStats = () => ({
  plus1: 0,
  plus2: 0,
  plus3: 0,
  technicalChest: 0,
  technicalHead: 0
});
function makeKyeShi() {
  return {
    active: false,
    running: false,
    elapsedMs: 0,
    limitMs: KYESHI_LIMIT_MS,
    limitReached: false,
    resumeMatch: false
  };
}

function makeGoldenRound() {
  return {
    active: false,
    durationMs: rules.tieBreak.goldenRound.durationSeconds * 1000,
    previousScoresVoided: false,
    superiority: null
  };
}

function configuredTieOptions() {
  const configured = rules.tieBreak.afterRegulation.options;
  return configured.filter(option => (
    (option === 'GOLDEN_ROUND' && rules.tieBreak.goldenRound.enabled) ||
    (option === 'WOO_SE_GIROK' && rules.tieBreak.wooSeGirok.enabled)
  ));
}

function tieDecisionOptions(mode) {
  return ['ROUND_WOO_SE_GIROK', 'MATCH_WOO_SE_GIROK'].includes(mode)
    ? ['WOO_SE_GIROK']
    : configuredTieOptions();
}

function makeTieDecision() {
  return {
    pending: false,
    mode: null,
    options: configuredTieOptions(),
    round: null
  };
}

function breakDurationForRound(roundMs) {
  const override = Number(process.env.SFTS_BREAK_MS);
  if (Number.isFinite(override)) return Math.max(50, override);
  const roundSeconds = Math.max(1, Number(roundMs) / 1000);
  let durationSeconds = rules.match.breakDurationPolicy.defaultDurationSeconds;
  for (const tier of rules.match.breakDurationPolicy.tiers) {
    if (roundSeconds >= tier.minimumRoundDurationSeconds) durationSeconds = tier.breakDurationSeconds;
    else break;
  }
  return durationSeconds * 1000;
}

function makeSide(name, profile = {}) {
  const stateCode = String(profile?.stateCode || '').trim().toUpperCase();
  return {
    name,
    playerName: String(profile?.playerName || '').trim().slice(0, 64),
    division: String(profile?.division || '').trim().slice(0, 32),
    weightCategory: String(profile?.weightCategory || '').trim().slice(0, 32),
    categoryGroup: String(profile?.categoryGroup || '').trim().slice(0, 32),
    stateCode: INDIAN_STATE_CODES.has(stateCode) ? stateCode : '',
    district: String(profile?.district || '').trim().slice(0, 48),
    club: String(profile?.club || '').trim().slice(0, 64),
    score: 0,
    gamjeom: 0,
    stats: baseStats()
  };
}
function makeMatch(
  matchNo = 1,
  redName = "HONG",
  blueName = "CHUNG",
  roundMs = ROUND_MS_DEFAULT,
  redProfile = {},
  blueProfile = {}
) {
  return {
    matchNo,
    round: 1,
    configuredRoundMs: roundMs,
    timerMs: roundMs,
    breakMs: breakDurationForRound(roundMs),
    breakTarget: 'REGULAR',
    remoteCount: MAX_ACTIVE_REMOTES,
    ruleset: deep(activeRulesMetadata),
    rulesSnapshot: deep(rules),
    mode: 'OFFICIAL',
    practiceMatchNo: null,
    running: false,
    roundStarted: false,
    startedAt: null,
    phase: "ROUND", // ROUND | BREAK | TIE_DECISION | MATCH_END
    kyeShi: makeKyeShi(),
    goldenRound: makeGoldenRound(),
    tieDecision: makeTieDecision(),
    red: makeSide(redName, redProfile),
    blue: makeSide(blueName, blueProfile),
    votes: {},
    cornerRefereeHistory: [],
    operatorHistory: [],
    manualBout: null,
    roundHistory: [],
    matchWinner: null,
    matchReason: "",
    test: {
      active: false,
      presses: {}
    }
  };
}

const GENDER_ALIASES = new Map([
  ['M', 'MALE'], ['MALE', 'MALE'], ['MAN', 'MALE'], ['MEN', 'MALE'],
  ['F', 'FEMALE'], ['FEMALE', 'FEMALE'], ['WOMAN', 'FEMALE'], ['WOMEN', 'FEMALE']
]);

function makeTournament() {
  return {
    format: 'IMPORTED_MATCHES',
    placementPolicy: deep(rules.tournament.placements),
    seed: null,
    generatedAt: null,
    players: [],
    groups: [],
    schedule: [],
    byes: [],
    activeBoutNo: null
  };
}

function makeManualCompetition() {
  return {
    version: 1,
    activeCategoryId: null,
    categories: []
  };
}

function normalizeGender(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return GENDER_ALIASES.get(normalized) || '';
}

function normalizeTournamentValue(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function tournamentDivisionDefinitions() {
  return Array.isArray(rules.tournament.divisions) ? rules.tournament.divisions : [];
}

function resolveTournamentDivision(value) {
  const normalized = normalizeTournamentValue(value);
  return tournamentDivisionDefinitions().find(division => (
    normalizeTournamentValue(division.id) === normalized || normalizeTournamentValue(division.label) === normalized
  )) || null;
}

function resolveWeightCategory(division, gender, value) {
  const normalized = normalizeTournamentValue(value);
  return (division?.weightCategories?.[gender] || []).find(category => (
    normalizeTournamentValue(category.name) === normalized
  )) || null;
}

function resolveCategoryGroup(division, value) {
  const normalized = normalizeTournamentValue(value);
  return (division?.groups || []).find(group => normalizeTournamentValue(group.name) === normalized) || null;
}

function competitionCategory(entry) {
  return String(entry?.categoryGroup || entry?.weightCategory || '').trim();
}


function contestantReadyAnnouncement(hongName, chungName) {
  return `${hongName}, HONG, red chest guard, versus ${chungName}, CHUNG, blue chest guard; contestants, prepare for the match.`;
}

function scheduleAnnouncement(bout) {
  return contestantReadyAnnouncement(bout.redPlayerName, bout.bluePlayerName);
}


class TournamentImportError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'TournamentImportError';
    this.errors = errors;
  }
}

function validateCompletedFixtureBout(bout, record) {
  if (record.manualBout.stage !== bout.stage || ['RED', 'BLUE'].some(side => {
    const recorded = record[side.toLowerCase()];
    return !bout[side] || recorded.playerName !== bout[side].playerName || recorded.club !== bout[side].club;
  })) throw new TournamentImportError(`Completed bout ${bout.officialBoutNo} has different competitors or stage; its saved result cannot be replaced`);
}

async function importFixture(buffer, event) {
  let rows;
  try { rows = await fileJobs.run('readPlayers', buffer); }
  catch (error) { throw new TournamentImportError(`The file is not a readable Excel or CSV file: ${error.message}`); }
  const automatic = event?.autoAdvance === true;
  const parsed = parseFixtureRows(rows, { event, maxBouts: automatic ? MAX_WORKBOOK_ROWS : 500, openingFixture: automatic, multipleCategories: automatic, categoryFromInput: manualCategoryFromInput, playerDetails: manualPlayerDetails });
  if (parsed.errors.length) throw new TournamentImportError('The match file could not be imported', parsed.errors);
  const digest = crypto.createHash('sha256').update(buffer).update(JSON.stringify({ categories: parsed.categories.map(item => item.category), automatic })).digest('hex');
  const categories = (automatic ? parsed.categories : [parsed]).map(group => {
    const fixture = fixtureFromParsed(group, automatic);
    fixture.sourceDigest = digest;
    return { key: crypto.createHash('sha256').update(manualCategoryIdentity(group.category)).digest('hex'), fixture };
  });
  return {
    tournament: categories[0].fixture,
    workbook: automatic ? { version: 1, sourceDigest: digest, selectedKey: categories[0].key, categories } : null
  };
}

function fixtureFromParsed(parsed, automatic) {
  const category = manualCompetition.categories.find(item => manualCategoryIdentity(item) === manualCategoryIdentity(parsed.category));
  if (!automatic && category?.status === 'FINALIZED') throw new TournamentImportError('This category is finalized and cannot accept another import');
  const result = { ...makeTournament(), generatedAt: new Date().toISOString(), event: parsed.category, categoryId: category?.id || null };
  if (automatic) result.progressionMode = 'OPENING_FIXTURE';
  const { division, gender, weightCategory, categoryGroup } = parsed.category;
  const profile = { division, gender, weightCategory, categoryGroup };
  const records = new Map(manualMatchRecords.filter(record => category && record.manualBout?.categoryId === category.id).map(record => [String(record.manualBout.officialBoutNo).toUpperCase(), record]));
  const players = new Map();
  const playerId = details => {
    if (!details) return null;
    const key = participantKey(details);
    if (!players.has(key)) players.set(key, { id: `P${players.size + 1}`, name: details.playerName, ...details, ...profile });
    return players.get(key).id;
  };
  result.schedule = parsed.bouts.map((bout, index) => ({
    ...bout, ...profile, boutNo: index + 1, groupId: '', round: 1,
    redPlayerId: playerId(bout.RED), bluePlayerId: playerId(bout.BLUE),
    redPlayerName: bout.RED?.playerName || 'BYE', bluePlayerName: bout.BLUE?.playerName || 'BYE',
    status: 'SCHEDULED', winner: null, winnerName: null,
    announcement: scheduleAnnouncement({ redPlayerName: bout.RED?.playerName || 'BYE', bluePlayerName: bout.BLUE?.playerName || 'BYE' })
  }));
  result.players = [...players.values()];
  if (automatic) {
    try { buildFixtureProgression(result); }
    catch (error) { throw new TournamentImportError(`${parsed.category.divisionLabel} / ${gender} / ${weightCategory || categoryGroup}: ${error.message}`); }
    refreshFixtureProgression(result, { records, validateRecord: validateCompletedFixtureBout });
    if (category?.status === 'FINALIZED' && result.schedule.some(bout => !['COMPLETED', 'BYE'].includes(bout.status))) throw new TournamentImportError('A finalized category must retain its complete original fixture');
  } else {
    for (const bout of result.schedule) {
      const completed = records.get(bout.officialBoutNo.toUpperCase());
      if (completed) {
        validateCompletedFixtureBout(bout, completed);
        bout.status = 'COMPLETED';
        bout.winner = completed.winner;
        bout.winnerName = completed.winnerName;
      }
    }
  }
  return result;
}

function workbookCategoryStatus(fixture, category) {
  if (category?.status === 'FINALIZED') return 'FINALIZED';
  if (fixture.recoveryError) return 'REVIEW REQUIRED';
  if (fixture.schedule.every(bout => ['COMPLETED', 'BYE'].includes(bout.status))) return 'COMPLETED';
  return fixture.schedule.some(bout => ['COMPLETED', 'IN_PROGRESS', 'TIE_PENDING'].includes(bout.status)) ? 'IN PROGRESS' : 'NOT STARTED';
}

function fixtureWorkbookState(workbook = importedWorkbook, preview = false) {
  if (!workbook) return null;
  const archivedCategories = new Map(manualCompetition.categories.map(category => [category.id, category]));
  const completedBouts = new Map(workbook.categories.filter(item => item.fixture.categoryId).map(({ fixture }) => [
    fixture.categoryId, new Set(archivedCategories.get(fixture.categoryId)?.matchRecordIds || [])
  ]));
  for (const records of [manualMatchRecords, matchHistory]) for (const record of records) {
    if (record.id) completedBouts.get(record.manualBout?.categoryId)?.add(record.id);
  }
  return {
    version: 1, sourceDigest: workbook.sourceDigest, selectedKey: workbook.selectedKey,
    categories: workbook.categories.map(({ key, fixture }) => ({
      key, event: fixture.event, competitorCount: fixture.players.length,
      categoryId: fixture.categoryId,
      completedBoutCount: completedBouts.get(fixture.categoryId)?.size || 0,
      byeCount: fixture.schedule.filter(bout => bout.status === 'BYE').length,
      matchCount: fixture.schedule.filter(bout => bout.status !== 'BYE').length,
      status: workbookCategoryStatus(fixture, archivedCategories.get(fixture.categoryId)), ...(preview ? { fixture } : {})
    }))
  };
}

function commitFixtureImport(imported, digest, selectedKey) {
  requireFixtureReview(imported.tournament, digest);
  const selected = imported.workbook?.categories.find(item => item.key === (selectedKey || imported.workbook.selectedKey));
  if (imported.workbook && !selected) throw new TournamentImportError('Select a category from the reviewed tournament file');
  importedWorkbook = imported.workbook;
  if (selected) importedWorkbook.selectedKey = selected.key;
  tournament = selected?.fixture || imported.tournament;
}

function importEventHeader(req) {
  try {
    const encoded = req.get('X-SFTS-Import-Event') || '';
    if (encoded.length > 4096) throw new Error();
    return JSON.parse(decodeURIComponent(encoded));
  } catch { throw new TournamentImportError('Enter tournament name, date, venue, arena and competition before importing'); }
}

function requireFixtureReview(imported, digest) {
  if (isAutomaticFixture(imported) && digest !== imported.sourceDigest) {
    throw new TournamentImportError('Review this opening fixture before starting. If the file or event details changed, review it again');
  }
}

let match = makeMatch();
let arenaNumber = '';
let matchHistory = [];
let tournament = makeTournament();
let importedWorkbook = null;
let manualCompetition = makeManualCompetition();
let manualMatchRecords = [];
let hostSocket = null;
const refereeSockets = new Map();
const remoteSockets = new Map();
const remoteSessions = new Map();
const remoteStatuses = new Map([...REMOTE_IDS].map(deviceId => [deviceId, {
  deviceId,
  corner: Number(deviceId.slice(1)),
  connected: false,
  rssi: null,
  battery: null,
  outboxDepth: null,
  droppedInputs: null,
  droppedEvents: null,
  retryCount: null,
  reconnectCount: null,
  lastAckSequence: null,
  protocolVersion: null,
  lastEventReason: null,
  lastEventSequence: null,
  lastSeenAt: null
}]));
const remoteTechnicalPending = new Map();
const remoteLastBasePress = new Map();
const remoteTestTracker = createRemoteTestTracker({ windowMs: () => TECHNICAL_COMBO_WINDOW_MS, technicalPointsFor });
const lastRemoteButtons = new Map();
const lastRemoteButtonTimers = new Map();
const REMOTE_BUTTON_DISPLAY_MS = 250;
const remoteScoreHighlights = { RED: [], BLUE: [] };
const remoteScoreValues = { RED: null, BLUE: null };
const REMOTE_SCORE_DISPLAY_MS = 500;
const remoteScoreRevisions = { RED: 0, BLUE: 0 };
let timerLastAt = null;
let kyeShiLastAt = null;
let lastStateAt = 0;
let persistenceReady = false;
let lastTimerPersistAt = 0;
let recoveredFromUnexpectedShutdown = false;
let voteSettleGuard = null;
let pendingSystemPower = null;
let cachedScoringRulesState = null;

function deep(v) { return JSON.parse(JSON.stringify(v)); }

function configureRuntimeRules(nextRules) {
  rules = nextRules;
  activeRulesMetadata = rulesMetadata(rules);
  cachedScoringRulesState = null;
  ROUND_MS_DEFAULT = rules.match.roundDurationSeconds * 1000;
  MIN_TIMER_MS = rules.match.minimumRoundDurationSeconds * 1000;
  MAX_TIMER_MS = rules.match.maximumRoundDurationSeconds * 1000;
  KYESHI_LIMIT_MS = Number.isFinite(Number(process.env.SFTS_KYESHI_LIMIT_MS))
    ? Math.max(1_000, Number(process.env.SFTS_KYESHI_LIMIT_MS))
    : rules.medical.kyeShi.limitSeconds * 1000;
  TECHNICAL_COMBO_WINDOW_MS = rules.scoring.technicalInput.windowMilliseconds;
  MIN_ACTIVE_REMOTES = rules.voting.minimumActiveRemotes;
  MAX_ACTIVE_REMOTES = rules.voting.maximumActiveRemotes;

  if (typeof match === 'undefined') return;
  match.ruleset = deep(activeRulesMetadata);
  match.rulesSnapshot = deep(rules);
  match.configuredRoundMs = ROUND_MS_DEFAULT;
  match.breakMs = breakDurationForRound(match.configuredRoundMs);
  if (match.phase === 'ROUND' && !match.roundStarted) match.timerMs = ROUND_MS_DEFAULT;
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, match.remoteCount));
  match.kyeShi.limitMs = KYESHI_LIMIT_MS;
}

function scoringRulesState() {
  if (cachedScoringRulesState) return cachedScoringRulesState;
  cachedScoringRulesState = {
    basePointValues: [...rules.scoring.basePointValues],
    basePointLabels: { ...rules.scoring.basePointLabels },
    acceptedPointValues: [...rules.scoring.acceptedPointValues],
    technicalInput: deep(rules.scoring.technicalInput),
    gamJeomPointValue: rules.scoring.gamJeomPointValue,
    gamJeom: deep(rules.penalties.gamJeom),
    manualMatchDecisions: [...rules.decisions.manualMatchDecisions],
    roundTie: deep(rules.decisions.roundTie),
    tieBreak: deep(rules.tieBreak),
    match: {
      rounds: rules.match.rounds,
      roundsRequiredToWin: rules.match.roundsRequiredToWin
    },
    tournament: deep(rules.tournament)
  };
  return cachedScoringRulesState;
}

function persistenceSnapshot({ cleanShutdown = false } = {}) {
  const savedMatch = deep(match);
  savedMatch.running = false;
  if (savedMatch.kyeShi) {
    savedMatch.kyeShi.running = false;
    savedMatch.kyeShi.resumeMatch = false;
  }
  savedMatch.votes = {};
  savedMatch.test = { active: false, presses: {} };
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    cleanShutdown,
    arenaNumber,
    ruleset: deep(activeRulesMetadata),
    match: savedMatch,
    matchHistory: deep(matchHistory),
    tournament: deep(tournament),
    importedWorkbook: deep(importedWorkbook)
  };
}

function manualArchiveSnapshot() {
  return {
    version: 1,
    manualCompetition: deep(manualCompetition),
    records: deep(manualMatchRecords)
  };
}

function persistManualArchive() {
  manualArchive.schedule(manualArchiveSnapshot);
}

function flushPersistedState(snapshot) {
  return persistence.flush(snapshot);
}

function persistState(immediate = false) {
  if (!persistenceReady) return;
  if (immediate) void flushPersistedState(persistenceSnapshot()).catch(() => {});
  else persistence.schedule(() => persistenceSnapshot());
  lastTimerPersistAt = Date.now();
}

function restorePersistedState(snapshot) {
  arenaNumber = normalizeArenaNumber(snapshot.arenaNumber);
  match = snapshot.match;
  for (const player of [match.red, match.blue]) {
    player.stats = { ...baseStats(), ...(player.stats || {}) };
  }
  match.ruleset ||= deep(activeRulesMetadata);
  match.rulesSnapshot ||= deep(rules);
  match.remoteCount = Number.isInteger(match.remoteCount) && match.remoteCount >= MIN_ACTIVE_REMOTES && match.remoteCount <= MAX_ACTIVE_REMOTES
    ? match.remoteCount
    : MAX_ACTIVE_REMOTES;
  match.running = false;
  match.mode = match.mode === 'PRACTICE' ? 'PRACTICE' : 'OFFICIAL';
  match.practiceMatchNo = match.mode === 'PRACTICE' ? 1 : null;
  match.startedAt = typeof match.startedAt === 'string' ? match.startedAt : null;
  match.roundStarted = Boolean(match.roundStarted || match.timerMs < match.configuredRoundMs ||
    match.red.score > 0 || match.blue.score > 0 || match.red.gamjeom > 0 || match.blue.gamjeom > 0);
  match.kyeShi = {
    ...makeKyeShi(),
    ...(match.kyeShi && typeof match.kyeShi === 'object' ? match.kyeShi : {})
  };
  match.goldenRound = {
    ...makeGoldenRound(),
    ...(match.goldenRound && typeof match.goldenRound === 'object' ? match.goldenRound : {})
  };
  match.goldenRound.durationMs = Math.max(1_000, Number(match.goldenRound.durationMs) || rules.tieBreak.goldenRound.durationSeconds * 1000);
  match.goldenRound.active = Boolean(match.goldenRound.active && match.round === rules.match.rounds + 1 && match.phase === 'ROUND');
  match.tieDecision = {
    ...makeTieDecision(),
    ...(match.tieDecision && typeof match.tieDecision === 'object' ? match.tieDecision : {})
  };
  if (!['CHOOSE_METHOD', 'GOLDEN_SUPERIORITY', 'ROUND_WOO_SE_GIROK', 'MATCH_WOO_SE_GIROK'].includes(match.tieDecision.mode)) {
    match.tieDecision.mode = null;
  }
  match.tieDecision.pending = match.phase === 'TIE_DECISION';
  match.tieDecision.options = tieDecisionOptions(match.tieDecision.mode);
  match.tieDecision.round = match.tieDecision.pending ? match.round : null;
  match.breakTarget = match.breakTarget === 'GOLDEN' ? 'GOLDEN' : 'REGULAR';
  match.breakMs = breakDurationForRound(match.configuredRoundMs);
  match.kyeShi.limitMs = KYESHI_LIMIT_MS;
  match.kyeShi.running = false;
  match.kyeShi.resumeMatch = false;
  match.kyeShi.elapsedMs = Math.max(0, Math.min(match.kyeShi.limitMs, Number(match.kyeShi.elapsedMs) || 0));
  kyeShiLastAt = null;
  match.votes = {};
  match.cornerRefereeHistory = Array.isArray(match.cornerRefereeHistory)
    ? match.cornerRefereeHistory
    : [];
  match.operatorHistory = Array.isArray(match.operatorHistory) ? match.operatorHistory : [];
  match.manualBout = match.manualBout && typeof match.manualBout === 'object'
    ? match.manualBout
    : null;
  match.test = { active: false, presses: {} };
  matchHistory = snapshot.matchHistory;
  tournament = snapshot.tournament;
  importedWorkbook = snapshot.importedWorkbook || null;
  if (importedWorkbook) {
    const selected = importedWorkbook.categories.find(item => item.key === importedWorkbook.selectedKey);
    selected.fixture = tournament;
  }
  tournament.placementPolicy ||= deep(rules.tournament.placements);
  refreshTournamentBracket(tournament);
  manualCompetition = snapshot.manualCompetition && typeof snapshot.manualCompetition === 'object'
    ? snapshot.manualCompetition
    : makeManualCompetition();
  manualCompetition.version = 1;
  manualCompetition.categories = Array.isArray(manualCompetition.categories)
    ? manualCompetition.categories.filter(category => (
      category && typeof category === 'object' && typeof category.id === 'string' && category.id &&
      Array.isArray(category.matchRecordIds) && category.placements && typeof category.placements === 'object'
    ))
    : [];
  manualMatchRecords = Array.isArray(snapshot.manualMatchRecords)
    ? snapshot.manualMatchRecords.filter(record => record && typeof record === 'object' && record.manualBout?.categoryId)
    : matchHistory.filter(item => item?.source === 'MANUAL' && item.manualBout?.categoryId);

  if (tournament.activeBoutNo) {
    const active = findTournamentBout(tournament.activeBoutNo);
    if (!active || (active.status !== 'IN_PROGRESS' && active.status !== 'TIE_PENDING')) {
      tournament.activeBoutNo = null;
    }
  }
}

try {
  await persistence.acquire();
} catch (error) {
  console.error(`Could not lock the local data directory: ${error.message}`);
  process.exit(1);
}

const persistedState = await persistence.load();
if (persistedState) {
  recoveredFromUnexpectedShutdown = persistedState.snapshot.cleanShutdown !== true;
  restorePersistedState(persistedState.snapshot);
  console.log(`Restored saved state from ${persistedState.source} snapshot`);
}
const archivedManualResults = await manualArchive.load();
if (archivedManualResults) {
  manualCompetition = archivedManualResults.manualCompetition;
  manualMatchRecords = archivedManualResults.records;
} else if (manualCompetition.categories.length || manualMatchRecords.length) {
  manualArchive.schedule({ version: 1, manualCompetition, records: manualMatchRecords });
}
manualCompetition.categories = manualCompetition.categories.filter(category => (
  category && typeof category === 'object' && typeof category.id === 'string' && category.id &&
  Array.isArray(category.matchRecordIds) && category.placements && typeof category.placements === 'object'
));
manualMatchRecords = manualMatchRecords.filter(record => (
  record && typeof record === 'object' && record.manualBout?.categoryId
));
for (const fixture of importedWorkbook ? importedWorkbook.categories.map(item => item.fixture) : [tournament]) {
  if (!isAutomaticFixture(fixture) || !fixture.categoryId) continue;
  const category = manualCompetition.categories.find(item => item.id === fixture.categoryId);
  const known = new Set(manualMatchRecords.map(record => record.id));
  let recovered = false;
  if (category) for (const record of matchHistory) {
    if (record.manualBout?.categoryId !== category.id || known.has(record.id)) continue;
    manualMatchRecords.push(deep(record));
    if (!category.matchRecordIds.includes(record.id)) category.matchRecordIds.push(record.id);
    known.add(record.id);
    recovered = true;
  }
  try {
    const records = new Map(manualMatchRecords.filter(record => record.manualBout?.categoryId === fixture.categoryId).map(record => [String(record.manualBout.officialBoutNo).toUpperCase(), record]));
    refreshFixtureProgression(fixture, { records, validateRecord: validateCompletedFixtureBout });
    if (fixture.schedule.find(bout => bout.boutNo === fixture.activeBoutNo)?.status !== 'IN_PROGRESS') fixture.activeBoutNo = null;
  } catch (error) {
    fixture.recoveryError = 'Saved fixture and results disagree. Review or reimport the tournament file before continuing';
    console.error(`Could not reconcile category progression: ${error.message}`);
  }
  if (recovered) { applyAutomaticManualPlacements(category); persistManualArchive(); }
}
normalizeManualCategoryPlacementState();
persistenceReady = true;
// Mark the running server as unclean until it reaches a deliberate shutdown.
await flushPersistedState(persistenceSnapshot());
function sendText(ws, text, label = 'send') {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    console.error(`Closing slow WebSocket client during ${label}`);
    ws.terminate();
    return false;
  }
  try {
    ws.send(text, error => {
      if (error) console.error(`WebSocket ${label} failed:`, error.message);
    });
    return true;
  } catch (error) {
    console.error(`WebSocket ${label} failed:`, error.message);
    return false;
  }
}
function send(ws, message) {
  return sendText(ws, JSON.stringify(message));
}
function matchHistoryState() {
  return matchHistory.map(item => ({
    id: item.id,
    matchNo: item.matchNo,
    redName: item.redName,
    blueName: item.blueName,
    winner: item.winner,
    winnerName: item.winnerName,
    reason: item.reason,
    roundCount: Array.isArray(item.rounds) ? item.rounds.length : 0,
    endedAt: item.endedAt,
    ruleset: item.ruleset
  }));
}
function fullState(compact = false) {
  return {
    type: compact ? 'statePatch' : 'state',
    recoveredFromUnexpectedShutdown,
    storageHealthy: stateStorageHealthy && archiveStorageHealthy,
    arenaNumber,
    remoteButtons: [1, 2, 3, 4].map(corner => lastRemoteButtons.get(corner) || null),
    remoteScoreHighlights,
    remoteScoreValues,
    remoteScoreRevisions,
    match,
    ...(!compact ? { matchHistory: matchHistoryState(), tournament, manualCompetition, fixtureWorkbook: fixtureWorkbookState() } : {}),
    remotes: [...remoteStatuses.values()],
    usbImportOnly: USB_IMPORT_ONLY,
    ...(!compact ? { ruleset: activeRulesMetadata, scoringRules: scoringRulesState() } : {})
  };
}
function remoteState(ws) {
  return {
    type: 'remote_state',
    deviceId: ws.deviceId,
    corner: ws.corner,
    matchNo: match.matchNo,
    round: match.round,
    phase: match.phase,
    timerMs: Math.max(0, Math.ceil(match.timerMs)),
    running: match.running,
    kyeShi: match.kyeShi,
    activeRemoteCount: match.remoteCount,
    requiredVotes: Math.floor(match.remoteCount / 2) + 1,
    connected: Boolean(remoteStatuses.get(ws.deviceId)?.connected),
    rssi: remoteStatuses.get(ws.deviceId)?.rssi ?? null,
    battery: remoteStatuses.get(ws.deviceId)?.battery ?? null,
    red: { score: match.red.score, gamjeom: match.red.gamjeom },
    blue: { score: match.blue.score, gamjeom: match.blue.gamjeom },
    votes: match.votes
  };
}
function state(persist = false, immediate = persist) {
  if (persist) persistState(immediate);
  let text = null;
  let patchText = null;
  for (const ws of wss.clients) {
    if (ws.role === 'remote') sendText(ws, JSON.stringify(remoteState(ws)), 'remote state broadcast');
    else if (ws.role === 'host' || ws.role === 'referee') {
      if (ws.supportsStatePatch && !(persist && immediate)) {
        patchText ||= JSON.stringify(fullState(true));
        sendText(ws, patchText, 'state patch');
      } else {
        text ||= JSON.stringify(fullState());
        sendText(ws, text, 'state broadcast');
      }
    }
  }
  lastStateAt = Date.now();
}
function emit(message) {
  const text = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.role === 'host' || ws.role === 'referee') sendText(ws, text, 'broadcast');
  }
}

function sendTimerUpdate() {
  emit({
    type: 'timerUpdate',
    matchNo: match.matchNo,
    round: match.round,
    phase: match.phase,
    timerMs: Math.max(0, Math.ceil(match.timerMs)),
    running: match.running,
    kyeShi: match.kyeShi
  });
  lastStateAt = Date.now();
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

function powerActionName(action) {
  const normalized = String(action || '').toLowerCase();
  return normalized === 'reboot' || normalized === 'shutdown' ? normalized : '';
}

function resetMatchSessionForOrganicShutdown() {
  const remoteCount = match.remoteCount;
  const redProfile = deep(match.red);
  const blueProfile = deep(match.blue);
  match = makeMatch(
    1,
    match.red.name,
    match.blue.name,
    match.configuredRoundMs,
    redProfile,
    blueProfile
  );
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, Number(remoteCount) || MAX_ACTIVE_REMOTES));
  matchHistory = [];
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearRemoteScoreHighlights();
  clearVoteSettleGuard();
  timerLastAt = null;
  kyeShiLastAt = null;
}

async function executeSystemPower(request) {
  if (pendingSystemPower !== request) return;
  pendingSystemPower = null;
  if (request.action === 'shutdown') {
    resetMatchSessionForOrganicShutdown();
    // Flush before asking the OS to power off so the fresh match counter and
    // empty history are the state restored on the next boot.
    try {
      await flushPersistedState(persistenceSnapshot({ cleanShutdown: true }));
      await manualArchive.flush();
    } catch (error) {
      console.error(`Could not flush reset state before shutdown: ${error.message}`);
    }
  }
  const systemctlAction = request.action === 'shutdown' ? 'poweroff' : 'reboot';
  console.log(`Executing system ${request.action}`);
  send(hostSocket, { type: 'systemPowerExecuting', action: request.action });
  execFile(
    SYSTEMCTL_BIN,
    ['--no-ask-password', '--no-block', systemctlAction],
    { timeout: 5000 },
    error => {
      if (!error) return;
      console.error(`Could not ${request.action} the system: ${error.message}`);
      send(hostSocket, {
        type: 'systemPowerFailed',
        action: request.action,
        message: `Could not ${request.action} the Raspberry Pi`
      });
    }
  );
}

function scheduleSystemPower(ws, action) {
  const normalized = powerActionName(action);
  if (!normalized) {
    sendError(ws, 'INVALID_POWER_ACTION', 'Power action must be reboot or shutdown');
    return;
  }
  if (pendingSystemPower) {
    sendError(ws, 'SYSTEM_POWER_PENDING', 'A system power action is already counting down');
    return;
  }
  const scheduledAt = Date.now();
  const request = {
    action: normalized,
    scheduledAt,
    deadlineAt: scheduledAt + SYSTEM_POWER_DELAY_MS,
    timer: null
  };
  pendingSystemPower = request;
  request.timer = setTimeout(() => executeSystemPower(request), SYSTEM_POWER_DELAY_MS);
  send(ws, {
    type: 'systemPowerScheduled',
    action: normalized,
    delayMs: SYSTEM_POWER_DELAY_MS,
    scheduledAt,
    deadlineAt: request.deadlineAt
  });
}

function cancelSystemPower(ws) {
  if (!pendingSystemPower) {
    sendError(ws, 'NO_SYSTEM_POWER_PENDING', 'No system power action is counting down');
    return;
  }
  const action = pendingSystemPower.action;
  clearTimeout(pendingSystemPower.timer);
  pendingSystemPower = null;
  send(ws, { type: 'systemPowerCancelled', action });
}

function hostRequestAuthorized(req) {
  return Boolean(
    !shuttingDown &&
    hostSocket &&
    hostSocket.readyState === 1 &&
    hostSocket.hostToken &&
    tokenMatches(req.get('x-sfts-host-token'), hostSocket.hostToken)
  );
}

function requireHostRequest(req, res, next) {
  if (!hostRequestAuthorized(req)) {
    res.status(401).json({ ok: false, message: 'An active host session is required' });
    return;
  }
  next();
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function usbMountpoints(device) {
  const values = Array.isArray(device.mountpoints)
    ? device.mountpoints
    : [device.mountpoint];
  return values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
}

function flattenUsbPartitions(nodes, inheritedTransport = '', inheritedDiskPath = '') {
  const devices = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const transport = String(node.tran || inheritedTransport || '').toLowerCase();
    const children = Array.isArray(node.children) ? node.children : [];
    const diskPath = node.type === 'disk' ? node.path : inheritedDiskPath;
    const mountpoints = usbMountpoints(node);
    if (transport === 'usb' && node.path &&
        (node.type === 'part' || (node.type === 'disk' && children.length === 0)) &&
        (node.fstype || mountpoints.length)) {
      devices.push({
        path: node.path,
        diskPath,
        uuid: String(node.uuid || '').trim().toLowerCase(),
        label: String(node.label || '').trim(),
        fstype: String(node.fstype || '').trim().toLowerCase(),
        mountpoints
      });
    }
    devices.push(...flattenUsbPartitions(children, transport, diskPath));
  }
  return devices;
}

async function usbDevices() {
  const { stdout } = await execFileAsync(LSBLK_BIN, [
    '--json',
    '--tree',
    '--output',
    'PATH,TYPE,TRAN,RM,FSTYPE,UUID,LABEL,MOUNTPOINTS'
  ]);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('USB device information was invalid');
  }
  return flattenUsbPartitions(parsed.blockdevices);
}

function chooseUsbDevice(devices) {
  const matching = USB_EXPECTED_UUID
    ? devices.filter(device => device.uuid === USB_EXPECTED_UUID)
    : devices;
  if (!matching.length) return { device: null, message: 'USB DRIVE NOT DETECTED' };
  if (matching.length === 1) return { device: matching[0], message: '' };
  if (USB_EXPECTED_UUID) return { device: null, message: 'USB UUID MATCHED MORE THAN ONE PARTITION' };
  const diskPaths = new Set(matching.map(device => device.diskPath || device.path));
  if (diskPaths.size !== 1) return { device: null, message: 'MORE THAN ONE USB FLASH DRIVE DETECTED' };
  const mounted = matching.filter(device => usbMountpoints(device).length === 1);
  if (mounted.length === 1) return { device: mounted[0], message: '' };
  const filesystems = matching.filter(device => device.fstype || usbMountpoints(device).length);
  if (filesystems.length === 1) return { device: filesystems[0], message: '' };
  return { device: null, message: 'MORE THAN ONE USB STORAGE PARTITION DETECTED' };
}

async function usbContext({ mountIfNeeded = false } = {}) {
  if (!USB_IMPORT_ONLY) {
    return { enabled: false, connected: false, mounted: false, files: [], message: 'USB IMPORT MODE IS DISABLED' };
  }
  let devices;
  try {
    devices = await usbDevices();
  } catch (error) {
    return { enabled: true, connected: false, mounted: false, files: [], message: `USB CHECK FAILED: ${error.message}` };
  }
  let selection = chooseUsbDevice(devices);
  if (!selection.device) {
    return { enabled: true, connected: false, mounted: false, files: [], message: selection.message };
  }
  let device = selection.device;
  if (!usbMountpoints(device).length && mountIfNeeded) {
    try {
      await execFileAsync(UDISKSCTL_BIN, ['mount', '--block-device', device.path]);
      devices = await usbDevices();
      selection = chooseUsbDevice(devices);
      device = selection.device;
    } catch (error) {
      return { enabled: true, connected: true, mounted: false, files: [], message: `USB MOUNT FAILED: ${error.message}` };
    }
  }
  const mountPath = device && usbMountpoints(device)[0];
  if (!mountPath) {
    return { enabled: true, connected: true, mounted: false, files: [], message: 'USB DRIVE DETECTED — NOT MOUNTED' };
  }
  try {
    const resolvedMountPath = await realpath(mountPath);
    const mountStats = await stat(resolvedMountPath);
    if (!mountStats.isDirectory()) throw new Error('USB mount point is not a directory');
    return { enabled: true, connected: true, mounted: true, files: [], message: '', device, mountPath: resolvedMountPath };
  } catch (error) {
    return { enabled: true, connected: true, mounted: false, files: [], message: `USB MOUNT CHECK FAILED: ${error.message}` };
  }
}

async function usbFiles(context, allowedExtensions = USB_ALLOWED_EXTENSIONS) {
  if (!context.mounted) return [];
  const entries = await readdir(context.mountPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const candidate = path.resolve(context.mountPath, entry.name);
    if (path.dirname(candidate) !== context.mountPath) continue;
    let resolved;
    try {
      resolved = await realpath(candidate);
      const relative = path.relative(context.mountPath, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const details = await stat(resolved);
      if (!details.isFile()) continue;
      files.push({ name: entry.name, size: details.size, modifiedAt: details.mtime.toISOString() });
    } catch {
      // A file can disappear while the removable drive is being refreshed.
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

async function selectedUsbFile(context, fileName, {
  allowedExtensions = USB_ALLOWED_EXTENSIONS,
  maxBytes = MAX_IMPORT_BYTES,
  extensionMessage = 'ONLY EXCEL OR CSV FILES CAN BE IMPORTED'
} = {}) {
  if (!context.mounted) throw new Error('USB DRIVE IS NOT MOUNTED');
  if (typeof fileName !== 'string' || !fileName || path.basename(fileName) !== fileName) {
    throw new Error('INVALID USB FILE');
  }
  if (!allowedExtensions.has(path.extname(fileName).toLowerCase())) {
    throw new Error(extensionMessage);
  }
  const candidate = path.resolve(context.mountPath, fileName);
  if (path.dirname(candidate) !== context.mountPath) throw new Error('INVALID USB FILE');
  const resolved = await realpath(candidate);
  const relative = path.relative(context.mountPath, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('INVALID USB FILE');
  const details = await stat(resolved);
  if (!details.isFile()) throw new Error('USB FILE NOT FOUND');
  if (details.size > maxBytes) throw new Error('USB FILE IS TOO LARGE');
  return resolved;
}

let usbOperation = Promise.resolve();
let pendingUsbOperations = 0;
let rulesUpdateInProgress = false;
function withUsbOperation(action) {
  if (pendingUsbOperations >= 3) return Promise.reject(new Error('USB is busy; wait for the current operation to finish'));
  pendingUsbOperations += 1;
  const operation = usbOperation.then(action, action).finally(() => { pendingUsbOperations -= 1; });
  usbOperation = operation.catch(() => {});
  return operation;
}

function withRulesOperation(req, action) {
  return withUsbOperation(async () => {
    if (!hostRequestAuthorized(req) || tournamentMatchIsBusy()) throw new Error('Finish or reset the match before changing rules');
    rulesUpdateInProgress = true;
    try { return await action(); } finally { rulesUpdateInProgress = false; }
  });
}

async function writePlayerTemplateToUsb(context) {
  if (!context.mounted) throw new Error('USB DRIVE IS NOT MOUNTED');
  const target = path.join(context.mountPath, USB_TEMPLATE_FILE);
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('USB TEMPLATE TARGET IS A SYMBOLIC LINK');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const output = await createPlayerTemplateBuffer();
  const temporary = path.join(context.mountPath, `.sfts-template-${crypto.randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o640);
    await handle.writeFile(output);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
  const details = await stat(target);
  return { fileName: USB_TEMPLATE_FILE, size: details.size };
}

async function availableUsbTarget(context, requestedFileName) {
  if (!context.mounted) throw new Error('USB DRIVE IS NOT MOUNTED');
  const extension = path.extname(requestedFileName);
  const stem = path.basename(requestedFileName, extension);
  for (let sequence = 0; sequence < 1000; sequence += 1) {
    const fileName = sequence ? `${stem}_${sequence}${extension}` : requestedFileName;
    const target = path.resolve(context.mountPath, fileName);
    if (path.dirname(target) !== context.mountPath) throw new Error('INVALID USB PDF TARGET');
    try {
      await lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') return { fileName, target };
      throw error;
    }
  }
  throw new Error('TOO MANY CATEGORY RESULT FILES WITH THE SAME NAME');
}

async function writeManualCategoryPdfToUsb(context, category, records, options) {
  const generatedAt = new Date();
  const result = await fileJobs.run('pdf', {
    category,
    records,
    options,
    generatedAt: generatedAt.toISOString()
  });
  const destination = await availableUsbTarget(
    context,
    result.fileName
  );
  const temporaryPath = path.join(
    context.mountPath,
    `.${destination.fileName}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o640);
    await handle.writeFile(Buffer.from(result.buffer));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, destination.target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  const details = await stat(destination.target);
  return { fileName: destination.fileName, size: details.size };
}

async function unmountUsb(context) {
  if (!context.mounted || !context.device?.path) throw new Error('USB DRIVE IS NOT MOUNTED');
  if (!/^\/dev\/[^/]+$/.test(context.device.path)) throw new Error('USB DEVICE PATH IS INVALID');
  await execFileAsync(UDISKSCTL_BIN, ['unmount', '--block-device', context.device.path]);
}

function tournamentScheduleRows() {
  if (tournament.format === 'IMPORTED_MATCHES') return tournament.schedule.map(bout => ({
    'Bout Number': bout.officialBoutNo, Stage: bout.stage, Division: bout.division, Gender: bout.gender,
    'Weight Category': bout.weightCategory, Group: bout.categoryGroup,
    'Hong Name': bout.RED?.playerName || bout.redPlayerName || 'BYE', 'Hong Club': bout.RED?.club || '', 'Hong State Code': bout.RED?.stateCode || '', 'Hong District': bout.RED?.district || '',
    'Chung Name': bout.BLUE?.playerName || bout.bluePlayerName || 'BYE', 'Chung Club': bout.BLUE?.club || '', 'Chung State Code': bout.BLUE?.stateCode || '', 'Chung District': bout.BLUE?.district || '',
    Status: bout.status, Winner: bout.winnerName || ''
  }));
  const bouts = tournament.schedule.map(bout => ({
    Bout: bout.boutNo,
    'Bracket ID': bout.groupId,
    Division: bout.division,
    Gender: bout.gender,
    'Weight Category': bout.weightCategory,
    'Category Group': bout.categoryGroup,
    Round: bout.round,
    'Red Player': bout.redPlayerName,
    'Blue Player': bout.bluePlayerName,
    Status: bout.status,
    Winner: bout.winnerName || bout.winner || '',
    'Tie Reason': bout.tieReason || '',
    Announcement: bout.announcement
  }));
  const byes = (tournament.byes || []).map(bye => ({
    Bout: '',
    'Bracket ID': bye.groupId,
    Division: bye.division,
    Gender: bye.gender,
    'Weight Category': bye.weightCategory,
    'Category Group': bye.categoryGroup,
    Round: bye.round,
    'Red Player': bye.playerName,
    'Blue Player': 'BYE',
    Status: 'BYE',
    Winner: bye.playerId,
    Announcement: bye.announcement
  }));
  return [...bouts, ...byes];
}

function tournamentResultRows() {
  if (tournament.format === 'IMPORTED_MATCHES') {
    const category = manualCompetition.categories.find(item => item.id === tournament.categoryId);
    return Object.entries(category?.placements || {}).filter(([, player]) => player).map(([place, player]) => ({
      Division: category.division, Gender: category.gender, 'Weight Category': category.weightCategory, Group: category.categoryGroup,
      Place: ({ gold: '1ST', silver: '2ND', bronze1: '3RD', bronze2: '3RD' })[place], Player: player.playerName, Club: player.club, Status: category.status
    }));
  }
  const labels = tournament.placementPolicy?.labels || rules.tournament.placements.labels;
  return tournament.groups.flatMap(group => (
    group.resultStatus !== 'COMPLETED' ? [] : (group.placements || []).map(placement => {
      const player = tournament.players.find(item => item.id === placement.playerId);
      const placeLabel = placement.place === 1
        ? labels.first
        : placement.place === 2
          ? labels.second
          : labels.third;
      return {
        'Bracket ID': group.id,
        Division: group.division,
        Gender: group.gender,
        'Weight Category': group.weightCategory,
        'Category Group': group.categoryGroup,
        Place: placeLabel,
        'Player ID': placement.playerId,
        Player: placement.playerName,
        'State Code': player?.stateCode || '',
        District: player?.district || '',
        Club: player?.club || ''
      };
    })
  ));
}

async function scheduleWorkbook(format = 'xlsx') {
  const resultRows = tournamentResultRows();
  return fileJobs.run('workbook', { format, sheets: [
    { name: 'Schedule', rows: tournamentScheduleRows(), json: true },
    { name: 'Results', json: resultRows.length > 0, rows: resultRows.length ? resultRows : [[
      'Bracket ID', 'Division', 'Gender', 'Weight Category', 'Category Group', 'Place', 'Player ID', 'Player',
      'State Code', 'District', 'Club'
    ]] }
  ] });
}

function tournamentMatchIsBusy() {
  return Boolean(tournament.activeBoutNo) || match.test.active || match.running || match.phase === 'BREAK' || (
    match.phase === 'ROUND' && (
      match.roundHistory.length > 0 ||
      match.red.score > 0 ||
      match.blue.score > 0 ||
      match.red.gamjeom > 0 ||
      match.blue.gamjeom > 0 ||
      Object.keys(match.votes).length > 0
    )
  );
}

const MANUAL_COMPETITIONS = new Set(['KYORUGI', 'FRESHER KYORUGI']);
const MANUAL_BOUT_STAGES = new Set(['PRELIMINARY', 'QUARTERFINAL', 'SEMIFINAL', 'FINAL']);

function manualBoutSettingsLocked() {
  return Boolean(
    tournament.activeBoutNo || match.test.active || match.running || match.phase !== 'ROUND' ||
    match.roundStarted || match.roundHistory.length || match.red.score || match.blue.score ||
    match.red.gamjeom || match.blue.gamjeom || Object.keys(match.votes).length ||
    match.kyeShi?.running || Number(match.kyeShi?.elapsedMs) > 0
  );
}

function practiceMatchIsBusy() {
  if (tournament.activeBoutNo || match.test.active || match.running) return true;
  if (match.phase === 'BREAK' || match.phase === 'TIE_DECISION') return true;
  if (match.phase === 'MATCH_END') return false;
  return Boolean(
    match.roundStarted || match.roundHistory.length || match.red.score || match.blue.score ||
    match.red.gamjeom || match.blue.gamjeom || Object.keys(match.votes).length ||
    match.kyeShi?.running || Number(match.kyeShi?.elapsedMs) > 0
  );
}

function practicePlayerDetails(input, corner) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: `${corner} player details are required` };
  }
  const playerName = String(input.playerName || input.name || '').trim().slice(0, 64);
  const stateCode = String(input.stateCode || '').trim().toUpperCase().slice(0, 2);
  if (!playerName) return { error: `${corner} player name is required` };
  if (stateCode && !INDIAN_STATE_CODES.has(stateCode)) return { error: `${corner} state code is invalid` };
  return {
    playerName,
    stateCode,
    district: String(input.district || '').trim().slice(0, 48)
  };
}

function loadPracticeMatch(details) {
  if (practiceMatchIsBusy()) {
    return { ok: false, code: 'MATCH_IN_PROGRESS', message: 'Finish or reset the current match before loading practice mode' };
  }
  const hong = practicePlayerDetails(details?.RED, 'HONG');
  const chung = practicePlayerDetails(details?.BLUE, 'CHUNG');
  if (hong.error || chung.error) {
    return { ok: false, code: 'INVALID_PRACTICE_PLAYER', message: hong.error || chung.error };
  }
  const remoteCount = match.remoteCount;
  const officialMatchNo = match.mode === 'PRACTICE'
    ? match.matchNo
    : match.phase === 'MATCH_END'
      ? match.matchNo + 1
      : match.matchNo;
  match = makeMatch(
    officialMatchNo,
    'HONG',
    'CHUNG',
    match.configuredRoundMs,
    hong,
    chung
  );
  match.mode = 'PRACTICE';
  match.practiceMatchNo = 1;
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, Number(remoteCount) || MAX_ACTIVE_REMOTES));
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearRemoteScoreHighlights();
  clearVoteSettleGuard();
  timerLastAt = null;
  kyeShiLastAt = null;
  return { ok: true };
}

function manualPlayerDetails(input, corner) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: `${corner} player details are required` };
  }
  const playerName = String(input.playerName || input.name || '').trim().slice(0, 64);
  const club = String(input.club || input.affiliation || '').trim().slice(0, 64);
  const stateCode = String(input.stateCode || '').trim().toUpperCase().slice(0, 2);
  if (!playerName) return { error: `${corner} player name is required` };
  if (!club) return { error: `${corner} affiliation or club is required` };
  if (stateCode && !INDIAN_STATE_CODES.has(stateCode)) return { error: `${corner} state code is invalid` };
  return {
    playerName,
    club,
    stateCode,
    district: String(input.district || '').trim().slice(0, 48)
  };
}

function manualCategoryFromInput(input) {
  const divisionDefinition = resolveTournamentDivision(input?.division);
  const gender = normalizeGender(input?.gender);
  const competition = String(input?.competition || '').trim().toUpperCase();
  const eventName = String(input?.eventName || '').trim().slice(0, 96);
  const eventDate = String(input?.eventDate || '').trim().slice(0, 10);
  const venue = String(input?.venue || '').trim().slice(0, 128);
  const nextArenaNumber = normalizeArenaNumber(input?.arenaNumber);
  if (!eventName || !eventDate || !venue || !nextArenaNumber) {
    return { error: 'Tournament name, date, venue, and arena number are required' };
  }
  const parsedEventDate = new Date(`${eventDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(parsedEventDate.valueOf()) || parsedEventDate.toISOString().slice(0, 10) !== eventDate) {
    return { error: 'Tournament date must be a valid calendar date' };
  }
  if (!MANUAL_COMPETITIONS.has(competition)) return { error: 'Choose a valid competition type' };
  if (!divisionDefinition || !gender) return { error: 'Choose a valid rulepack division and gender' };
  let weightCategory = '';
  let categoryGroup = '';
  if (divisionDefinition.categoryType === 'GROUP') {
    const group = resolveCategoryGroup(divisionDefinition, input?.categoryGroup);
    if (!group) return { error: `Choose a valid ${divisionDefinition.label} group from the active rulepack` };
    categoryGroup = group.name;
  } else {
    const category = resolveWeightCategory(divisionDefinition, gender, input?.weightCategory);
    if (!category) return { error: `Choose a valid ${divisionDefinition.label} ${gender} weight category from the active rulepack` };
    weightCategory = category.name;
  }
  return {
    value: {
      eventName,
      eventDate,
      venue,
      arenaNumber: nextArenaNumber,
      competition,
      division: divisionDefinition.id,
      divisionLabel: divisionDefinition.label,
      gender,
      weightCategory,
      categoryGroup
    }
  };
}

function manualCategoryIdentity(category) {
  return [
    category?.eventName,
    category?.eventDate,
    category?.competition,
    category?.division,
    category?.gender,
    category?.categoryGroup || category?.weightCategory
  ].map(normalizeTournamentValue).join('|');
}

function matchingOpenManualCategory(details) {
  const identity = manualCategoryIdentity(details);
  return manualCompetition.categories.find(category => (
    category.status === 'OPEN' && manualCategoryIdentity(category) === identity
  )) || null;
}

function saveManualBout(input) {
  if (manualBoutSettingsLocked()) {
    return { ok: false, code: 'MATCH_IN_PROGRESS', message: 'Finish or reset the current match before changing manual bout details' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_MANUAL_BOUT', message: 'Manual bout details are required' };
  }
  const red = manualPlayerDetails(input.RED, 'RED');
  const blue = manualPlayerDetails(input.BLUE, 'BLUE');
  if (red.error || blue.error) {
    return { ok: false, code: 'INVALID_MANUAL_PLAYER', message: red.error || blue.error };
  }
  const officialBoutNo = String(input.officialBoutNo || '').trim().slice(0, 40);
  const stage = String(input.stage || '').trim().toUpperCase();
  if (!officialBoutNo || !MANUAL_BOUT_STAGES.has(stage)) {
    return { ok: false, code: 'INVALID_MANUAL_BOUT', message: 'Official bout/reference number and a valid stage are required' };
  }

  let category = null;
  const categoryId = String(input.categoryId || '').trim();
  if (categoryId) category = manualCompetition.categories.find(item => item.id === categoryId) || null;
  if (categoryId && !category) {
    return { ok: false, code: 'MANUAL_CATEGORY_NOT_FOUND', message: 'The selected manual category was not found' };
  }
  if (!category) {
    const parsed = manualCategoryFromInput(input);
    if (parsed.error) return { ok: false, code: 'INVALID_MANUAL_CATEGORY', message: parsed.error };
    category = matchingOpenManualCategory(parsed.value);
    if (!category) {
      if (manualCompetition.categories.length >= 2000) {
        return { ok: false, code: 'MANUAL_CATEGORY_LIMIT', message: 'The manual category archive has reached its 2,000 category limit' };
      }
      category = {
        id: crypto.randomUUID(),
        ...parsed.value,
        status: 'OPEN',
        ruleset: deep(activeRulesMetadata),
        createdAt: new Date().toISOString(),
        finalizedAt: null,
        placementsSavedAt: null,
        placementsCalculatedAt: null,
        placementSource: 'AUTOMATIC',
        matchRecordIds: [],
        calculatedPlacements: { gold: null, silver: null, bronze1: null, bronze2: null },
        placements: { gold: null, silver: null, bronze1: null, bronze2: null }
      };
      manualCompetition.categories.unshift(category);
    }
  } else if (category.status === 'FINALIZED') {
    return { ok: false, code: 'MANUAL_CATEGORY_FINALIZED', message: 'This category is finalized and cannot accept another bout' };
  }
  if (manualMatchRecords.some(record => (
    record.manualBout?.categoryId === category.id &&
    String(record.manualBout?.officialBoutNo || '').trim().toUpperCase() === officialBoutNo.toUpperCase()
  ))) {
    return { ok: false, code: 'DUPLICATE_OFFICIAL_BOUT', message: 'That official bout/reference number is already completed in this category' };
  }

  arenaNumber = category.arenaNumber;
  match.mode = 'OFFICIAL';
  match.practiceMatchNo = null;
  const categoryProfile = {
    division: category.division,
    weightCategory: category.weightCategory,
    categoryGroup: category.categoryGroup
  };
  Object.assign(match.red, red, categoryProfile);
  Object.assign(match.blue, blue, categoryProfile);
  match.manualBout = {
    categoryId: category.id,
    officialBoutNo,
    stage,
    loadedAt: new Date().toISOString()
  };
  manualCompetition.activeCategoryId = category.id;
  persistManualArchive();
  return { ok: true, categoryId: category.id };
}

function manualCategoryCompletedRecordIds(category) {
  const ids = new Set(
    Array.isArray(category?.matchRecordIds)
      ? category.matchRecordIds.map(id => String(id || '').trim()).filter(Boolean)
      : []
  );
  for (const record of manualMatchRecords) {
    if (record.manualBout?.categoryId === category?.id && record.id) ids.add(String(record.id));
  }
  for (const record of matchHistory) {
    if (record.manualBout?.categoryId === category?.id && record.id) ids.add(String(record.id));
  }
  return ids;
}

function manualCategoryDeleteConfirmation(category, completedBoutCount) {
  if (completedBoutCount > 0) return `DELETE ${completedBoutCount} BOUT${completedBoutCount === 1 ? '' : 'S'}`;
  if (category.status === 'FINALIZED') return 'DELETE FINALIZED CATEGORY';
  return '';
}

function removeImportedCategoryFixtures(categoryId, categoryKey = null) {
  if (importedWorkbook) {
    importedWorkbook.categories = importedWorkbook.categories.filter(item => item.key !== categoryKey && (!categoryId || item.fixture.categoryId !== categoryId));
    if (!importedWorkbook.categories.length) {
      importedWorkbook = null;
      tournament = makeTournament();
    } else if (!importedWorkbook.categories.some(item => item.key === importedWorkbook.selectedKey)) {
      const selected = importedWorkbook.categories[0];
      importedWorkbook.selectedKey = selected.key;
      tournament = selected.fixture;
    }
  } else if (categoryKey === 'single' || (categoryId && tournament.categoryId === categoryId)) tournament = makeTournament();
}

function deleteManualCategory(categoryId, { deleteRecords = false, confirmation = '', allowFinishedMatch = false } = {}) {
  const id = String(categoryId || '').trim();
  const index = manualCompetition.categories.findIndex(category => category.id === id);
  if (index < 0) {
    return { ok: false, code: 'MANUAL_CATEGORY_NOT_FOUND', message: 'Manual category not found' };
  }
  const category = manualCompetition.categories[index];
  if (match.manualBout?.categoryId === id && !(allowFinishedMatch && match.phase === 'MATCH_END' && !tournament.activeBoutNo)) {
    return { ok: false, code: 'MANUAL_CATEGORY_IN_USE', message: 'This category is currently loaded on the scoreboard' };
  }
  const completedRecordIds = manualCategoryCompletedRecordIds(category);
  const completedBoutCount = completedRecordIds.size;
  const expectedConfirmation = manualCategoryDeleteConfirmation(category, completedBoutCount);
  if (completedBoutCount > 0 && deleteRecords !== true) {
    return { ok: false, code: 'MANUAL_CATEGORY_NOT_EMPTY', message: 'Categories with completed bouts cannot be deleted because their official records must be preserved' };
  }
  if (category.status === 'FINALIZED' && deleteRecords !== true) {
    return { ok: false, code: 'MANUAL_CATEGORY_FINALIZED', message: 'Finalized categories cannot be deleted' };
  }
  if (expectedConfirmation && String(confirmation || '').trim().toUpperCase() !== expectedConfirmation) {
    return {
      ok: false,
      code: 'MANUAL_CATEGORY_DELETE_CONFIRMATION_REQUIRED',
      message: `Type ${expectedConfirmation} exactly to permanently delete this category${completedBoutCount ? ' and its official bout records' : ''}`
    };
  }
  const manualRecordCountBefore = manualMatchRecords.length;
  const historyCountBefore = matchHistory.length;
  manualMatchRecords = manualMatchRecords.filter(record => record.manualBout?.categoryId !== id);
  matchHistory = matchHistory.filter(record => record.manualBout?.categoryId !== id);
  manualCompetition.categories.splice(index, 1);
  if (manualCompetition.activeCategoryId === id) manualCompetition.activeCategoryId = null;
  removeImportedCategoryFixtures(id);
  persistManualArchive();
  if (allowFinishedMatch && match.manualBout?.categoryId === id) newMatch({ clearPlayers: true });
  return {
    ok: true,
    deletedManualRecords: manualRecordCountBefore - manualMatchRecords.length,
    deletedHistoryRecords: historyCountBefore - matchHistory.length
  };
}

function manualCategoryParticipants(categoryId) {
  const participants = new Map();
  for (const record of manualMatchRecords.filter(item => item.manualBout?.categoryId === categoryId)) {
    for (const player of [record.red, record.blue]) {
      if (!player?.playerName) continue;
      const key = `${player.playerName.trim().toUpperCase()}|${String(player.club || '').trim().toUpperCase()}`;
      participants.set(key, { key, playerName: player.playerName, club: player.club || '' });
    }
  }
  return participants;
}

function manualRecordParticipant(player) {
  if (!player?.playerName) return null;
  return {
    key: `${player.playerName.trim().toUpperCase()}|${String(player.club || '').trim().toUpperCase()}`,
    playerName: player.playerName,
    club: player.club || ''
  };
}

function calculateManualCategoryPlacements(categoryId) {
  const records = manualMatchRecords
    .filter(record => record.manualBout?.categoryId === categoryId)
    .sort((left, right) => String(left.endedAt || '').localeCompare(String(right.endedAt || '')));
  const calculated = { gold: null, silver: null, bronze1: null, bronze2: null };
  const final = [...records].reverse().find(record => record.manualBout?.stage === 'FINAL' && record.winner);
  if (final) {
    calculated.gold = manualRecordParticipant(final.winner === 'RED' ? final.red : final.blue);
    calculated.silver = manualRecordParticipant(final.winner === 'RED' ? final.blue : final.red);
  }
  const semifinalLosers = records
    .filter(record => record.manualBout?.stage === 'SEMIFINAL' && record.winner)
    .map(record => manualRecordParticipant(record.winner === 'RED' ? record.blue : record.red))
    .filter(Boolean)
    .slice(-2);
  calculated.bronze1 = semifinalLosers[0] || null;
  calculated.bronze2 = semifinalLosers[1] || null;
  return calculated;
}

function manualPlacementsMatch(left, right) {
  return ['gold', 'silver', 'bronze1', 'bronze2'].every(place => (
    (left?.[place]?.key || '') === (right?.[place]?.key || '')
  ));
}

function applyAutomaticManualPlacements(category) {
  const calculated = calculateManualCategoryPlacements(category.id);
  category.calculatedPlacements = calculated;
  category.placementsCalculatedAt = new Date().toISOString();
  if (category.status !== 'FINALIZED') {
    category.placements = deep(calculated);
    category.placementSource = 'AUTOMATIC';
    category.placementsSavedAt = null;
  }
  return calculated;
}

function normalizeManualCategoryPlacementState() {
  const categoryIds = new Set(manualCompetition.categories.map(category => category.id));
  if (!categoryIds.has(manualCompetition.activeCategoryId)) manualCompetition.activeCategoryId = null;
  for (const category of manualCompetition.categories) {
    const calculated = calculateManualCategoryPlacements(category.id);
    category.calculatedPlacements = calculated;
    category.placementsCalculatedAt ||= null;
    if (!category.placements || typeof category.placements !== 'object') {
      category.placements = deep(calculated);
    }
    const hasStoredPlacement = Object.values(category.placements).some(Boolean);
    if (category.status === 'OPEN' && !category.placementsSavedAt && !hasStoredPlacement) {
      category.placements = deep(calculated);
      category.placementSource = 'AUTOMATIC';
    } else if (!category.placementSource) {
      category.placementSource = manualPlacementsMatch(category.placements, calculated)
        ? category.placementsSavedAt ? 'AUTOMATIC_CONFIRMED' : 'AUTOMATIC'
        : 'OPERATOR_OVERRIDE';
    }
  }
}

function saveManualCategoryPlacements(categoryId, placements, finalize = false) {
  const category = manualCompetition.categories.find(item => item.id === String(categoryId || ''));
  if (!category) return { ok: false, code: 'MANUAL_CATEGORY_NOT_FOUND', message: 'Manual category not found' };
  const importedFixture = importedWorkbook?.categories.find(item => item.fixture.categoryId === category.id)?.fixture || (tournament.categoryId === category.id ? tournament : null);
  if (finalize && isAutomaticFixture(importedFixture) && importedFixture.schedule.some(bout => !['COMPLETED', 'BYE'].includes(bout.status))) return { ok: false, code: 'CATEGORY_IN_PROGRESS', message: 'Complete the category matches and confirm every winner before finalizing' };
  if (category.status === 'FINALIZED') return { ok: false, code: 'MANUAL_CATEGORY_FINALIZED', message: 'This category is already finalized' };
  if (!placements || typeof placements !== 'object' || Array.isArray(placements)) {
    return { ok: false, code: 'INVALID_PLACEMENTS', message: 'Category placements are required' };
  }
  const participants = manualCategoryParticipants(category.id);
  const next = {};
  const used = new Set();
  for (const place of ['gold', 'silver', 'bronze1', 'bronze2']) {
    const key = String(placements[place] || '').trim();
    if (!key) {
      next[place] = null;
      continue;
    }
    if (!participants.has(key) || used.has(key)) {
      return { ok: false, code: 'INVALID_PLACEMENTS', message: 'Placements must use distinct competitors recorded in this category' };
    }
    used.add(key);
    next[place] = participants.get(key);
  }
  if (finalize && !next.gold) {
    return { ok: false, code: 'INVALID_PLACEMENTS', message: 'Confirm the gold medallist before finalizing the category' };
  }
  category.placements = next;
  category.calculatedPlacements = calculateManualCategoryPlacements(category.id);
  category.placementSource = manualPlacementsMatch(next, category.calculatedPlacements)
    ? 'AUTOMATIC_CONFIRMED'
    : 'OPERATOR_OVERRIDE';
  category.placementsSavedAt = new Date().toISOString();
  if (finalize) {
    category.status = 'FINALIZED';
    category.finalizedAt = new Date().toISOString();
    if (manualCompetition.activeCategoryId === category.id) manualCompetition.activeCategoryId = null;
  }
  persistManualArchive();
  return { ok: true };
}

function findTournamentBout(boutNo, tournamentState = tournament) {
  const number = Number(boutNo);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return tournamentState.schedule.find(bout => bout.boutNo === number) || null;
}

function losingParticipant(bout) {
  if (!bout || bout.status !== 'COMPLETED' || !bout.winner) return null;
  if (bout.winner === bout.redPlayerId && bout.bluePlayerId) {
    return { playerId: bout.bluePlayerId, playerName: bout.bluePlayerName };
  }
  if (bout.winner === bout.bluePlayerId && bout.redPlayerId) {
    return { playerId: bout.redPlayerId, playerName: bout.redPlayerName };
  }
  return null;
}

function placementEntry(place, participant, basis, sourceBoutNo = null) {
  if (!participant?.playerId) return null;
  return {
    place,
    playerId: participant.playerId,
    playerName: participant.playerName,
    basis,
    sourceBoutNo
  };
}

function refreshTournamentGroupResults(tournamentState, group, groupBouts) {
  const placementPolicy = tournamentState.placementPolicy || rules.tournament.placements;
  group.placements = [];

  if (!placementPolicy.enabled) {
    group.resultStatus = 'DISABLED';
    return;
  }

  if (group.playerIds.length === 1) {
    const player = tournamentState.players.find(item => item.id === group.playerIds[0]);
    if (player) {
      group.championId = player.id;
      group.championName = player.name;
      group.placements = [placementEntry(1, { playerId: player.id, playerName: player.name }, 'ONLY_ENTRANT')];
      group.resultStatus = 'COMPLETED';
      return;
    }
  }

  const final = groupBouts.reduce((current, bout) => (
    !current || bout.round > current.round ? bout : current
  ), null);
  if (!final || final.status !== 'COMPLETED' || !final.winner) {
    group.resultStatus = 'PENDING';
    return;
  }

  const champion = {
    playerId: final.winner,
    playerName: final.winnerName || tournamentState.players.find(item => item.id === final.winner)?.name || ''
  };
  const runnerUp = losingParticipant(final);
  const placements = [
    placementEntry(1, champion, 'FINAL_WINNER', final.boutNo),
    placementEntry(2, runnerUp, 'FINAL_LOSER', final.boutNo)
  ].filter(Boolean);

  if (placementPolicy.thirdPlacePolicy === 'BOTH_SEMIFINAL_LOSERS') {
    const semifinalBoutNos = [final.redSourceBoutNo, final.blueSourceBoutNo]
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right);
    const seenPlayers = new Set(placements.map(item => item.playerId));
    for (const boutNo of semifinalBoutNos) {
      const semifinalLoser = losingParticipant(findTournamentBout(boutNo, tournamentState));
      if (!semifinalLoser || seenPlayers.has(semifinalLoser.playerId)) continue;
      const bronze = placementEntry(3, semifinalLoser, 'SEMIFINAL_LOSER', boutNo);
      if (bronze) {
        placements.push(bronze);
        seenPlayers.add(bronze.playerId);
      }
    }
  }

  group.placements = placements;
  group.resultStatus = 'COMPLETED';
}

function refreshTournamentBracket(tournamentState = tournament) {
  if (tournamentState.format === 'IMPORTED_MATCHES') {
    refreshFixtureProgression(tournamentState);
    return;
  }
  tournamentState.placementPolicy ||= deep(rules.tournament.placements);
  for (const bout of tournamentState.schedule) {
    for (const playerSide of ['red', 'blue']) {
      const sourceBoutNo = bout[`${playerSide}SourceBoutNo`];
      if (!sourceBoutNo) continue;
      const source = findTournamentBout(sourceBoutNo, tournamentState);
      const playerIdKey = `${playerSide}PlayerId`;
      const playerNameKey = `${playerSide}PlayerName`;
      if (source?.winner) {
        const player = tournamentState.players.find(item => item.id === source.winner);
        bout[playerIdKey] = source.winner;
        bout[playerNameKey] = source.winnerName || player?.name || `Winner of Bout ${sourceBoutNo}`;
      } else {
        bout[playerIdKey] = null;
        bout[playerNameKey] = source?.status === 'TIE_PENDING'
          ? `Tie pending in Bout ${sourceBoutNo}`
          : `Winner of Bout ${sourceBoutNo}`;
      }
    }

    if (bout.status === 'PENDING' || bout.status === 'SCHEDULED') {
      const ready = Boolean(bout.redPlayerId && bout.bluePlayerId);
      bout.status = ready ? 'SCHEDULED' : 'PENDING';
      bout.announcement = scheduleAnnouncement(bout);
    }
  }

  for (const bye of tournamentState.byes || []) {
    if (!bye.sourceBoutNo) continue;
    const source = findTournamentBout(bye.sourceBoutNo, tournamentState);
    if (source?.winner) {
      const player = tournamentState.players.find(item => item.id === source.winner);
      bye.playerId = source.winner;
      bye.playerName = source.winnerName || player?.name || `Winner of Bout ${bye.sourceBoutNo}`;
    } else {
      bye.playerId = null;
      bye.playerName = source?.status === 'TIE_PENDING'
        ? `Tie pending in Bout ${bye.sourceBoutNo}`
        : `Winner of Bout ${bye.sourceBoutNo}`;
    }
    bye.announcement = `${bye.playerName} advances by bye in round ${bye.round}, ${[bye.division, bye.gender, competitionCategory(bye)].filter(Boolean).join(', ')}`;
  }

  for (const group of tournamentState.groups) {
    const groupBouts = tournamentState.schedule.filter(bout => bout.groupId === group.id);
    const final = groupBouts.reduce((current, bout) => (
      !current || bout.round > current.round ? bout : current
    ), null);
    if (final?.status === 'COMPLETED' && final.winner) {
      group.championId = final.winner;
      group.championName = final.winnerName;
    }
    refreshTournamentGroupResults(tournamentState, group, groupBouts);
  }
}

function loadTournamentBout(bout) {
  if (tournament.format === 'IMPORTED_MATCHES') {
    if (tournament.recoveryError) return { ok: false, code: 'FIXTURE_RECOVERY_REVIEW', message: tournament.recoveryError };
    if (tournamentMatchIsBusy() || practiceMatchIsBusy()) return { ok: false, code: 'MATCH_BUSY', message: 'Finish or reset the current match before loading an imported bout' };
    if (isAutomaticFixture(tournament) && nextFixtureBout(tournament)?.boutNo !== bout.boutNo) return { ok: false, code: 'BOUT_OUT_OF_ORDER', message: 'Load the next available match in this category' };
    if (bout.status !== 'SCHEDULED') return { ok: false, code: 'BOUT_UNAVAILABLE', message: 'This bout is already completed' };
    const category = tournament.categoryId ? manualCompetition.categories.find(item => item.id === tournament.categoryId) : null;
    if (tournament.categoryId && !category) return { ok: false, code: 'MANUAL_CATEGORY_NOT_FOUND', message: 'This category was deleted; import the file again' };
    if (category?.status === 'FINALIZED') return { ok: false, code: 'MANUAL_CATEGORY_FINALIZED', message: 'This category is finalized' };
    if (manualMatchRecords.some(record => record.manualBout?.categoryId === category?.id && record.manualBout?.officialBoutNo.toUpperCase() === bout.officialBoutNo.toUpperCase())) return { ok: false, code: 'DUPLICATE_OFFICIAL_BOUT', message: 'This official bout is already completed' };
    const previous = match;
    const remoteCount = match.remoteCount;
    match = makeMatch(match.mode === 'PRACTICE' ? match.matchNo : match.phase === 'MATCH_END' ? match.matchNo + 1 : match.matchNo, 'HONG', 'CHUNG', match.configuredRoundMs);
    match.remoteCount = remoteCount;
    const saved = saveManualBout({ ...tournament.event, categoryId: tournament.categoryId || '', officialBoutNo: bout.officialBoutNo, stage: bout.stage, RED: bout.RED, BLUE: bout.BLUE });
    if (!saved.ok) { match = previous; return saved; }
    tournament.categoryId = saved.categoryId;
    match.manualBout.importedBoutNo = bout.boutNo;
    bout.status = 'IN_PROGRESS';
    tournament.activeBoutNo = bout.boutNo;
    refreshFixtureProgression(tournament);
    clearAllRemoteCombinations();
    clearLastRemoteButtons();
    clearRemoteScoreHighlights();
    clearVoteSettleGuard();
    timerLastAt = null;
    kyeShiLastAt = null;
    return { ok: true };
  }
  if (tournamentMatchIsBusy()) {
    return { ok: false, code: 'MATCH_BUSY', message: 'Finish or reset the current match before loading a scheduled bout' };
  }
  if (tournament.activeBoutNo && tournament.activeBoutNo !== bout.boutNo) {
    return { ok: false, code: 'MATCH_BUSY', message: 'Reset the currently loaded bout before loading another bout' };
  }
  if (bout.status !== 'SCHEDULED' && bout.status !== 'IN_PROGRESS') {
    return { ok: false, code: 'BOUT_UNAVAILABLE', message: 'This bout is already completed' };
  }
  const red = tournament.players.find(player => player.id === bout.redPlayerId);
  const blue = tournament.players.find(player => player.id === bout.bluePlayerId);
  if (!red || !blue) {
    return { ok: false, code: 'BOUT_INVALID', message: 'The scheduled players could not be found' };
  }
  const remoteCount = match.remoteCount;
  match = makeMatch(
    match.mode === 'PRACTICE'
      ? match.matchNo
      : match.phase === 'MATCH_END'
        ? match.matchNo + 1
        : match.matchNo,
    red.name,
    blue.name,
    match.configuredRoundMs,
    { ...red, playerName: red.name },
    { ...blue, playerName: blue.name }
  );
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, Number(remoteCount) || MAX_ACTIVE_REMOTES));
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearRemoteScoreHighlights();
  clearVoteSettleGuard();
  timerLastAt = null;
  kyeShiLastAt = null;
  bout.status = 'IN_PROGRESS';
  tournament.activeBoutNo = bout.boutNo;
  return { ok: true };
}

function completeTournamentBout(winner) {
  if (!tournament.activeBoutNo) return;
  const bout = findTournamentBout(tournament.activeBoutNo);
  if (!bout) return;
  if (tournament.format === 'IMPORTED_MATCHES') {
    bout.status = isAutomaticFixture(tournament) && !winner ? 'TIE_PENDING' : 'COMPLETED';
    bout.winner = winner;
    bout.winnerName = winner ? playerDisplayName(side(winner)) : 'DRAW';
    tournament.activeBoutNo = null;
    refreshFixtureProgression(tournament);
    return { completed: true };
  }
  if (!winner) {
    bout.status = 'TIE_PENDING';
    bout.winner = null;
    bout.winnerName = null;
    bout.tieReason = 'Manual tie resolution required';
  bout.announcement = `Tie pending for Bout ${bout.boutNo}: ${bout.redPlayerName} versus ${bout.bluePlayerName}`;
    refreshTournamentBracket();
    return { tiePending: true };
  }
  bout.status = 'COMPLETED';
  bout.winner = winner === 'RED' ? bout.redPlayerId : winner === 'BLUE' ? bout.bluePlayerId : null;
  bout.winnerName = winner === 'RED' ? bout.redPlayerName : winner === 'BLUE' ? bout.bluePlayerName : null;
  bout.tieReason = '';
  tournament.activeBoutNo = null;
  refreshTournamentBracket();
  return { completed: true };
}

function correctImportedWinner(boutNo, winner) {
  const bout = findTournamentBout(boutNo);
  if (!isAutomaticFixture(tournament) || !bout || !['COMPLETED', 'TIE_PENDING'].includes(bout.status) || !['RED', 'BLUE'].includes(winner)) return { ok: false, code: 'WINNER_CORRECTION_UNAVAILABLE', message: 'Select a finished imported match and its correct winner' };
  const category = manualCompetition.categories.find(item => item.id === tournament.categoryId);
  if (!category || category.status === 'FINALIZED') return { ok: false, code: 'MANUAL_CATEGORY_FINALIZED', message: 'This category is missing or finalized' };
  if (fixtureDescendants(tournament, bout.boutNo).some(item => ['IN_PROGRESS', 'COMPLETED', 'TIE_PENDING'].includes(item.status))) return { ok: false, code: 'FOLLOWING_MATCH_STARTED', message: 'The winner is locked because a dependent match has already been loaded or completed. Reset an unstarted dependent match before correcting it' };
  const record = manualMatchRecords.find(item => item.manualBout?.categoryId === category.id && String(item.manualBout.officialBoutNo).toUpperCase() === bout.officialBoutNo.toUpperCase());
  if (!record) return { ok: false, code: 'MATCH_RECORD_NOT_FOUND', message: 'The saved match record could not be found' };
  if (record.winner === winner) return { ok: true };
  const previousWinner = record.winner;
  record.winner = winner;
  record.winnerName = playerDisplayName(record[winner.toLowerCase()]);
  record.defeatedName = playerDisplayName(record[other(winner).toLowerCase()]);
  record.reason = 'WINNER CORRECTED BY OPERATOR';
  record.operatorHistory ||= [];
  record.operatorHistory.push({ id: crypto.randomUUID(), matchNo: record.matchNo, arenaNumber: record.arenaNumber, round: record.rounds?.at(-1)?.round || 1, timerMs: 0, action: 'WINNER CORRECTION', player: winner, from: previousWinner || 'DRAW', to: winner, recordedAt: new Date().toISOString() });
  const recent = matchHistory.find(item => item.id === record.id);
  if (recent) Object.assign(recent, deep(record));
  bout.winner = winner;
  bout.winnerName = bout[winner].playerName;
  bout.status = 'COMPLETED';
  refreshFixtureProgression(tournament);
  applyAutomaticManualPlacements(category);
  if (match.manualBout?.categoryId === category.id && match.manualBout.importedBoutNo === bout.boutNo && match.phase === 'MATCH_END') {
    match.matchWinner = winner;
    match.matchReason = record.reason;
  }
  persistManualArchive();
  return { ok: true };
}

function resolveTournamentTie(bout, winner) {
  if (tournament.activeBoutNo !== bout.boutNo || bout.status !== 'TIE_PENDING') {
    return { ok: false, code: 'TIE_UNAVAILABLE', message: 'Only the currently loaded tied bout can be resolved' };
  }
  if (winner !== 'RED' && winner !== 'BLUE') {
    return { ok: false, code: 'INVALID_WINNER', message: 'Tie winner must be RED or BLUE' };
  }
  bout.status = 'COMPLETED';
  bout.winner = winner === 'RED' ? bout.redPlayerId : bout.bluePlayerId;
  bout.winnerName = winner === 'RED' ? bout.redPlayerName : bout.bluePlayerName;
  bout.tieReason = 'Manual tie resolution';
  bout.announcement = scheduleAnnouncement(bout);
  const historyEntry = matchHistory[0];
  if (historyEntry && historyEntry.matchNo === match.matchNo && historyEntry.winner === null) {
    historyEntry.winner = winner;
    historyEntry.winnerName = playerDisplayName(side(winner));
    historyEntry.reason = 'TIE RESOLVED';
  }
  tournament.activeBoutNo = null;
  match.matchWinner = winner;
  match.matchReason = 'TIE RESOLVED';
  refreshTournamentBracket();
  return { ok: true };
}

function manualPlayersAnnouncement(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return { ok: false, code: 'INVALID_PLAYER_DETAILS', message: 'Both player details are required before announcing' };
  }
  const players = {};
  for (const player of ['RED', 'BLUE']) {
    const input = details[player];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, code: 'INVALID_PLAYER_DETAILS', message: 'Both HONG and CHUNG player details are required before announcing' };
    }
    const name = String(input.playerName || '').trim().slice(0, 64);
    if (!name) {
      return { ok: false, code: 'INVALID_PLAYER_DETAILS', message: `${player === 'RED' ? 'HONG' : 'CHUNG'} player name is required before announcing` };
    }
    players[player] = { name };
  }

  return {
    ok: true,
    text: contestantReadyAnnouncement(players.RED.name, players.BLUE.name)
  };
}

async function announceAnnouncement(text, fields = {}) {
  let audio = null;
  try {
    audio = await tts.synthesize(text);
  } catch (error) {
    if (error.code === 'TTS_BUSY') {
      sendError(hostSocket, 'TTS_BUSY', error.message);
      return;
    }
    console.error('Local TTS failed:', error.message);
  }
  emit({
    type: 'announcement',
    ...fields,
    text,
    ...(audio ? { audioUrl: `/api/tts/audio/${audio.fileName}` } : {})
  });
}

async function announceTournamentBout(bout) {
  await announceAnnouncement(bout.announcement, { boutNo: bout.boutNo });
}

async function createPlayerTemplateBuffer() {
  return Buffer.from(await fileJobs.run('workbook', { sheets: createFixtureTemplateSheets(tournamentDivisionDefinitions()) }));
}

function rulesSummary(rulePack) {
  return {
    format: rulePack.match.format,
    rounds: rulePack.match.rounds,
    roundsRequiredToWin: rulePack.match.roundsRequiredToWin,
    roundDurationSeconds: rulePack.match.roundDurationSeconds,
    breakDurationPolicy: rulePack.match.breakDurationPolicy,
    basePointValues: rulePack.scoring.basePointValues,
    basePointLabels: rulePack.scoring.basePointLabels,
    acceptedPointValues: rulePack.scoring.acceptedPointValues,
    technicalInput: rulePack.scoring.technicalInput,
    gamJeomPointValue: rulePack.scoring.gamJeomPointValue,
    gamJeomRoundLossAt: rulePack.penalties.gamJeom.roundLossAt,
    gamJeomMatchLossAt: rulePack.penalties.gamJeom.matchLossAt,
    pointGap: rulePack.decisions.pointGap,
    roundTie: rulePack.decisions.roundTie,
    tieBreak: rulePack.tieBreak,
    winnerMethods: rulePack.decisions.winnerMethods,
    maximumActiveRemotes: rulePack.voting.maximumActiveRemotes,
    kyeShiLimitSeconds: rulePack.medical.kyeShi.limitSeconds,
    tournamentFormat: rulePack.tournament.format,
    tournamentDivisions: rulePack.tournament.divisions,
    tournamentPlacements: rulePack.tournament.placements
  };
}

async function readUsbRulesFile(fileName) {
  const context = await usbContext({ mountIfNeeded: true });
  const filePath = await selectedUsbFile(context, fileName, {
    allowedExtensions: USB_RULE_ALLOWED_EXTENSIONS,
    maxBytes: rulesConstants.maxBytes,
    extensionMessage: 'ONLY RULE PACK FILES CAN BE IMPORTED'
  });
  return validateRules(parseRulesText((await readBoundedFile(filePath, rulesConstants.maxBytes)).toString('utf8')));
}

app.get('/api/rules/status', requireHostRequest, async (req, res) => {
  try {
    if (!USB_IMPORT_ONLY) {
      res.json({
        ok: true,
        enabled: false,
        activeRuleset: activeRulesMetadata,
        rulesFiles: [],
        message: 'USB RULE IMPORT IS DISABLED'
      });
      return;
    }
    const result = await withUsbOperation(async () => {
      const context = await usbContext({ mountIfNeeded: true });
      return { context, rulesFiles: await usbFiles(context, USB_RULE_ALLOWED_EXTENSIONS) };
    });
    res.json({
      ok: true,
      enabled: true,
      connected: result.context.connected,
      mounted: result.context.mounted,
      rulesFiles: result.rulesFiles,
      activeRuleset: activeRulesMetadata,
      message: result.context.message
    });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message || 'RULE STATUS CHECK FAILED' });
  }
});

app.post('/api/rules/apply', requireHostRequest, express.json({ limit: '8kb', inflate: false }), async (req, res) => {
  if (!USB_IMPORT_ONLY) {
    res.status(404).json({ ok: false, message: 'USB RULE IMPORT IS DISABLED' });
    return;
  }
  if (tournamentMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before applying a ruleset' });
    return;
  }
  try {
    const rulePack = await withRulesOperation(req, async () => {
      if (tournamentMatchIsBusy()) throw new Error('Finish or reset the current match before applying a ruleset');
      const nextRules = await readUsbRulesFile(req.body?.fileName);
      if (!hostRequestAuthorized(req) || tournamentMatchIsBusy()) throw new Error('Match or host session changed; retry the ruleset operation');
      await writeRulesAtomically(nextRules, { backupRules: rules });
      configureRuntimeRules(nextRules);
      state(true);
      return nextRules;
    });
    res.json({
      ok: true,
      ruleset: activeRulesMetadata,
      summary: rulesSummary(rulePack),
      message: 'RULESET APPLIED SUCCESSFULLY'
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'RULESET APPLY FAILED' });
  }
});

app.post('/api/rules/default', requireHostRequest, async (req, res) => {
  if (tournamentMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before loading default rules' });
    return;
  }
  try {
    const rulePack = await withRulesOperation(req, async () => {
      if (tournamentMatchIsBusy()) throw new Error('Finish or reset the current match before loading default rules');
      const defaultRules = await readRulesFile(rulesPaths.default);
      if (!hostRequestAuthorized(req) || tournamentMatchIsBusy()) throw new Error('Match or host session changed; retry the ruleset operation');
      await writeRulesAtomically(defaultRules);
      configureRuntimeRules(defaultRules);
      state(true);
      return defaultRules;
    });
    res.json({
      ok: true,
      ruleset: activeRulesMetadata,
      summary: rulesSummary(rulePack),
      message: 'DEFAULT RULESET LOADED'
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'DEFAULT RULESET LOAD FAILED' });
  }
});

app.get('/api/usb/status', requireHostRequest, async (req, res) => {
  try {
    const result = await withUsbOperation(async () => {
      const context = await usbContext({ mountIfNeeded: true });
      return {
        context,
        files: await usbFiles(context),
        rulesFiles: await usbFiles(context, USB_RULE_ALLOWED_EXTENSIONS)
      };
    });
    res.json({
      ok: true,
      enabled: result.context.enabled,
      connected: result.context.connected,
      mounted: result.context.mounted,
      files: result.files,
      rulesFiles: result.rulesFiles,
      message: result.context.message
    });
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message || 'USB CHECK FAILED' });
  }
});

app.post('/api/usb/import', requireHostRequest, express.json({ limit: '8kb', inflate: false }), async (req, res) => {
  if (!USB_IMPORT_ONLY) {
    res.status(404).json({ ok: false, message: 'USB IMPORT MODE IS DISABLED' });
    return;
  }
  if (tournamentMatchIsBusy() || practiceMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before importing a match file' });
    return;
  }
  try {
    const result = await withUsbOperation(async () => {
      if (!hostRequestAuthorized(req) || tournamentMatchIsBusy() || practiceMatchIsBusy()) throw new Error('Match or host session changed; retry the import');
      const importRules = rules;
      const context = await usbContext();
      const filePath = await selectedUsbFile(context, req.body?.fileName);
      const imported = await importFixture(await readBoundedFile(filePath, MAX_IMPORT_BYTES), req.body?.event);
      if (!hostRequestAuthorized(req) || tournamentMatchIsBusy() || practiceMatchIsBusy() || rules !== importRules) throw new Error('Match, host session or rules changed; retry the import');
      if (req.body?.preview === true) return { ok: true, preview: true, tournament: deep(imported.tournament), workbook: fixtureWorkbookState(imported.workbook, true) };
      commitFixtureImport(imported, req.body?.digest, req.body?.categoryKey);
      state(true);
      return { ok: true, tournament: deep(tournament), workbook: fixtureWorkbookState() };
    });
    res.json(result);
  } catch (error) {
    const details = error instanceof TournamentImportError ? error.errors : [];
    res.status(400).json({ ok: false, message: error.message || 'USB player sheet import failed', errors: details });
  }
});

app.post('/api/usb/template', requireHostRequest, async (req, res) => {
  if (!USB_IMPORT_ONLY) {
    res.status(404).json({ ok: false, message: 'USB IMPORT MODE IS DISABLED' });
    return;
  }
  try {
    const result = await withUsbOperation(async () => {
      const context = await usbContext();
      return writePlayerTemplateToUsb(context);
    });
    res.json({ ok: true, ...result, message: 'PLAYER TEMPLATE SAVED TO USB' });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'COULD NOT SAVE TEMPLATE TO USB' });
  }
});

app.post('/api/usb/unmount', requireHostRequest, async (req, res) => {
  if (!USB_IMPORT_ONLY) {
    res.status(404).json({ ok: false, message: 'USB IMPORT MODE IS DISABLED' });
    return;
  }
  try {
    await withUsbOperation(async () => unmountUsb(await usbContext()));
    res.json({ ok: true, message: 'USB DRIVE UNMOUNTED SAFELY' });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'COULD NOT UNMOUNT USB DRIVE' });
  }
});

app.post('/api/tournament/import', requireHostRequest, express.raw({ type: '*/*', limit: MAX_IMPORT_BYTES, inflate: false }), async (req, res) => {
  if (USB_IMPORT_ONLY) {
    res.status(403).json({ ok: false, message: 'USB IMPORT IS REQUIRED ON THIS DEPLOYMENT' });
    return;
  }
  if (tournamentMatchIsBusy() || practiceMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before importing a match file' });
    return;
  }
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const importRules = rules;
    const imported = await importFixture(buffer, importEventHeader(req));
    if (!hostRequestAuthorized(req) || tournamentMatchIsBusy() || practiceMatchIsBusy() || rules !== importRules) throw new Error('Match, host session or rules changed; retry the import');
    if (req.query.preview === 'true') {
      res.json({ ok: true, preview: true, tournament: imported.tournament, workbook: fixtureWorkbookState(imported.workbook, true) });
      return;
    }
    commitFixtureImport(imported, req.get('X-SFTS-Import-Digest'), req.get('X-SFTS-Import-Category'));
    state(true);
    res.json({ ok: true, tournament: deep(tournament), workbook: fixtureWorkbookState() });
  } catch (error) {
    const details = error instanceof TournamentImportError ? error.errors : [];
    res.status(400).json({ ok: false, message: error.message || 'Player sheet import failed', errors: details });
  }
});

app.get('/api/tournament/template.xlsx', requireHostRequest, (req, res) => {
  res.status(403).json({ ok: false, message: 'SAVE TEMPLATE TO USB from the Event card. Browser template downloads are disabled.' });
});

app.get('/api/tournament/category/:key', requireHostRequest, (req, res) => {
  const selected = importedWorkbook && importedWorkbook.sourceDigest === req.query.workbookId && importedWorkbook.categories.find(item => item.key === req.params.key);
  if (!selected) return res.status(404).json({ ok: false, message: 'This tournament selection changed. Reopen Data Import and select the category again.' });
  res.json({ ok: true, tournament: selected.fixture, workbook: fixtureWorkbookState() });
});

app.post('/api/tournament/category', requireHostRequest, express.json({ limit: '2kb', inflate: false }), (req, res) => {
  if (tournamentMatchIsBusy() || practiceMatchIsBusy()) return res.status(409).json({ ok: false, message: 'Finish or reset the current match before switching categories.' });
  const selected = importedWorkbook && importedWorkbook.sourceDigest === req.body?.workbookId && importedWorkbook.categories.find(item => item.key === req.body?.categoryKey);
  if (!selected) return res.status(404).json({ ok: false, message: 'Select a category from the current tournament file.' });
  const validation = manualCategoryFromInput(selected.fixture.event);
  if (validation.error) return res.status(400).json({ ok: false, message: validation.error });
  importedWorkbook.selectedKey = selected.key;
  tournament = selected.fixture;
  state(true);
  res.json({ ok: true, tournament: deep(tournament), workbook: fixtureWorkbookState() });
});

app.post('/api/tournament/category/delete', requireHostRequest, express.json({ limit: '2kb', inflate: false }), (req, res) => {
  if (tournamentMatchIsBusy() || practiceMatchIsBusy()) return res.status(409).json({ ok: false, message: 'Finish or reset the current match before deleting a category.' });
  const selected = importedWorkbook && importedWorkbook.sourceDigest === req.body?.workbookId
    ? importedWorkbook.categories.find(item => item.key === req.body?.categoryKey)
    : !importedWorkbook && tournament.event && tournament.sourceDigest === req.body?.workbookId && req.body?.categoryKey === 'single' ? { key: 'single', fixture: tournament } : null;
  if (!selected) return res.status(404).json({ ok: false, message: 'This category is no longer available. Reopen Data Import and select it again.' });
  if (selected.fixture.categoryId) {
    const result = deleteManualCategory(selected.fixture.categoryId, {
      deleteRecords: req.body?.deleteRecords === true, confirmation: req.body?.confirmation, allowFinishedMatch: true
    });
    if (!result.ok) return res.status(400).json({ ...result, message: result.message });
  } else removeImportedCategoryFixtures(null, selected.key);
  state(true);
  res.json({ ok: true, tournament: deep(tournament), workbook: fixtureWorkbookState(), message: 'CATEGORY AND ITS SAVED MATCHES DELETED' });
});

app.get('/api/tournament/schedule.xlsx', requireHostRequest, async (req, res, next) => {
  try {
  const output = Buffer.from(await scheduleWorkbook());
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.attachment('sfts-tournament-schedule.xlsx');
  res.send(output);
  } catch (error) { next(error); }
});

app.get('/api/tournament/schedule.csv', requireHostRequest, async (req, res, next) => {
  try {
  const output = await scheduleWorkbook('csv');
  res.type('text/csv');
  res.attachment('sfts-tournament-schedule.csv');
  res.send(output);
  } catch (error) { next(error); }
});

app.get('/api/manual/categories', requireHostRequest, (req, res) => {
  const categoryId = String(req.query.categoryId || '').trim();
  if (categoryId && !manualCompetition.categories.some(category => category.id === categoryId)) {
    res.status(404).json({ ok: false, message: 'Manual category not found' });
    return;
  }
  res.json({
    ok: true,
    manualCompetition: deep(manualCompetition),
    records: deep(categoryId
      ? manualMatchRecords.filter(record => record.manualBout?.categoryId === categoryId)
      : [])
  });
});

app.post('/api/manual/categories/pdf-usb', requireHostRequest, express.json({ limit: '8kb', inflate: false }), async (req, res) => {
  if (!USB_IMPORT_ONLY) {
    res.status(403).json({ ok: false, message: 'USB PDF EXPORT IS DISABLED ON THIS DEPLOYMENT' });
    return;
  }
  const categoryId = String(req.body?.categoryId || '').trim();
  const category = manualCompetition.categories.find(item => item.id === categoryId);
  if (!category) {
    res.status(404).json({ ok: false, message: 'Manual category not found' });
    return;
  }
  const options = {
    includeBoutSummary: req.body?.includeBoutSummary !== false,
    includeFullAudit: req.body?.includeFullAudit === true,
    includeCornerRefereeHistory: req.body?.includeFullAudit === true && req.body?.includeCornerRefereeHistory === true
  };
  try {
    const result = await withUsbOperation(async () => {
      const context = await usbContext({ mountIfNeeded: true });
      if (!context.mounted) throw new Error(context.message || 'USB DRIVE IS NOT MOUNTED');
      const records = manualMatchRecords.filter(record => record.manualBout?.categoryId === category.id);
      return writeManualCategoryPdfToUsb(context, deep(category), deep(records), options);
    });
    res.json({ ok: true, ...result, message: `CATEGORY RESULT SAVED TO USB: ${result.fileName}` });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || 'COULD NOT SAVE CATEGORY RESULT TO USB' });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.too.large' ? 413
    : error.type === 'encoding.unsupported' ? 415
    : error.type === 'entity.parse.failed' ? 400 : 503;
  res.status(status).json({ ok: false, message: status === 413 ? 'Request body is too large'
    : status === 415 ? 'Compressed request bodies are not supported'
    : status === 400 ? 'Invalid JSON request' : 'File operation unavailable; retry shortly' });
});

function validPlayer(player) {
  return player === 'RED' || player === 'BLUE';
}

function validPoints(points) {
  return Number.isInteger(points) && rules.scoring.basePointValues.includes(points);
}

function technicalPointsFor(basePoints) {
  if (!rules.scoring.technicalInput.enabled ||
      !rules.scoring.technicalInput.eligibleBasePoints.includes(basePoints)) return null;
  const points = rules.scoring.technicalInput.pointsByBasePoints[String(basePoints)];
  return Number.isInteger(points) ? points : null;
}

function validInteger(value) {
  return Number.isSafeInteger(value);
}

function normalizeArenaNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= 999
    ? String(number)
    : '';
}

function validRemoteSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

function normalizeRssi(value) {
  if (value === null || value === undefined || value === '') return null;
  const rssi = Number(value);
  return Number.isInteger(rssi) && rssi >= -127 && rssi <= 0 ? rssi : null;
}

function normalizeBattery(value) {
  if (value === null || value === undefined || value === '') return null;
  const battery = Number(value);
  return Number.isFinite(battery) && battery >= 0 && battery <= 100 ? Math.round(battery) : null;
}

function normalizeRemoteCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}

function clearRemoteCombination(corner) {
  remoteTestTracker.clear(corner);
  const pending = remoteTechnicalPending.get(corner);
  if (pending?.timer) clearTimeout(pending.timer);
  remoteTechnicalPending.delete(corner);
  remoteLastBasePress.delete(corner);
}

function clearAllRemoteCombinations() {
  remoteTestTracker.reset();
  for (const corner of new Set([...remoteTechnicalPending.keys(), ...remoteLastBasePress.keys()])) {
    clearRemoteCombination(corner);
  }
}

function clearLastRemoteButtons() {
  for (const timer of lastRemoteButtonTimers.values()) clearTimeout(timer);
  lastRemoteButtonTimers.clear();
  lastRemoteButtons.clear();
}

function clearRemoteScoreHighlights() {
  remoteScoreHighlights.RED = [];
  remoteScoreHighlights.BLUE = [];
  remoteScoreValues.RED = null;
  remoteScoreValues.BLUE = null;
  remoteScoreRevisions.RED += 1;
  remoteScoreRevisions.BLUE += 1;
}

function cornerRefereeButtonLabel(player, points, technical = false) {
  const body = { 1: 'FIST', 2: 'CHEST', 3: 'HEAD' }[Number(points)];
  if (!body) return `${player}-UNKNOWN`;
  return `${player}-${technical ? 'TECHNICAL-' : ''}${body}`;
}

function cornerRefereeDisplayName(corner, button) {
  const side = /^(RED|BLUE)(?:-|_)/.exec(String(button || ''))?.[1];
  return `C${corner}${side ? `-${side}` : ''}`;
}

function recordCornerRefereePress(corner, button, score = null) {
  if (match.phase !== 'ROUND' || !match.roundStarted || match.test.active) return false;
  const entry = {
    id: `${match.matchNo}-${match.cornerRefereeHistory.length + 1}`,
    matchNo: match.matchNo,
    arenaNumber,
    round: match.round,
    timerMs: Math.max(0, Math.ceil(match.timerMs)),
    corner,
    cornerReferee: cornerRefereeDisplayName(corner, button),
    button,
    score,
    pressedAt: new Date().toISOString()
  };
  match.cornerRefereeHistory.push(entry);
  return entry;
}

function recordOperatorAction(action, player, from, to, details = null) {
  match.operatorHistory.push({
    id: `${match.matchNo}-operator-${match.operatorHistory.length + 1}`,
    matchNo: match.matchNo,
    arenaNumber,
    round: match.round,
    timerMs: Math.max(0, Math.ceil(match.timerMs)),
    action,
    player,
    from,
    to,
    ...(details ? { details: deep(details) } : {}),
    recordedAt: new Date().toISOString()
  });
}

function recordOperatorCorrection(action, player, from, to, details = null) {
  recordOperatorAction(action, player, from, to, details);
}

function replaceCornerRefereeHistoryEntry(entry, button, score) {
  if (!entry) return;
  entry.button = button;
  entry.score = score;
  entry.pressedAt = new Date().toISOString();
}

function showRemoteScoreHighlight(player, corners, points) {
  if (match.phase === 'MATCH_END') return;
  remoteScoreHighlights[player] = [...corners];
  remoteScoreValues[player] = points;
  remoteScoreRevisions[player] += 1;
}

function showLastRemoteButton(corner, button) {
  const previousTimer = lastRemoteButtonTimers.get(corner);
  if (previousTimer) clearTimeout(previousTimer);
  lastRemoteButtons.set(corner, button);
  const timer = setTimeout(() => {
    if (lastRemoteButtonTimers.get(corner) !== timer) return;
    lastRemoteButtonTimers.delete(corner);
    lastRemoteButtons.delete(corner);
    // This is transient display state and does not belong in the durable match snapshot.
    state();
  }, REMOTE_BUTTON_DISPLAY_MS);
  timer.unref?.();
  lastRemoteButtonTimers.set(corner, timer);
}

function rememberTechnicalPress(corner, player) {
  clearRemoteCombination(corner);
  const pending = { player, expiresAt: Date.now() + TECHNICAL_COMBO_WINDOW_MS };
  pending.timer = setTimeout(() => {
    if (remoteTechnicalPending.get(corner) === pending) remoteTechnicalPending.delete(corner);
  }, TECHNICAL_COMBO_WINDOW_MS);
  pending.timer.unref?.();
  remoteTechnicalPending.set(corner, pending);
}

function rememberBasePress(corner, vote, historyEntry) {
  const previous = remoteLastBasePress.get(corner);
  if (previous?.timer) clearTimeout(previous.timer);
  const pending = { player: vote.player, points: vote.points, timestamp: Date.now(), historyEntry };
  pending.timer = setTimeout(() => {
    if (remoteLastBasePress.get(corner) === pending) remoteLastBasePress.delete(corner);
  }, TECHNICAL_COMBO_WINDOW_MS);
  pending.timer.unref?.();
  remoteLastBasePress.set(corner, pending);
}

function updateRemoteStatus(ws, fields = {}, broadcast = true) {
  const status = remoteStatuses.get(ws.deviceId);
  if (!status) return;
  let changed = !status.connected;
  const update = (field, value) => {
    if (status[field] !== value) changed = true;
    status[field] = value;
  };
  status.connected = true;
  status.lastSeenAt = Date.now();
  if (ws.remoteSession) ws.remoteSession.lastSeenAt = status.lastSeenAt;
  if (Object.prototype.hasOwnProperty.call(fields, 'rssi')) update('rssi', normalizeRssi(fields.rssi));
  if (Object.prototype.hasOwnProperty.call(fields, 'battery')) update('battery', normalizeBattery(fields.battery));
  for (const field of ['outboxDepth', 'droppedInputs', 'droppedEvents', 'retryCount', 'reconnectCount', 'lastAckSequence']) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) update(field, normalizeRemoteCounter(fields[field]));
  }
  if (broadcast && changed) state();
}

function handleRemoteStatus(ws, msg) {
  if (ws.role !== 'remote' || !ws.remoteSession || remoteSockets.get(ws.deviceId) !== ws) {
    sendError(ws, 'REMOTE_NOT_AUTHENTICATED', 'Send remote_hello before remote_status');
    return;
  }
  const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.toUpperCase() : '';
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  if (deviceId !== ws.deviceId || sessionId !== ws.sessionId) {
    sendError(ws, 'REMOTE_ID_MISMATCH', 'Status identity does not match the connected remote');
    return;
  }
  const hasRssi = Object.prototype.hasOwnProperty.call(msg, 'rssi');
  const hasBattery = Object.prototype.hasOwnProperty.call(msg, 'battery');
  const rssi = normalizeRssi(msg.rssi);
  const battery = normalizeBattery(msg.battery);
  if ((!hasRssi && !hasBattery) || (hasRssi && msg.rssi !== null && rssi === null) ||
      (hasBattery && msg.battery !== null && battery === null)) {
    sendError(ws, 'INVALID_TELEMETRY', 'RSSI must be an integer from -127 to 0 and battery must be 0 to 100');
    return;
  }
  const telemetry = {};
  if (hasRssi) telemetry.rssi = rssi;
  if (hasBattery) telemetry.battery = battery;
  for (const field of ['outboxDepth', 'droppedInputs', 'droppedEvents', 'retryCount', 'reconnectCount', 'lastAckSequence']) {
    if (!Object.prototype.hasOwnProperty.call(msg, field)) continue;
    const value = normalizeRemoteCounter(msg[field]);
    if (value === null) {
      sendError(ws, 'INVALID_TELEMETRY', `${field} must be a non-negative counter`);
      return;
    }
    telemetry[field] = value;
  }
  updateRemoteStatus(ws, telemetry);
  send(ws, { type: 'remote_status_ack', deviceId: ws.deviceId, sessionId: ws.sessionId, accepted: true });
}

function remoteButton(button) {
  const combined = /^((?:RED|BLUE))_TECHNICAL_([23])$/.exec(String(button || '').toUpperCase());
  if (combined) {
    const basePoints = Number(combined[2]);
    const points = technicalPointsFor(basePoints);
    if (points === null) return null;
    return { player: combined[1], points, basePoints, technical: true, combined: true, button: `${combined[1]}_TECHNICAL_${basePoints}` };
  }
  const matchButton = /^((?:RED|BLUE))_(TECHNICAL|\d+)$/.exec(String(button || '').toUpperCase());
  if (!matchButton) return null;
  if (matchButton[2] === 'TECHNICAL') {
    if (!rules.scoring.technicalInput.enabled) return null;
    return { player: matchButton[1], points: null, technical: true, button: `${matchButton[1]}_TECHNICAL` };
  }
  const points = Number(matchButton[2]);
  if (!validPoints(points)) return null;
  return { player: matchButton[1], points, technical: false, button: `${matchButton[1]}_${points}` };
}

function expectedRemoteToken(deviceId) {
  // Environment variables remain available as a development/deployment
  // override, while the local JSON configuration removes event-day shell
  // setup.
  const environmentToken = String(process.env[`SFTS_REMOTE_TOKEN_${deviceId}`] || '').trim();
  if (environmentToken) return environmentToken;
  const configuredToken = String(configuredRemoteTokens[deviceId] || '').trim();
  return configuredToken || null;
}

function rememberRemoteAck(session, sequence, ack) {
  session.acks.set(sequence, ack);
  while (session.acks.size > REMOTE_ACK_CACHE_SIZE) {
    session.acks.delete(session.acks.keys().next().value);
  }
}

function remoteAck(ws, sequence, details) {
  const ack = {
    type: 'remote_event_ack',
    deviceId: ws.deviceId,
    sessionId: ws.sessionId,
    sequence,
    ...details
  };
  send(ws, ack);
  const status = remoteStatuses.get(ws.deviceId);
  if (status) {
    status.lastEventReason = details.reason || null;
    status.lastEventSequence = sequence;
  }
  if (details.accepted === false) {
    emit({ type: 'remoteRejected', corner: ws.corner, sequence, reason: details.reason });
  }
  return ack;
}

function scoringIsAllowed() {
  return operatorScoringIsAllowed() && match.running;
}

function operatorScoringIsAllowed() {
  return match.phase === 'ROUND' && match.roundStarted && !match.test.active && !match.kyeShi.active;
}

function syncKyeShi(now = performance.now()) {
  if (!match.kyeShi.active || !match.kyeShi.running || kyeShiLastAt === null) return false;
  const elapsed = Math.max(0, now - kyeShiLastAt);
  if (!elapsed) return false;

  kyeShiLastAt = now;
  match.kyeShi.elapsedMs += elapsed;
  if (match.kyeShi.elapsedMs < match.kyeShi.limitMs) return true;

  match.kyeShi.elapsedMs = match.kyeShi.limitMs;
  match.kyeShi.running = false;
  match.kyeShi.limitReached = true;
  kyeShiLastAt = null;
  emit({ type: 'kyeShiLimit' });
  state(true);
  return true;
}

function syncTimer(now = performance.now()) {
  const kyeShiChanged = syncKyeShi(now);
  if (!match.running || timerLastAt === null) return kyeShiChanged;
  const elapsed = Math.max(0, now - timerLastAt);
  if (!elapsed) return kyeShiChanged;

  timerLastAt = now;
  match.timerMs -= elapsed;
  if (match.timerMs > 0) return true;

  match.timerMs = 0;
  match.running = false;
  timerLastAt = null;
  if (match.phase === 'ROUND') endRound(null, 'TIME 0:00');
  else if (match.phase === 'BREAK') startNextRound();
  return true;
}

function setRunning(running) {
  if (running === match.running) return;
  if (!running) {
    const phaseBeforeSync = match.phase;
    syncTimer();
    if (match.phase !== phaseBeforeSync) return;
    if (!match.running) return;
    match.running = false;
    timerLastAt = null;
    // A pause must not preserve a vote that was started before the pause.
    // Otherwise a later press after PLAY could complete an old combination.
    match.votes = {};
    clearAllRemoteCombinations();
    return;
  }
  if (match.timerMs <= 0) return;
  match.running = true;
  if (match.phase === 'ROUND') {
    match.roundStarted = true;
    match.startedAt ||= new Date().toISOString();
  }
  timerLastAt = performance.now();
}

function startKyeShi() {
  syncTimer();
  if (!rules.medical.kyeShi.enabled || match.phase !== 'ROUND' || match.test.active || match.kyeShi.active || !match.roundStarted) {
    return { ok: false, code: 'KYESHI_NOT_AVAILABLE', message: 'Kye-shi can only start during an active round' };
  }
  const resumeMatch = match.running;
  setRunning(false);
  if (match.phase !== 'ROUND') {
    return { ok: false, code: 'ROUND_NOT_ACTIVE', message: 'The round has already ended' };
  }
  match.kyeShi = makeKyeShi();
  match.kyeShi.active = true;
  match.kyeShi.running = true;
  match.kyeShi.resumeMatch = resumeMatch;
  kyeShiLastAt = performance.now();
  match.votes = {};
  clearAllRemoteCombinations();
  return { ok: true };
}

function pauseKyeShi() {
  syncTimer();
  if (!match.kyeShi.active || !match.kyeShi.running) {
    return { ok: false, code: 'KYESHI_NOT_RUNNING', message: 'Kye-shi is not running' };
  }
  match.kyeShi.running = false;
  kyeShiLastAt = null;
  return { ok: true };
}

function resumeKyeShi() {
  syncTimer();
  if (!match.kyeShi.active || match.kyeShi.running) {
    return { ok: false, code: 'KYESHI_NOT_PAUSED', message: 'Kye-shi is not paused' };
  }
  if (match.kyeShi.limitReached) {
    return { ok: false, code: 'KYESHI_LIMIT_REACHED', message: 'End Kye-shi or declare the match winner' };
  }
  match.kyeShi.running = true;
  kyeShiLastAt = performance.now();
  return { ok: true };
}

function endKyeShi() {
  syncTimer();
  if (!match.kyeShi.active) {
    return { ok: false, code: 'KYESHI_NOT_ACTIVE', message: 'Kye-shi is not active' };
  }
  const resumeMatch = match.kyeShi.resumeMatch;
  match.kyeShi = makeKyeShi();
  kyeShiLastAt = null;
  if (resumeMatch && match.phase === 'ROUND' && match.timerMs > 0) setRunning(true);
  return { ok: true };
}

function declareKyeShiWinner(winner) {
  syncTimer();
  if (!validPlayer(winner)) {
    return { ok: false, code: 'INVALID_WINNER', message: 'Winner must be RED or BLUE' };
  }
  if (match.phase !== 'ROUND' || !match.kyeShi.active || !match.kyeShi.limitReached) {
    return { ok: false, code: 'KYESHI_DECISION_UNAVAILABLE', message: 'A winner can be declared only after the Kye-shi limit' };
  }

  const record = {
    round: match.round,
    winner,
    reason: 'KYE-SHI DECISION',
    red: deep(match.red),
    blue: deep(match.blue)
  };
  match.running = false;
  timerLastAt = null;
  match.timerMs = 0;
  match.roundHistory.push(record);
  match.votes = {};
  clearAllRemoteCombinations();
  match.kyeShi = makeKyeShi();
  kyeShiLastAt = null;
  finishMatch(winner, 'KYE-SHI DECISION');
  return { ok: true };
}

function releaseRole(ws) {
  if (hostSocket === ws) hostSocket = null;
  if (ws.role === 'referee' && refereeSockets.get(ws.corner) === ws) {
    refereeSockets.delete(ws.corner);
    if (match.votes[ws.corner]) {
      delete match.votes[ws.corner];
      state(true);
    }
  }
  if (ws.role === 'remote' && remoteSockets.get(ws.deviceId) === ws) {
    remoteSockets.delete(ws.deviceId);
    clearRemoteCombination(ws.corner);
    const status = remoteStatuses.get(ws.deviceId);
    if (status) {
      status.connected = false;
      status.lastSeenAt = Date.now();
    }
    if (match.votes[ws.corner]) {
      delete match.votes[ws.corner];
      state(true);
    } else {
      state();
    }
  }
  ws.role = 'unknown';
  ws.corner = 0;
  ws.deviceId = null;
  ws.sessionId = null;
  ws.remoteSession = null;
  ws.hostToken = null;
}

function tokenMatches(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isTrustedKioskOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  try {
    return new URL(origin).origin === KIOSK_ORIGIN;
  } catch {
    return false;
  }
}

function assignRole(ws, role, corner, accessToken, kioskAuthorized = false) {
  if (role === 'host') {
    if (!kioskAuthorized && !tokenMatches(accessToken, hostAccessToken)) {
      sendError(ws, 'HOST_UNAUTHORIZED', 'A valid host access token is required');
      return false;
    }
    if (hostSocket && hostSocket !== ws && hostSocket.readyState === 1) {
      sendError(ws, 'HOST_BUSY', 'Another host is already connected');
      return false;
    }
    releaseRole(ws);
    hostSocket = ws;
    ws.role = 'host';
    clearTimeout(ws.authTimer);
    ws.corner = 0;
    ws.hostToken = crypto.randomBytes(24).toString('hex');
    send(ws, { type: 'roleAccepted', role: 'host', hostToken: ws.hostToken });
    send(ws, fullState());
    return true;
  }

  if (role !== 'referee' || !Number.isInteger(corner) || corner < 1 || corner > 4) {
    sendError(ws, 'INVALID_ROLE', 'Choose a valid host or referee corner');
    return false;
  }
  const refereeToken = process.env[`SFTS_REFEREE_TOKEN_C${corner}`] || hostAccessToken;
  if (!tokenMatches(accessToken, refereeToken)) {
    sendError(ws, 'REFEREE_UNAUTHORIZED', `A valid access token is required for corner C${corner}`);
    return false;
  }
  const existing = refereeSockets.get(corner);
  if (existing && existing !== ws && existing.readyState === 1) {
    sendError(ws, 'CORNER_BUSY', `Corner C${corner} is already connected`);
    return false;
  }
  releaseRole(ws);
  refereeSockets.set(corner, ws);
  ws.role = 'referee';
  clearTimeout(ws.authTimer);
  ws.corner = corner;
  send(ws, { type: 'roleAccepted', role: 'referee', corner });
  send(ws, fullState());
  return true;
}

function side(player) { return player === "RED" ? match.red : match.blue; }
function other(player) { return player === "RED" ? "BLUE" : "RED"; }

function addHitStat(player, points) {
  const stats = side(player).stats;
  if (points === 1) stats.plus1 += 1;
  if (points === 2) stats.plus2 += 1;
  if (points === 3) stats.plus3 += 1;
}

function addTechnicalStat(player, basePoints) {
  const stats = side(player).stats;
  if (basePoints === 2) stats.technicalChest += 1;
  if (basePoints === 3) stats.technicalHead += 1;
}

function isGoldenRound() {
  return match.phase === 'ROUND' && match.round === rules.match.rounds + 1 && match.goldenRound?.active === true;
}

function roundRecord(winner, reason) {
  return {
    round: match.round,
    winner,
    reason,
    goldenRound: isGoldenRound(),
    red: deep(match.red),
    blue: deep(match.blue)
  };
}

function checkPointGap() {
  if (match.phase !== "ROUND") return;
  if (isGoldenRound()) {
    const scoreToWin = rules.tieBreak.goldenRound.scoreToWin;
    if (match.red.score >= scoreToWin) {
      endGoldenRound('RED', `GDP - ${scoreToWin} POINTS`);
    } else if (match.blue.score >= scoreToWin) {
      endGoldenRound('BLUE', `GDP - ${scoreToWin} POINTS`);
    }
    return;
  }
  if (!rules.decisions.pointGap.enabled || !rules.decisions.pointGap.appliesToRounds.includes(match.round)) return;
  const diff = Math.abs(match.red.score - match.blue.score);
  if (diff >= rules.decisions.pointGap.difference) {
    const winner = match.red.score > match.blue.score ? "RED" : "BLUE";
    endRound(winner, `PTG - ${rules.decisions.pointGap.difference}-POINT GAP`);
  }
}

function addPoint(player, points, source = "manual", countAsHit = true, allowPaused = false, basePoints = points) {
  const technicalAward = source === 'referee-technical' && rules.scoring.technicalInput.enabled &&
    Object.values(rules.scoring.technicalInput.pointsByBasePoints).includes(points);
  const canScore = allowPaused ? operatorScoringIsAllowed() : scoringIsAllowed();
  if (!validPlayer(player) || (!validPoints(points) && !technicalAward) || !canScore) return false;
  side(player).score += points;
  if (countAsHit) addHitStat(player, points);
  // Queue sound after the authoritative score state has been broadcast. This keeps
  // a slow first-time browser audio initialization off the visible score path.
  queueMicrotask(() => emit({ type: 'scoreSound', player, points, basePoints, source }));
  checkPointGap();
  return true;
}

function addTechnicalPoint(player, basePoints) {
  const points = technicalPointsFor(basePoints);
  if (!validPlayer(player)) {
    return { ok: false, code: 'INVALID_PLAYER', message: 'Technical points require a valid player' };
  }
  if (points === null) {
    return { ok: false, code: 'INVALID_TECHNICAL_POINT', message: 'Technical scoring requires an eligible chest or head point' };
  }
  if (!operatorScoringIsAllowed()) {
    return { ok: false, code: 'ROUND_NOT_ACTIVE', message: 'Technical points can only be awarded during a round' };
  }

  const previous = side(player).score;
  side(player).score += points;
  addTechnicalStat(player, basePoints);
  recordOperatorAction(`TECHNICAL ${basePoints === 2 ? 'CHEST' : 'HEAD'} KICK`, player, previous, side(player).score);
  queueMicrotask(() => emit({ type: 'scoreSound', player, points, basePoints, source: 'referee-technical' }));
  checkPointGap();
  return { ok: true, points, basePoints, technical: true };
}

function editRoundTieStats(player, input) {
  if (!validPlayer(player) || !operatorScoringIsAllowed()) {
    return { ok: false, code: 'ROUND_NOT_ACTIVE', message: 'Kick counts can only be edited before the active round timer expires' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_KICK_COUNTS', message: 'Kick counts are required' };
  }
  const next = {
    technicalHead: Number(input.technicalHead),
    technicalChest: Number(input.technicalChest),
    plus3: Number(input.normalHead)
  };
  if (Object.values(next).some(value => !Number.isSafeInteger(value) || value < 0)) {
    return { ok: false, code: 'INVALID_KICK_COUNTS', message: 'Kick counts must be non-negative whole numbers' };
  }

  const stats = side(player).stats;
  const labels = {
    technicalHead: 'TECHNICAL HEAD KICKS EDIT',
    technicalChest: 'TECHNICAL CHEST KICKS EDIT',
    plus3: 'NORMAL HEAD KICKS EDIT'
  };
  for (const key of Object.keys(next)) {
    if (stats[key] !== next[key]) recordOperatorCorrection(labels[key], player, stats[key], next[key]);
    stats[key] = next[key];
  }
  return { ok: true };
}

function scoringCorrectionDefinition(actionKey) {
  const normal = /^NORMAL_([123])$/.exec(actionKey);
  if (normal) {
    const basePoints = Number(normal[1]);
    if (!rules.scoring.basePointValues.includes(basePoints)) return null;
    return {
      actionKey,
      basePoints,
      points: basePoints,
      statKey: `plus${basePoints}`,
      label: String(rules.scoring.basePointLabels[String(basePoints)] || `${basePoints} POINT`).toUpperCase(),
      technical: false
    };
  }

  const technical = /^TECHNICAL_([23])$/.exec(actionKey);
  if (!technical) return null;
  const basePoints = Number(technical[1]);
  const points = technicalPointsFor(basePoints);
  if (points === null) return null;
  return {
    actionKey,
    basePoints,
    points,
    statKey: basePoints === 2 ? 'technicalChest' : 'technicalHead',
    label: `TECHNICAL ${String(rules.scoring.basePointLabels[String(basePoints)] || `${basePoints} POINT`).toUpperCase()}`,
    technical: true
  };
}

function correctScoringAction(player, direction, actionKey) {
  if (!validPlayer(player) || !operatorScoringIsAllowed()) {
    return { ok: false, code: 'ROUND_NOT_ACTIVE', message: 'Scoring actions can only be corrected during an active round' };
  }
  if (!['ADD', 'REMOVE'].includes(direction)) {
    return { ok: false, code: 'INVALID_CORRECTION', message: 'Correction direction must be ADD or REMOVE' };
  }
  const definition = scoringCorrectionDefinition(actionKey);
  if (!definition) {
    return { ok: false, code: 'INVALID_SCORING_ACTION', message: 'The scoring action is not available in the active rule pack' };
  }

  const correctedSide = side(player);
  const multiplier = direction === 'ADD' ? 1 : -1;
  const previousScore = correctedSide.score;
  const previousCount = Number(correctedSide.stats[definition.statKey] || 0);
  if (direction === 'REMOVE' && previousCount <= 0) {
    return { ok: false, code: 'NO_SCORING_ACTION', message: `No recorded ${definition.label} action can be removed` };
  }
  if (direction === 'REMOVE' && previousScore < definition.points) {
    return { ok: false, code: 'SCORE_TOO_LOW', message: 'The score is too low to remove that scoring action' };
  }

  correctedSide.score += multiplier * definition.points;
  correctedSide.stats[definition.statKey] = previousCount + multiplier;
  recordOperatorCorrection(
    `${direction === 'ADD' ? 'ADD MISSED' : 'REMOVE WRONG'} ${definition.label}`,
    player,
    previousScore,
    correctedSide.score,
    {
      type: 'SCORING_ACTION_CORRECTION',
      direction,
      actionKey: definition.actionKey,
      basePoints: definition.basePoints,
      awardedPoints: definition.points,
      technical: definition.technical,
      stat: definition.statKey,
      statFrom: previousCount,
      statTo: correctedSide.stats[definition.statKey]
    }
  );
  checkPointGap();
  return { ok: true };
}

function checkGamjeomConsequences(player) {
  const penalized = side(player);
  const opponent = other(player);
  if (isGoldenRound() && penalized.gamjeom >= rules.tieBreak.goldenRound.opponentGamJeomsToWin) {
    endGoldenRound(opponent, `GDP - ${rules.tieBreak.goldenRound.opponentGamJeomsToWin} GAM-JEOMS`);
    return;
  }
  if (rules.penalties.gamJeom.matchLossAt !== null &&
      totalGamJeomsFor(player, { includeCurrentRound: true }) >= rules.penalties.gamJeom.matchLossAt) {
    finishMatch(opponent, `PUN - ${rules.penalties.gamJeom.matchLossAt} TOTAL GAM-JEOMS`);
    return;
  }
  if (penalized.gamjeom >= rules.penalties.gamJeom.roundLossAt) {
    endRound(opponent, `ROUND GAM-JEOM LIMIT - ${rules.penalties.gamJeom.roundLossAt} GAM-JEOM`);
    return;
  }
  checkPointGap();
}

function correctGamjeom(player, direction) {
  if (!validPlayer(player) || !operatorScoringIsAllowed()) {
    return { ok: false, code: 'ROUND_NOT_ACTIVE', message: 'Gam-jeom can only be corrected during an active round' };
  }
  if (!['ADD', 'REMOVE'].includes(direction)) {
    return { ok: false, code: 'INVALID_CORRECTION', message: 'Correction direction must be ADD or REMOVE' };
  }
  const penalized = side(player);
  const opponentPlayer = other(player);
  const opponentSide = side(opponentPlayer);
  const multiplier = direction === 'ADD' ? 1 : -1;
  const scoreEffect = rules.penalties.gamJeom.awardsPointToOpponent
    ? rules.scoring.gamJeomPointValue
    : 0;
  if (direction === 'REMOVE' && penalized.gamjeom <= 0) {
    return { ok: false, code: 'NO_GAMJEOM', message: 'No recorded Gam-jeom can be removed' };
  }
  if (direction === 'REMOVE' && opponentSide.score < scoreEffect) {
    return { ok: false, code: 'SCORE_TOO_LOW', message: 'The opponent score is too low to remove that Gam-jeom' };
  }

  const previousCount = penalized.gamjeom;
  const previousOpponentScore = opponentSide.score;
  penalized.gamjeom += multiplier;
  opponentSide.score += multiplier * scoreEffect;
  recordOperatorCorrection(
    `${direction === 'ADD' ? 'ADD MISSED' : 'REMOVE WRONG'} GAM-JEOM`,
    player,
    previousCount,
    penalized.gamjeom,
    {
      type: 'GAMJEOM_CORRECTION',
      direction,
      opponent: opponentPlayer,
      opponentScoreFrom: previousOpponentScore,
      opponentScoreTo: opponentSide.score,
      opponentPointValue: scoreEffect
    }
  );
  if (direction === 'ADD') checkGamjeomConsequences(player);
  return { ok: true };
}

function advancedScoreCorrection(player, inputValue, inputReason) {
  if (!validPlayer(player) || !operatorScoringIsAllowed()) {
    return { ok: false, code: 'ROUND_NOT_ACTIVE', message: 'Scores can only be corrected during an active round' };
  }
  const value = Number(inputValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, code: 'INVALID_SCORE', message: 'The new score must be a non-negative whole number' };
  }
  const reason = String(inputReason || '').trim().slice(0, 240);
  if (!reason) {
    return { ok: false, code: 'CORRECTION_REASON_REQUIRED', message: 'A written reason is required for a score-only correction' };
  }
  const correctedSide = side(player);
  const previous = correctedSide.score;
  if (value === previous) {
    return { ok: false, code: 'SCORE_UNCHANGED', message: 'The corrected score must differ from the current score' };
  }
  correctedSide.score = value;
  recordOperatorCorrection(
    'ADVANCED SCORE-ONLY ADJUSTMENT',
    player,
    previous,
    value,
    {
      type: 'ADVANCED_SCORE_CORRECTION',
      reason,
      scoreOnly: true
    }
  );
  checkPointGap();
  return { ok: true };
}

function addGamjeom(player, allowPaused = false) {
  const canScore = allowPaused ? operatorScoringIsAllowed() : scoringIsAllowed();
  if (!validPlayer(player) || !canScore) return false;
  const penalized = side(player);
  penalized.gamjeom += 1;
  const opponent = other(player);
  if (rules.scoring.gamJeomPointValue > 0 && rules.penalties.gamJeom.awardsPointToOpponent) {
    side(opponent).score += rules.scoring.gamJeomPointValue;
    queueMicrotask(() => emit({
      type: 'scoreSound',
      player: opponent,
      points: rules.scoring.gamJeomPointValue,
      source: 'gamjeom'
    }));
  }
  checkGamjeomConsequences(player);
  return true;
}

function winnerByScore() {
  if (match.red.score > match.blue.score) return 'RED';
  if (match.blue.score > match.red.score) return 'BLUE';
  return null;
}

function countRoundWins() {
  const wins = { RED: 0, BLUE: 0 };
  for (const r of match.roundHistory) {
    if (r.round > rules.match.rounds) continue;
    if (r.winner === 'RED') wins.RED += 1;
    if (r.winner === 'BLUE') wins.BLUE += 1;
  }
  return wins;
}

function hitCount(record, player) {
  const stats = record[player.toLowerCase()]?.stats || {};
  return Number(stats.plus1 || 0) + Number(stats.plus2 || 0) + Number(stats.plus3 || 0) +
    Number(stats.technicalChest || 0) + Number(stats.technicalHead || 0);
}

function totalGamJeoms() {
  return match.roundHistory.reduce((total, record) => ({
    RED: total.RED + Number(record.red?.gamjeom || 0),
    BLUE: total.BLUE + Number(record.blue?.gamjeom || 0)
  }), { RED: 0, BLUE: 0 });
}

function totalGamJeomsFor(player, { includeCurrentRound = false } = {}) {
  const historical = match.roundHistory.reduce(
    (total, record) => total + Number(record[player.toLowerCase()]?.gamjeom || 0),
    0
  );
  return historical + (includeCurrentRound ? Number(side(player).gamjeom || 0) : 0);
}

function beginTieDecision(mode) {
  match.running = false;
  match.phase = 'TIE_DECISION';
  match.timerMs = 0;
  timerLastAt = null;
  match.votes = {};
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearVoteSettleGuard();
  match.tieDecision = { pending: true, mode, options: tieDecisionOptions(mode), round: match.round };
  state(true);
}

function startGoldenRoundBreak() {
  if (!configuredTieOptions().includes('GOLDEN_ROUND')) {
    return { ok: false, code: 'GOLDEN_ROUND_DISABLED', message: 'Golden Round is disabled by the active rule pack' };
  }
  if (match.phase !== 'TIE_DECISION' || match.tieDecision?.mode !== 'CHOOSE_METHOD') {
    return { ok: false, code: 'GOLDEN_ROUND_UNAVAILABLE', message: `Golden Round is available only for a tied match after Round ${rules.match.rounds}` };
  }
  match.tieDecision = makeTieDecision();
  match.breakTarget = 'GOLDEN';
  match.breakMs = breakDurationForRound(match.configuredRoundMs);
  match.phase = 'BREAK';
  match.timerMs = match.breakMs;
  setRunning(true);
  return { ok: true };
}

function goldenRoundSuperiority(record) {
  for (const criterion of rules.tieBreak.goldenRound.superiorityCriteria) {
    if (criterion === 'REFEREE_DECISION') return null;
    if (criterion === 'GOLDEN_ROUND_PUNCH') {
      const redPunch = Number(record.red?.stats?.plus1 || 0) > 0;
      const bluePunch = Number(record.blue?.stats?.plus1 || 0) > 0;
      if (redPunch !== bluePunch) return { winner: redPunch ? 'RED' : 'BLUE', reason: 'SUP - GOLDEN ROUND PUNCH' };
    }
    if (criterion === 'GOLDEN_ROUND_HIT_COUNT') {
      const redHits = hitCount(record, 'RED'); const blueHits = hitCount(record, 'BLUE');
      if (redHits !== blueHits) return { winner: redHits > blueHits ? 'RED' : 'BLUE', reason: 'SUP - GOLDEN ROUND HIT COUNT' };
    }
    if (criterion === 'REGULATION_ROUNDS_WON') {
      const wins = countRoundWins();
      if (wins.RED !== wins.BLUE) return { winner: wins.RED > wins.BLUE ? 'RED' : 'BLUE', reason: 'SUP - ROUNDS WON' };
    }
    if (criterion === 'FEWER_TOTAL_GAMJEOMS') {
      const gamJeoms = totalGamJeoms();
      if (gamJeoms.RED !== gamJeoms.BLUE) return { winner: gamJeoms.RED < gamJeoms.BLUE ? 'RED' : 'BLUE', reason: 'SUP - FEWER GAM-JEOMS' };
    }
  }
  return null;
}

function endGoldenRound(winner = null, reason = 'TIME 0:00') {
  if (!isGoldenRound()) return;
  match.running = false;
  timerLastAt = null;
  match.timerMs = 0;
  const record = roundRecord(winner, reason);
  clearAllRemoteCombinations();
  match.votes = {};
  match.roundHistory.push(record);
  clearRemoteScoreHighlights();
  emit({ type: 'roundEndSound' });
  emit({ type: 'roundEnd', record });

  if (winner) {
    finishMatch(winner, reason);
    return;
  }

  const superiority = goldenRoundSuperiority(record);
  match.goldenRound.superiority = superiority ? { ...superiority, automatic: true } : { automatic: false };
  if (superiority) {
    finishMatch(superiority.winner, superiority.reason);
    return;
  }
  beginTieDecision('GOLDEN_SUPERIORITY');
}

function finishRegulationRound(winner, reason, { emitSound = true, forceMatchEnd = false } = {}) {
  const record = roundRecord(winner, reason);
  clearAllRemoteCombinations();
  match.roundHistory.push(record);
  match.votes = {};
  clearRemoteScoreHighlights();

  if (emitSound) emit({ type: 'roundEndSound' });
  emit({ type: 'roundEnd', record });

  if (forceMatchEnd) {
    finishMatch(winner, reason);
    return;
  }

  const wins = countRoundWins();
  if (wins.RED >= rules.match.roundsRequiredToWin) {
    finishMatch('RED', `PTF - WON ${rules.match.roundsRequiredToWin} ROUNDS`);
    return;
  }
  if (wins.BLUE >= rules.match.roundsRequiredToWin) {
    finishMatch('BLUE', `PTF - WON ${rules.match.roundsRequiredToWin} ROUNDS`);
    return;
  }
  if (match.round >= rules.match.rounds) {
    beginTieDecision('CHOOSE_METHOD');
    return;
  }

  match.phase = 'BREAK';
  match.breakTarget = 'REGULAR';
  match.breakMs = breakDurationForRound(match.configuredRoundMs);
  match.timerMs = match.breakMs;
  setRunning(true);
  state(true);
}

function endRound(winner = null, reason = 'TIME 0:00') {
  if (match.phase !== 'ROUND') return;
  if (isGoldenRound()) {
    endGoldenRound(winner, reason);
    return;
  }
  match.running = false;
  timerLastAt = null;
  match.timerMs = 0;

  let actualWinner = winner || winnerByScore();
  let actualReason = reason;
  const roundTie = rules.decisions.roundTie;
  const isNonFinalRegulationRound = match.round < rules.match.rounds;
  if (!actualWinner && isNonFinalRegulationRound && roundTie.type === 'SUPERIORITY') {
    const superiority = roundTieSuperiority(match.red, match.blue, roundTie.criteria);
    if (superiority) {
      actualWinner = superiority.winner;
      actualReason = superiority.reason;
    } else if (roundTie.unresolved === 'WOO_SE_GIROK') {
      clearAllRemoteCombinations();
      match.votes = {};
      clearRemoteScoreHighlights();
      if (match.round < rules.match.rounds) {
        emit({ type: 'roundEndSound' });
        beginTieDecision('ROUND_WOO_SE_GIROK');
        return;
      }
    }
  }

  finishRegulationRound(actualWinner, actualReason);
}

function finishMatch(winner, reason) {
  match.running = false;
  match.roundStarted = false;
  timerLastAt = null;
  match.phase = 'MATCH_END';
  match.breakTarget = 'REGULAR';
  match.tieDecision = makeTieDecision();
  match.goldenRound.active = false;
  match.matchWinner = winner;
  match.matchReason = reason;
  const endedAt = new Date().toISOString();
  if (match.mode === 'PRACTICE') {
    const finishedPracticeMatch = deep(match);
    match.cornerRefereeHistory = [];
    match.operatorHistory = [];
    match.roundHistory = [];
    match.votes = {};
    match.kyeShi = makeKyeShi();
    match.practiceMatchNo = 1;
    clearAllRemoteCombinations();
    clearLastRemoteButtons();
    clearRemoteScoreHighlights();
    clearVoteSettleGuard();
    emit({ type: 'matchEnd', winner, reason, match: finishedPracticeMatch });
    state(true);
    return;
  }
  const record = {
    id: crypto.randomUUID(),
    source: match.manualBout ? 'MANUAL' : tournament.activeBoutNo ? 'TOURNAMENT' : 'UNASSIGNED',
    matchNo: match.matchNo,
    arenaNumber,
    manualBout: match.manualBout ? deep(match.manualBout) : null,
    red: deep(match.red),
    blue: deep(match.blue),
    redName: playerDisplayName(match.red),
    blueName: playerDisplayName(match.blue),
    winner,
    winnerName: winner ? playerDisplayName(side(winner)) : 'DRAW',
    defeatedName: winner ? playerDisplayName(side(other(winner))) : '',
    reason,
    rounds: deep(match.roundHistory),
    cornerRefereeHistory: deep(match.cornerRefereeHistory),
    operatorHistory: deep(match.operatorHistory),
    ruleset: deep(match.ruleset || activeRulesMetadata),
    rulesSnapshot: deep(match.rulesSnapshot || rules),
    startedAt: match.startedAt || match.manualBout?.loadedAt || null,
    endedAt
  };
  completeTournamentBout(winner);
  matchHistory.unshift(record);
  matchHistory = matchHistory.slice(0, 50);
  if (record.manualBout?.categoryId) {
    manualMatchRecords.unshift(deep(record));
    const category = manualCompetition.categories.find(item => item.id === record.manualBout.categoryId);
    if (category) {
      if (!category.matchRecordIds.includes(record.id)) category.matchRecordIds.push(record.id);
      applyAutomaticManualPlacements(category);
      manualCompetition.activeCategoryId = category.id;
    }
    persistManualArchive();
  }
  match.cornerRefereeHistory = [];
  clearRemoteScoreHighlights();
  emit({ type: 'matchEnd', winner, reason, match: deep(match) });
  state(true);
}

function decideWooSeGirok(winner) {
  if (!validPlayer(winner)) {
    return { ok: false, code: 'INVALID_WINNER', message: 'Winner must be RED or BLUE' };
  }
  if (!configuredTieOptions().includes('WOO_SE_GIROK')) {
    return { ok: false, code: 'WOO_SE_GIROK_DISABLED', message: 'Woo-se-girok is disabled by the active rule pack' };
  }
  if (match.phase !== 'TIE_DECISION') {
    return { ok: false, code: 'WOO_SE_GIROK_UNAVAILABLE', message: 'Woo-se-girok is not currently required' };
  }
  const mode = match.tieDecision?.mode;
  const reason = `${rules.tieBreak.wooSeGirok.reasonCode} - WOO-SE-GIROK`;
  if (mode === 'ROUND_WOO_SE_GIROK') {
    match.tieDecision = makeTieDecision();
    finishRegulationRound(winner, reason, { emitSound: false });
    return { ok: true };
  }
  if (mode === 'MATCH_WOO_SE_GIROK') {
    match.tieDecision = makeTieDecision();
    finishRegulationRound(winner, reason, { emitSound: false, forceMatchEnd: true });
    return { ok: true };
  }
  if (mode !== 'CHOOSE_METHOD') {
    return { ok: false, code: 'WOO_SE_GIROK_UNAVAILABLE', message: 'Woo-se-girok is not currently required' };
  }
  finishMatch(winner, reason);
  return { ok: true };
}

function decideGoldenRoundSuperiority(winner) {
  if (!validPlayer(winner)) {
    return { ok: false, code: 'INVALID_WINNER', message: 'Winner must be RED or BLUE' };
  }
  if (match.phase !== 'TIE_DECISION' || match.tieDecision?.mode !== 'GOLDEN_SUPERIORITY') {
    return { ok: false, code: 'SUPERIORITY_UNAVAILABLE', message: 'A manual superiority decision is not currently required' };
  }
  match.goldenRound.superiority = { winner, reason: 'SUP - GOLDEN ROUND REFEREE DECISION', automatic: false };
  finishMatch(winner, 'SUP - GOLDEN ROUND REFEREE DECISION');
  return { ok: true };
}

function declareManualMatchDecision(winner, decision) {
  if (!validPlayer(winner) || !rules.decisions.manualMatchDecisions.includes(decision)) {
    return { ok: false, code: 'INVALID_MATCH_DECISION', message: 'Choose a valid winner and match decision' };
  }
  if (match.phase === 'MATCH_END') {
    return { ok: false, code: 'MATCH_ALREADY_ENDED', message: 'The match has already ended' };
  }
  if (match.phase === 'ROUND') {
    syncTimer();
    if (match.phase !== 'ROUND') {
      return { ok: false, code: 'MATCH_STATE_CHANGED', message: 'The match state changed while recording the decision' };
    }
    match.running = false;
    timerLastAt = null;
    match.roundHistory.push(roundRecord(winner, `${decision} - REFEREE DECLARATION`));
  }
  match.votes = {};
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearVoteSettleGuard();
  finishMatch(winner, `${decision} - REFEREE DECLARATION`);
  return { ok: true };
}

function startNextRound() {
  if (match.phase !== 'BREAK') return;
  const goldenRound = match.breakTarget === 'GOLDEN';
  match.round = goldenRound ? rules.match.rounds + 1 : match.round + 1;
  match.phase = 'ROUND';
  match.goldenRound.active = goldenRound;
  if (goldenRound) {
    match.goldenRound.previousScoresVoided = true;
    match.goldenRound.superiority = null;
    for (const record of match.roundHistory) {
      if (record.round <= rules.match.rounds) record.voidedForGoldenRound = true;
    }
  }
  match.breakTarget = 'REGULAR';
  match.timerMs = goldenRound ? match.goldenRound.durationMs : match.configuredRoundMs;
  match.running = false;
  match.roundStarted = false;
  timerLastAt = null;
  match.kyeShi = makeKyeShi();
  kyeShiLastAt = null;
  if (!goldenRound || rules.tieBreak.goldenRound.resetRegularScores) {
    match.red.score = 0;
    match.red.gamjeom = 0;
    match.red.stats = baseStats();
    match.blue.score = 0;
    match.blue.gamjeom = 0;
    match.blue.stats = baseStats();
  }
  match.votes = {};
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearVoteSettleGuard();
  state(true);
}

function resetCurrentMatch() {
  if (tournament.activeBoutNo) {
    const bout = findTournamentBout(tournament.activeBoutNo);
    if (bout && (bout.status === 'IN_PROGRESS' || bout.status === 'TIE_PENDING')) {
      bout.status = 'SCHEDULED';
      bout.winner = null;
      bout.winnerName = null;
      bout.tieReason = '';
      bout.announcement = scheduleAnnouncement(bout);
    }
    tournament.activeBoutNo = null;
    refreshTournamentBracket();
  }
  const remoteCount = match.remoteCount;
  const resetMode = match.mode;
  const manualBout = resetMode === 'PRACTICE' || match.manualBout?.importedBoutNo ? null : match.manualBout ? deep(match.manualBout) : null;
  match = makeMatch(
    match.matchNo,
    match.red.name,
    match.blue.name,
    match.configuredRoundMs,
    match.red,
    match.blue
  );
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, Number(remoteCount) || MAX_ACTIVE_REMOTES));
  match.mode = resetMode === 'PRACTICE' ? 'PRACTICE' : 'OFFICIAL';
  match.practiceMatchNo = match.mode === 'PRACTICE' ? 1 : null;
  match.manualBout = manualBout;
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearRemoteScoreHighlights();
  clearVoteSettleGuard();
  timerLastAt = null;
  kyeShiLastAt = null;
  state(true);
}

function newMatch({ clearPlayers = false } = {}) {
  if (tournament.activeBoutNo) {
    const bout = findTournamentBout(tournament.activeBoutNo);
    if (bout?.status === 'TIE_PENDING') return false;
  }
  const remoteCount = match.remoteCount;
  const leavingPractice = match.mode === 'PRACTICE';
  match = makeMatch(
    leavingPractice ? match.matchNo : match.matchNo + 1,
    match.red.name,
    match.blue.name,
    match.configuredRoundMs,
    clearPlayers || leavingPractice ? {} : match.red,
    clearPlayers || leavingPractice ? {} : match.blue
  );
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, Number(remoteCount) || MAX_ACTIVE_REMOTES));
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearRemoteScoreHighlights();
  clearVoteSettleGuard();
  timerLastAt = null;
  kyeShiLastAt = null;
  state(true);
  return true;
}

function updatePlayerSettings(players) {
  if (!players || typeof players !== 'object' || Array.isArray(players)) {
    return { ok: false, code: 'INVALID_PLAYER_SETTINGS', message: 'Player settings are required' };
  }

  const next = {};
  for (const player of ['RED', 'BLUE']) {
    const current = side(player);
    const input = players[player];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, code: 'INVALID_PLAYER_SETTINGS', message: `${player} player settings are required` };
    }

    const hasStateCode = Object.prototype.hasOwnProperty.call(input, 'stateCode');
    const legacyStateCode = String(input.district || '').trim().toUpperCase();
    const stateCode = String(
      hasStateCode ? input.stateCode : (INDIAN_STATE_CODES.has(legacyStateCode) ? legacyStateCode : '')
    ).trim().toUpperCase();
    if (stateCode && !INDIAN_STATE_CODES.has(stateCode)) {
      return { ok: false, code: 'INVALID_STATE_CODE', message: 'State code must be a valid Indian state code' };
    }

    next[player] = {
      playerName: String(input.playerName || input.name || '').trim().slice(0, 64),
      division: '',
      weightCategory: String(input.weightCategory || '').trim().slice(0, 32),
      categoryGroup: '',
      stateCode,
      district: hasStateCode
        ? String(input.district || '').trim().slice(0, 48)
        : '',
      club: String(input.club || '').trim().slice(0, 64)
    };
  }

  Object.assign(match.red, next.RED);
  Object.assign(match.blue, next.BLUE);
  return { ok: true };
}

function playerDisplayName(player) {
  return player.playerName || player.name;
}

function evaluateVotes() {
  const requiredVotes = Math.floor(match.remoteCount / 2) + 1;
  for (const player of ['RED', 'BLUE']) {
    for (const points of rules.scoring.acceptedPointValues) {
      const total = Object.values(match.votes).filter(v => v.player === player && v.points === points).length;
      if (total >= requiredVotes) {
        const winningVote = Object.values(match.votes).find(v => v.player === player && v.points === points);
        const winningCorners = Object.entries(match.votes)
          .filter(([, vote]) => vote.player === player && vote.points === points)
          .map(([corner]) => Number(corner))
          .filter(corner => Number.isInteger(corner) && corner >= 1 && corner <= MAX_ACTIVE_REMOTES)
          .sort((a, b) => a - b);
        const technical = Boolean(winningVote?.technical);
        voteSettleGuard = match.remoteCount > 1
          ? { player, points, technical, corners: winningCorners, expiresAt: Date.now() + VOTE_SETTLE_MS }
          : null;
        addPoint(
          player,
          points,
          technical ? 'referee-technical' : 'referee',
          !technical,
          false,
          winningVote.basePoints || points
        );
        if (technical) addTechnicalStat(player, winningVote.basePoints);
        match.votes = {};
        showRemoteScoreHighlight(player, winningCorners, points);
        const result = {
          awarded: true,
          player,
          points,
          basePoints: winningVote.basePoints || points,
          technical,
          count: total,
          requiredVotes,
          corners: winningCorners
        };
        emit({
          type: 'scoreUpdate',
          matchNo: match.matchNo,
          round: match.round,
          redScore: match.red.score,
          blueScore: match.blue.score
        });
        state(true, false);
        emit({ type: 'award', ...result });
        return result;
      }
    }
  }
  state(true, false);
  return { awarded: false };
}

function expirePendingVotes(now = Date.now()) {
  let expired = false;
  for (const [corner, vote] of Object.entries(match.votes)) {
    if (Number.isFinite(vote.occurredAt) && now - vote.occurredAt > VOTE_WINDOW_MS) {
      delete match.votes[corner];
      expired = true;
    }
  }
  if (expired) state();
}

function recordRefereeVote(corner, vote) {
  const now = Date.now();
  const occurredAt = Number.isFinite(vote.occurredAt) ? vote.occurredAt : now;
  for (const [pendingCorner, pendingVote] of Object.entries(match.votes)) {
    if (!Number.isFinite(pendingVote.occurredAt) || Math.abs(occurredAt - pendingVote.occurredAt) > VOTE_WINDOW_MS) {
      delete match.votes[pendingCorner];
    }
  }
  if (voteSettleGuard) {
    if (now >= voteSettleGuard.expiresAt) {
      voteSettleGuard = null;
    } else if (vote.player === voteSettleGuard.player && vote.points === voteSettleGuard.points &&
      Boolean(vote.technical) === Boolean(voteSettleGuard.technical) &&
      !voteSettleGuard.corners.includes(corner)) {
      return { awarded: false, ignored: true, count: voteSettleGuard.corners.length };
    }
  }
  if (vote.button) showLastRemoteButton(corner, vote.button);
  match.votes[corner] = { ...vote, occurredAt };
  const count = Object.values(match.votes)
    .filter(item => item.player === vote.player && item.points === vote.points).length;
  const outcome = evaluateVotes();
  return { ...outcome, count };
}

function completeRemoteVote(ws, sequence, vote) {
  const outcome = recordRefereeVote(ws.corner, vote);
  const ack = remoteAck(ws, sequence, {
    accepted: true,
    reason: outcome.ignored ? 'LATE_VOTE_IGNORED' : outcome.awarded ? 'POINT_AWARDED' : 'VOTE_RECORDED',
    awarded: outcome.awarded,
    points: vote.points,
    basePoints: vote.basePoints || vote.points,
    technical: Boolean(vote.technical),
    voteCount: outcome.count
  });
  rememberRemoteAck(ws.remoteSession, sequence, ack);
  return outcome;
}

function clearVoteSettleGuard() {
  voteSettleGuard = null;
}

function setRemoteCount(value) {
  const remoteCount = Number(value);
  if (!Number.isInteger(remoteCount) || remoteCount < MIN_ACTIVE_REMOTES || remoteCount > MAX_ACTIVE_REMOTES) {
    return { ok: false, code: 'INVALID_REMOTE_MODE', message: `Remote mode must be between ${MIN_ACTIVE_REMOTES} and ${MAX_ACTIVE_REMOTES} remotes` };
  }
  const matchHasProgress = match.running || match.roundHistory.length > 0 ||
    match.red.score > 0 || match.blue.score > 0 || match.red.gamjeom > 0 || match.blue.gamjeom > 0 ||
    Object.keys(match.votes).length > 0;
  if (matchHasProgress && !match.test.active) {
    return { ok: false, code: 'REMOTE_MODE_LOCKED', message: 'Set the remote mode before scoring starts or use remote test mode' };
  }
  match.remoteCount = remoteCount;
  match.votes = {};
  clearAllRemoteCombinations();
  clearVoteSettleGuard();
  clearRemoteScoreHighlights();
  if (match.test.active) {
    match.test.presses = {};
    emit({ type: 'testReset' });
  }
  return { ok: true };
}

function resetTest() {
  match.test.active = false;
  match.test.presses = {};
  clearAllRemoteCombinations();
  emit({ type: 'testReset' });
  state(true);
}

function handleRemoteHello(ws, msg) {
  if (ws.role !== 'unknown') {
    sendError(ws, 'ROLE_ALREADY_ASSIGNED', 'This connection already has a role');
    return;
  }

  const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.toUpperCase() : '';
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const protocolVersion = msg.protocolVersion;
  const expectedToken = expectedRemoteToken(deviceId);
  const allowUnpaired = process.env.SFTS_ALLOW_UNPAIRED_REMOTES === 'true';

  if (!REMOTE_IDS.has(deviceId)) {
    sendError(ws, 'INVALID_DEVICE', 'Device ID must be C1, C2, C3, or C4');
    return;
  }
  if (protocolVersion !== 1 && protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    sendError(ws, 'UNSUPPORTED_PROTOCOL', 'Expected remote protocol v1 or v2');
    return;
  }
  if (!validRemoteSessionId(sessionId)) {
    sendError(ws, 'INVALID_SESSION', 'A valid remote session ID is required');
    return;
  }
  if (!allowUnpaired) {
    if (!expectedToken) {
      sendError(ws, 'REMOTE_NOT_CONFIGURED', `No token configured for ${deviceId}`);
      return;
    }
    if (!tokenMatches(msg.token, expectedToken)) {
      sendError(ws, 'UNAUTHORIZED_REMOTE', 'Remote authentication failed');
      return;
    }
  }
  const helloTelemetry = {};
  if (Object.prototype.hasOwnProperty.call(msg, 'rssi')) {
    const rssi = normalizeRssi(msg.rssi);
    if (msg.rssi !== null && rssi === null) {
      sendError(ws, 'INVALID_TELEMETRY', 'RSSI must be an integer from -127 to 0');
      return;
    }
    helloTelemetry.rssi = rssi;
  }
  if (Object.prototype.hasOwnProperty.call(msg, 'battery')) {
    const battery = normalizeBattery(msg.battery);
    if (msg.battery !== null && battery === null) {
      sendError(ws, 'INVALID_TELEMETRY', 'Battery must be a percentage from 0 to 100');
      return;
    }
    helloTelemetry.battery = battery;
  }
  const existing = remoteSockets.get(deviceId);
  if (existing && existing !== ws && existing.readyState === 1) {
    // A newly authenticated connection replaces the old transport. Its
    // session ID still determines whether replay state is retained.
    existing.terminate();
  }

  const corner = Number(deviceId.slice(1));
  const previousSession = remoteSessions.get(deviceId);
  const session = previousSession && previousSession.sessionId === sessionId &&
    Date.now() - (previousSession.lastSeenAt || 0) <= REMOTE_SESSION_TTL_MS
    ? previousSession
    : { sessionId, lastSequence: 0, acks: new Map(), lastSeenAt: Date.now() };

  ws.role = 'remote';
  clearTimeout(ws.authTimer);
  ws.deviceId = deviceId;
  ws.corner = corner;
  ws.sessionId = sessionId;
  ws.firmware = String(msg.firmware || '').slice(0, 32);
  ws.protocolVersion = protocolVersion;
  ws.remoteSession = session;
  remoteSockets.set(deviceId, ws);
  remoteSessions.set(deviceId, session);
  remoteStatuses.get(deviceId).protocolVersion = protocolVersion;
  updateRemoteStatus(ws, helloTelemetry, false);

  send(ws, {
    type: 'remote_ready',
    protocolVersion,
    deviceId,
    corner,
    sessionId
  });
  send(ws, remoteState(ws));
  state();
}

function handleRemoteEvent(ws, msg) {
  if (ws.role !== 'remote' || !ws.remoteSession || remoteSockets.get(ws.deviceId) !== ws) {
    sendError(ws, 'REMOTE_NOT_AUTHENTICATED', 'Send remote_hello before remote_event');
    return;
  }

  const sequence = msg.sequence;
  const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.toUpperCase() : '';
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  if (deviceId !== ws.deviceId || sessionId !== ws.sessionId) {
    sendError(ws, 'REMOTE_ID_MISMATCH', 'Event identity does not match the connected remote');
    return;
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    sendError(ws, 'INVALID_SEQUENCE', 'Event sequence must be a positive safe integer');
    return;
  }
  // Events are application-level liveness signals too. This keeps a remote
  // that is actively delivering input from being marked stale between status
  // messages.
  updateRemoteStatus(ws, {}, false);

  const session = ws.remoteSession;
  const previousAck = session.acks.get(sequence);
  if (previousAck) {
    send(ws, previousAck);
    return;
  }
  // Firmware may have sent a later event while an earlier send failed. Accept
  // the earlier sequence inside the acknowledgement window exactly once.
  if (sequence <= session.lastSequence - REMOTE_ACK_CACHE_SIZE) {
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'SEQUENCE_REPLAY' });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  session.lastSequence = Math.max(session.lastSequence, sequence);
  const eventAgeMs = msg.ageMs === undefined && ws.protocolVersion === 1 ? 0 : msg.ageMs;
  if (!Number.isSafeInteger(eventAgeMs) || eventAgeMs < 0 || eventAgeMs > REMOTE_EVENT_MAX_AGE_MS) {
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'EVENT_EXPIRED', awarded: false });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  const occurredAt = Date.now() - eventAgeMs;

  const button = String(msg.button || '').toUpperCase();
  if (ws.corner > match.remoteCount) {
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'REMOTE_DISABLED', awarded: false });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  if (button === 'CANCEL') {
    recordCornerRefereePress(ws.corner, button);
    if (match.test.active) {
      const ack = remoteAck(ws, sequence, { accepted: false, reason: 'TEST_MODE_ACTIVE' });
      rememberRemoteAck(session, sequence, ack);
      return;
    }
    if (match.phase !== 'ROUND') {
      const ack = remoteAck(ws, sequence, { accepted: false, reason: 'ROUND_NOT_ACTIVE' });
      rememberRemoteAck(session, sequence, ack);
      return;
    }
    showLastRemoteButton(ws.corner, button);
    clearRemoteCombination(ws.corner);
    delete match.votes[ws.corner];
    state(true, false);
    const ack = remoteAck(ws, sequence, { accepted: true, reason: 'VOTE_CANCELLED', awarded: false });
    rememberRemoteAck(session, sequence, ack);
    return;
  }

  const vote = remoteButton(button);
  if (!vote) {
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'INVALID_BUTTON' });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  if (match.test.active) {
    showLastRemoteButton(ws.corner, vote.button);
    const testButton = remoteTestTracker.press(ws.corner, vote, occurredAt);
    if (testButton) {
      const testVote = remoteButton(testButton);
      match.test.presses[`${ws.corner}-${testButton}`] = true;
      emit({ type: 'testPress', corner: ws.corner, player: testVote.player, points: testVote.points, button: testButton });
    }
    state();
    const ack = remoteAck(ws, sequence, { accepted: true, reason: testButton ? 'TEST_PRESS_RECORDED' : 'TECHNICAL_PENDING', test: true, awarded: false });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  if (match.phase !== 'ROUND') {
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'ROUND_NOT_ACTIVE' });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  if (!match.running) {
    clearRemoteCombination(ws.corner);
    delete match.votes[ws.corner];
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'MATCH_NOT_RUNNING', awarded: false });
    rememberRemoteAck(session, sequence, ack);
    return;
  }

  showLastRemoteButton(ws.corner, vote.button);

  if (vote.combined) {
    clearRemoteCombination(ws.corner);
    recordCornerRefereePress(
      ws.corner,
      cornerRefereeButtonLabel(vote.player, vote.basePoints, true),
      vote.points
    );
    completeRemoteVote(ws, sequence, { ...vote, occurredAt });
    return;
  }

  if (vote.technical) {
    const base = remoteLastBasePress.get(ws.corner);
    const existingVote = match.votes[ws.corner];
    if (base && existingVote && base.player === vote.player && existingVote.player === vote.player &&
        existingVote.points === base.points && !existingVote.technical && Date.now() - base.timestamp <= TECHNICAL_COMBO_WINDOW_MS) {
      clearRemoteCombination(ws.corner);
      replaceCornerRefereeHistoryEntry(
        base.historyEntry,
        cornerRefereeButtonLabel(vote.player, base.points, true),
        technicalPointsFor(base.points)
      );
      completeRemoteVote(ws, sequence, {
        player: vote.player,
        points: technicalPointsFor(base.points),
        basePoints: base.points,
        technical: true,
        button: vote.button,
        occurredAt
      });
      return;
    }
    rememberTechnicalPress(ws.corner, vote.player);
    const ack = remoteAck(ws, sequence, { accepted: true, reason: 'TECHNICAL_PENDING', awarded: false, technical: true });
    rememberRemoteAck(session, sequence, ack);
    return;
  }

  const technical = remoteTechnicalPending.get(ws.corner);
  if (technical && technical.player === vote.player) {
    const technicalPoints = technicalPointsFor(vote.points);
    if (technicalPoints !== null) {
      clearRemoteCombination(ws.corner);
      recordCornerRefereePress(
        ws.corner,
        cornerRefereeButtonLabel(vote.player, vote.points, true),
        technicalPoints
      );
      completeRemoteVote(ws, sequence, {
        player: vote.player,
        points: technicalPoints,
        basePoints: vote.points,
        technical: true,
        button: `${vote.player}_TECHNICAL_${vote.points}`,
        occurredAt
      });
      return;
    }
    clearRemoteCombination(ws.corner);
    const ack = remoteAck(ws, sequence, {
      accepted: false,
      reason: 'TECHNICAL_REQUIRES_ELIGIBLE_BASE_POINT',
      awarded: false
    });
    rememberRemoteAck(session, sequence, ack);
    return;
  }

  if (technical) clearRemoteCombination(ws.corner);
  const historyEntry = recordCornerRefereePress(
    ws.corner,
    cornerRefereeButtonLabel(vote.player, vote.points),
    vote.points
  );
  const outcome = completeRemoteVote(ws, sequence, {
    ...vote,
    basePoints: vote.points,
    technical: false,
    occurredAt
  });
  if (technicalPointsFor(vote.points) !== null && !outcome.awarded) {
    rememberBasePress(ws.corner, vote, historyEntry);
  }
}

wss.on('connection', (ws, request) => {
  ws.role = 'unknown';
  ws.corner = 0;
  ws.deviceId = null;
  ws.sessionId = null;
  ws.remoteSession = null;
  ws.hostToken = null;
  ws.requestOrigin = String(request.headers.origin || '');
  ws.arduinoTransport = String(request.headers['sec-websocket-protocol'] || '').split(',').some(value => value.trim() === 'arduino');
  ws.peerAddress = normalizeAddress(request.socket.remoteAddress || '');
  const byteLimit = createRateLimiter({ capacity: 256 * 1024, refillPerSecond: 128 * 1024, maxKeys: 1 });
  ws.authTimer = setTimeout(() => {
    if (ws.role === 'unknown') ws.terminate();
  }, AUTH_TIMEOUT_MS);
  ws.authTimer.unref?.();
  ws.messageWindowStartedAt = Date.now();
  ws.messageCount = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  syncTimer();

  ws.on('message', raw => {
    try {
    if (shuttingDown) return;
    if (!byteLimit.take('socket', raw.length)) {
      ws.terminate();
      return;
    }
    const now = Date.now();
    if (now - ws.messageWindowStartedAt >= WS_MESSAGE_WINDOW_MS) {
      ws.messageWindowStartedAt = now;
      ws.messageCount = 0;
    }
    ws.messageCount += 1;
    if (ws.messageCount > WS_MESSAGE_LIMIT) {
      sendError(ws, 'RATE_LIMITED', 'Too many messages; slow down and reconnect');
      ws.close(1008, 'Rate limit exceeded');
      return;
    }
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    if (ws.role === 'unknown' && !networkGuard.authentications.take(ws.peerAddress)) {
      ws.close(1008, 'Authentication rate limit exceeded');
      return;
    }
    syncTimer();

    if (msg.type === 'remote_hello') {
      handleRemoteHello(ws, msg);
      return;
    }
    if (msg.type === 'remote_event') {
      handleRemoteEvent(ws, msg);
      return;
    }
    if (msg.type === 'remote_status') {
      handleRemoteStatus(ws, msg);
      return;
    }
    if (msg.type === 'remote_ping') {
      if (ws.role === 'remote' && remoteSockets.get(ws.deviceId) === ws) {
        const hasTelemetry = Object.prototype.hasOwnProperty.call(msg, 'rssi') || Object.prototype.hasOwnProperty.call(msg, 'battery');
        updateRemoteStatus(ws, hasTelemetry ? msg : {}, hasTelemetry);
        send(ws, { type: 'remote_pong', deviceId: ws.deviceId });
      }
      else sendError(ws, 'REMOTE_NOT_AUTHENTICATED', 'Send remote_hello before remote_ping');
      return;
    }
    if (msg.type === 'role') {
      if (ws.arduinoTransport) {
        sendError(ws, 'REMOTE_ONLY_CONNECTION', 'Arduino connections must authenticate with remote_hello');
        return;
      }
      if (ws.role !== 'unknown') {
        sendError(ws, 'ROLE_ALREADY_ASSIGNED', 'This connection already has a role');
        return;
      }
      const kioskAuthorized = KIOSK_MODE &&
        msg.role === 'host' &&
        isLoopbackAddress(ws._socket?.remoteAddress) &&
        isTrustedKioskOrigin(ws.requestOrigin);
      ws.supportsStatePatch = msg.supportsStatePatch === true;
      assignRole(ws, msg.role, Number(msg.corner), msg.accessToken, kioskAuthorized);
      return;
    }

    if (msg.type === 'host') {
      if (ws.role !== 'host') return;
      if (rulesUpdateInProgress) {
        sendError(ws, 'RULE_UPDATE_BUSY', 'Rules are being updated; retry shortly');
        return;
      }
      if (!HOST_ACTIONS.has(msg.action)) {
        sendError(ws, 'INVALID_ACTION', 'Unknown host action');
        return;
      }

      if (msg.action === 'systemPower') {
        scheduleSystemPower(ws, msg.powerAction);
        return;
      }
      if (msg.action === 'cancelSystemPower') {
        cancelSystemPower(ws);
        return;
      }

      if (match.kyeShi.active && ['playPause', 'setTime', 'resetRoundTimer'].includes(msg.action)) {
        sendError(ws, 'KYESHI_ACTIVE', 'End Kye-shi before changing the match timer');
        return;
      }

      if (msg.action === 'startKyeShi') {
        const result = startKyeShi();
        if (!result.ok) sendError(ws, result.code, result.message);
        state(true);
        return;
      }
      if (msg.action === 'pauseKyeShi') {
        const result = pauseKyeShi();
        if (!result.ok) sendError(ws, result.code, result.message);
        state(true);
        return;
      }
      if (msg.action === 'resumeKyeShi') {
        const result = resumeKyeShi();
        if (!result.ok) sendError(ws, result.code, result.message);
        state(true);
        return;
      }
      if (msg.action === 'endKyeShi') {
        const result = endKyeShi();
        if (!result.ok) sendError(ws, result.code, result.message);
        state(true);
        return;
      }
      if (msg.action === 'declareKyeShiWinner') {
        const result = declareKyeShiWinner(String(msg.player || '').toUpperCase());
        if (!result.ok) sendError(ws, result.code, result.message);
        state(true);
        return;
      }
      if (msg.action === 'startGoldenRound') {
        const result = startGoldenRoundBreak();
        if (!result.ok) sendError(ws, result.code, result.message);
        state(true);
        return;
      }
      if (msg.action === 'decideWooSeGirok') {
        const result = decideWooSeGirok(String(msg.player || '').toUpperCase());
        if (!result.ok) sendError(ws, result.code, result.message);
        return;
      }
      if (msg.action === 'decideGoldenRoundSuperiority') {
        const result = decideGoldenRoundSuperiority(String(msg.player || '').toUpperCase());
        if (!result.ok) sendError(ws, result.code, result.message);
        return;
      }
      if (msg.action === 'manualMatchDecision') {
        const result = declareManualMatchDecision(
          String(msg.player || '').toUpperCase(),
          String(msg.decision || '').toUpperCase()
        );
        if (!result.ok) sendError(ws, result.code, result.message);
        return;
      }

      if (msg.action === 'playPause' && (match.phase === 'ROUND' || match.phase === 'BREAK')) {
        setRunning(!match.running);
      }
      if (msg.action === 'setTime') {
        const rawMs = Number(msg.ms);
        const ms = validInteger(rawMs) ? Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, rawMs)) : ROUND_MS_DEFAULT;
        if (match.phase === 'ROUND') setRunning(false);
        if (match.phase === 'ROUND' && match.goldenRound.active) {
          if (!rules.tieBreak.goldenRound.allowTimerEdit) {
            sendError(ws, 'GOLDEN_TIMER_LOCKED', 'Golden Round duration is locked by the active rule pack');
            return;
          }
          match.goldenRound.durationMs = ms;
          match.timerMs = ms;
        } else {
          match.configuredRoundMs = ms;
          match.breakMs = breakDurationForRound(ms);
          if (match.phase === 'ROUND') match.timerMs = ms;
        }
      }
      if (msg.action === 'resetRoundTimer' && match.phase === 'ROUND') {
        setRunning(false);
        if (match.phase === 'ROUND') {
          match.timerMs = match.goldenRound.active
            ? match.goldenRound.durationMs
            : match.configuredRoundMs;
        }
      }
      if (msg.action === 'playerSettings') {
        const result = updatePlayerSettings(msg.players);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'saveManualBout') {
        const result = saveManualBout(msg.details);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
        if (msg.announce === true) {
          const announcement = manualPlayersAnnouncement({ RED: match.red, BLUE: match.blue });
          if (announcement.ok) void announceAnnouncement(announcement.text);
        }
      }
      if (msg.action === 'deleteManualCategory') {
        const result = deleteManualCategory(msg.categoryId, {
          deleteRecords: msg.deleteRecords === true,
          confirmation: msg.confirmation
        });
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'saveManualCategoryPlacements') {
        const result = saveManualCategoryPlacements(msg.categoryId, msg.placements, msg.finalize === true);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'announcePractice') {
        if (practiceMatchIsBusy()) {
          sendError(ws, 'MATCH_IN_PROGRESS', 'Finish or reset the current match before making a practice announcement');
          return;
        }
        const result = manualPlayersAnnouncement(msg.details);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
        void announceAnnouncement(result.text);
        return;
      }
      if (msg.action === 'loadPractice') {
        const result = loadPracticeMatch(msg.details);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'setArenaNumber') {
        const nextArenaNumber = normalizeArenaNumber(msg.value);
        if (msg.value !== '' && nextArenaNumber === '') {
          sendError(ws, 'INVALID_ARENA_NUMBER', 'Arena number must be an integer from 1 to 999');
          return;
        }
        arenaNumber = nextArenaNumber;
      }
      if (msg.action === 'announcePlayers') {
        const result = manualPlayersAnnouncement(msg.details);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
        void announceAnnouncement(result.text);
        return;
      }
      if (msg.action === 'name') {
        if (!validPlayer(msg.player)) {
          sendError(ws, 'INVALID_PLAYER', 'Invalid player');
          return;
        }
        const name = String(msg.name || '').trim().slice(0, 64);
        if (msg.player === 'RED') match.red.playerName = name;
        if (msg.player === 'BLUE') match.blue.playerName = name;
      }
      if (msg.action === 'advancedScoreCorrection') {
        const result = advancedScoreCorrection(
          String(msg.player || '').toUpperCase(),
          msg.value,
          msg.reason
        );
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'editScore') {
        if (!validPlayer(msg.player) || !operatorScoringIsAllowed()) {
          sendError(ws, 'ROUND_NOT_ACTIVE', 'Scores can only be edited during a round');
          return;
        }
        const parsed = Number(msg.value);
        if (!validInteger(parsed)) {
          sendError(ws, 'INVALID_SCORE', 'Score must be a safe whole number');
          return;
        }
        const value = Math.max(0, parsed);
        const previous = side(msg.player).score;
        if (msg.player === 'RED') match.red.score = value;
        if (msg.player === 'BLUE') match.blue.score = value;
        if (previous !== value) recordOperatorCorrection('SCORE EDIT', msg.player, previous, value);
        checkPointGap();
      }
      if (msg.action === 'editGamjeom') {
        if (!validPlayer(msg.player) || !operatorScoringIsAllowed()) {
          sendError(ws, 'ROUND_NOT_ACTIVE', 'Gam-jeom can only be edited during a round');
          return;
        }
        const parsed = Number(msg.value);
        const maximumGamJeoms = rules.penalties.gamJeom.matchLossAt ?? rules.penalties.gamJeom.roundLossAt;
        const value = validInteger(parsed) ? Math.max(0, Math.min(maximumGamJeoms, parsed)) : 0;
        const previous = side(msg.player).gamjeom;
        if (msg.player === 'RED') match.red.gamjeom = value;
        if (msg.player === 'BLUE') match.blue.gamjeom = value;
        if (previous !== value) recordOperatorCorrection('GAM-JEOM EDIT', msg.player, previous, value);
        if (isGoldenRound() && value >= rules.tieBreak.goldenRound.opponentGamJeomsToWin) {
          endGoldenRound(other(msg.player), `GDP - ${rules.tieBreak.goldenRound.opponentGamJeomsToWin} GAM-JEOMS`);
        } else if (rules.penalties.gamJeom.matchLossAt !== null &&
                   totalGamJeomsFor(msg.player, { includeCurrentRound: true }) >= rules.penalties.gamJeom.matchLossAt) {
          finishMatch(other(msg.player), `PUN - ${rules.penalties.gamJeom.matchLossAt} TOTAL GAM-JEOMS`);
        } else if (value >= rules.penalties.gamJeom.roundLossAt) {
          endRound(other(msg.player), `ROUND GAM-JEOM LIMIT - ${rules.penalties.gamJeom.roundLossAt} GAM-JEOM`);
        }
      }
      if (msg.action === 'editRoundTieStats') {
        const result = editRoundTieStats(String(msg.player || '').toUpperCase(), msg.stats);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'correctScoringAction') {
        const result = correctScoringAction(
          String(msg.player || '').toUpperCase(),
          String(msg.direction || '').toUpperCase(),
          String(msg.actionKey || '').toUpperCase()
        );
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'correctGamjeom') {
        const result = correctGamjeom(
          String(msg.player || '').toUpperCase(),
          String(msg.direction || '').toUpperCase()
        );
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'point' && !addPoint(msg.player, Number(msg.points), 'manual', true, true)) {
        sendError(ws, 'ROUND_NOT_ACTIVE', 'Points can only be awarded during a round');
      }
      if (msg.action === 'technicalPoint') {
        const result = addTechnicalPoint(String(msg.player || '').toUpperCase(), Number(msg.basePoints));
        if (!result.ok) sendError(ws, result.code, result.message);
      }
      if (msg.action === 'headPoint' && !addPoint(msg.player, 3, 'manual-head', true, true)) {
        sendError(ws, 'ROUND_NOT_ACTIVE', 'Head points can only be awarded during a round');
      }
      if (msg.action === 'gamjeom' && !addGamjeom(msg.player, true)) {
        sendError(ws, 'ROUND_NOT_ACTIVE', 'Gam-jeom can only be awarded during a round');
      }
      if (msg.action === 'nextRound') startNextRound();
      if (msg.action === 'resetMatch') resetCurrentMatch();
      if (msg.action === 'newMatch') {
        if (match.phase !== 'MATCH_END') {
          sendError(ws, 'MATCH_NOT_ENDED', 'A new match can only start after match end');
          return;
        }
        if (!newMatch()) {
          sendError(ws, 'TIE_PENDING', 'Resolve the tied tournament bout before starting a new match');
        }
      }
      if (msg.action === 'nextManualBout') {
        if (match.phase !== 'MATCH_END') {
          sendError(ws, 'MATCH_NOT_ENDED', 'The current match must be finished before preparing the next manual bout');
          return;
        }
        if (tournament.activeBoutNo || !newMatch({ clearPlayers: true })) {
          sendError(ws, 'MANUAL_BOUT_UNAVAILABLE', 'A tournament bout is active or awaiting tie resolution');
          return;
        }
      }
      if (msg.action === 'loadBout') {
        const bout = findTournamentBout(msg.boutNo);
        if (!bout) {
          sendError(ws, 'BOUT_NOT_FOUND', 'Scheduled bout not found');
          return;
        }
        const result = loadTournamentBout(bout);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'announceBout') {
        const bout = findTournamentBout(msg.boutNo);
        if (!bout) {
          sendError(ws, 'BOUT_NOT_FOUND', 'Scheduled bout not found');
          return;
        }
        if (bout.status !== 'SCHEDULED' && bout.status !== 'IN_PROGRESS') {
          sendError(ws, 'BOUT_UNAVAILABLE', 'This bout is not ready to announce');
          return;
        }
        void announceTournamentBout(bout);
        return;
      }
      if (msg.action === 'resolveTie') {
        const bout = findTournamentBout(msg.boutNo);
        if (!bout) {
          sendError(ws, 'BOUT_NOT_FOUND', 'Scheduled bout not found');
          return;
        }
        const result = resolveTournamentTie(bout, String(msg.winner || '').toUpperCase());
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
        state(true);
        return;
      }
      if (msg.action === 'correctImportedWinner') {
        const result = correctImportedWinner(msg.boutNo, String(msg.winner || '').toUpperCase());
        if (!result.ok) { sendError(ws, result.code, result.message); return; }
      }
      if (msg.action === 'setRemoteMode') {
        const result = setRemoteCount(msg.count);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'testStart') {
        setRunning(false);
        clearAllRemoteCombinations();
        match.test.active = true;
        match.test.presses = {};
        match.votes = {};
        emit({ type: 'testReset' });
      }
      if (msg.action === 'testStop') {
        resetTest();
        return;
      }
      state(true, !COALESCED_HOST_ACTIONS.has(msg.action));
      return;
    }

    if (msg.type === 'ref') {
      if (ws.role !== 'referee' || ws.corner < 1 || ws.corner > 4) return;
      if (ws.corner > match.remoteCount) return;
      const player = msg.player;
      const points = Number(msg.points);

      if (msg.action === 'vote' && validPlayer(player) && validPoints(points)) {
        recordCornerRefereePress(ws.corner, cornerRefereeButtonLabel(player, points), points);
        if (match.test.active) {
          const button = `${player}_${points}`;
          match.test.presses[`${ws.corner}-${button}`] = true;
          emit({ type: 'testPress', corner: ws.corner, player, points, button });
          state();
          return;
        }
        if (!scoringIsAllowed()) return;
        recordRefereeVote(ws.corner, { player, points, button: `${player}_${points}` });
        return;
      }

      if (msg.action === 'cancel' && !match.test.active) {
        recordCornerRefereePress(ws.corner, 'CANCEL');
        delete match.votes[ws.corner];
        state(true, false);
      }
    }
    } catch {
      // Hostile object coercions must never escape this event handler and
      // terminate the scoring process.
      sendError(ws, 'INVALID_MESSAGE', 'Invalid message fields');
    }
  });

  ws.on('error', error => {
    console.error('WebSocket connection error:', error.message);
  });
  ws.on('close', () => {
    clearTimeout(ws.authTimer);
    if (shuttingDown) return;
    const wasHost = hostSocket === ws;
    releaseRole(ws);
    if (wasHost && match.running) {
      setRunning(false);
      emit({ type: 'hostDisconnected' });
      state(true);
    }
    if (wasHost && match.test.active) resetTest();
  });
});

setInterval(() => {
  const changed = syncTimer();
  expirePendingVotes();
  const displayInterval = match.kyeShi.active ||
    (match.phase === 'ROUND' && match.running && match.timerMs <= 10_000)
    ? TIMER_DISPLAY_UPDATE_MS
    : 900;
  if (changed && Date.now() - lastStateAt >= displayInterval) sendTimerUpdate();
  if (match.running && Date.now() - lastTimerPersistAt >= 10_000) persistState();
}, TIMER_TICK_MS);

setInterval(() => {
  const now = Date.now();
  let staleRemoteChanged = false;
  for (const status of remoteStatuses.values()) {
    if (!status.connected || !status.lastSeenAt || now - status.lastSeenAt <= REMOTE_LIVENESS_TIMEOUT_MS) continue;
    status.connected = false;
    staleRemoteChanged = true;
  }
  if (staleRemoteChanged) state();

  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (error) {
      console.error('WebSocket heartbeat failed:', error.message);
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);

wss.on('error', error => {
  if (error.code !== 'EADDRINUSE') console.error('WebSocket server error:', error.message);
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing server or start with another port.`);
  } else {
    console.error('HTTP server error:', error.message);
  }
  process.exitCode = 1;
  process.exit();
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 10_000).unref();
  console.log(`${signal} received; shutting down`);
  if (pendingSystemPower) {
    clearTimeout(pendingSystemPower.timer);
    pendingSystemPower = null;
  }
  try {
    await flushPersistedState(persistenceSnapshot({ cleanShutdown: true }));
    await manualArchive.flush();
  } catch (error) {
    console.error(`Could not flush saved state during shutdown: ${error.message}`);
  }
  await persistence.release();
  await fileJobs.close();
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  wss.close(() => server.close(() => process.exit(0)));
}

let shuttingDown = false;
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Taekwondo Scorer v3 running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Wi-Fi:  http://${getLocalIPv4()}:${PORT}`);
  const configuredRemoteIds = [...REMOTE_IDS].filter(deviceId => expectedRemoteToken(deviceId));
  console.log(`Remote authentication configured for: ${configuredRemoteIds.join(', ') || 'none'}`);
  if (!KIOSK_MODE) console.log(`Host access token: ${hostAccessToken}`);
  if (KIOSK_MODE) console.log('Kiosk mode: localhost host access is enabled');
});
