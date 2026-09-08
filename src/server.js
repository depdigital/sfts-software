import express from "express";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import * as XLSX from "xlsx";
import { createTts } from "./tts.js";
import { createPersistence } from "./persistence.js";
import {
  loadRules,
  readRulesFile,
  rulesConstants,
  rulesMetadata,
  rulesPaths,
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
let ROUND_MS_DEFAULT = rules.match.roundDurationSeconds * 1000;
let BREAK_MS_DEFAULT = Number.isFinite(Number(process.env.SFTS_BREAK_MS))
  ? Math.max(50, Number(process.env.SFTS_BREAK_MS))
  : rules.match.breakDurationSeconds * 1000;
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
const MAX_TOURNAMENT_PLAYERS = 500;
const MAX_SCHEDULE_BOUTS = 5000;
const REMOTE_PROTOCOL_VERSION = 1;
const REMOTE_IDS = new Set(['C1', 'C2', 'C3', 'C4']);
const REMOTE_ACK_CACHE_SIZE = 100;
const WS_MESSAGE_LIMIT = 120;
const WS_MESSAGE_WINDOW_MS = 1000;
const VOTE_SETTLE_MS = 750;
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
const USB_TEMPLATE_FILE = 'sfts-player-template.xlsx';
const KIOSK_MODE = process.env.SFTS_KIOSK_MODE === 'true';
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
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD });
const publicDir = path.join(PROJECT_ROOT, 'public');
const tts = createTts();
const persistence = createPersistence();
const hostAccessToken = String(process.env.SFTS_HOST_TOKEN || '').trim() || crypto.randomBytes(24).toString('hex');
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

function makeSide(name, profile = {}) {
  const stateCode = String(profile?.stateCode || '').trim().toUpperCase();
  return {
    name,
    playerName: String(profile?.playerName || '').trim().slice(0, 24),
    weightCategory: String(profile?.weightCategory || '').trim().slice(0, 32),
    stateCode: INDIAN_STATE_CODES.has(stateCode) ? stateCode : '',
    district: String(profile?.district || '').trim().slice(0, 48),
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
    breakMs: BREAK_MS_DEFAULT,
    remoteCount: MAX_ACTIVE_REMOTES,
    ruleset: deep(activeRulesMetadata),
    running: false,
    roundStarted: false,
    phase: "ROUND", // ROUND | BREAK | MATCH_END
    kyeShi: makeKyeShi(),
    red: makeSide(redName, redProfile),
    blue: makeSide(blueName, blueProfile),
    votes: {},
    cornerRefereeHistory: [],
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
    format: 'SINGLE_ELIMINATION',
    seed: null,
    generatedAt: null,
    players: [],
    groups: [],
    schedule: [],
    byes: [],
    activeBoutNo: null
  };
}

function normalizeGender(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return GENDER_ALIASES.get(normalized) || '';
}

function normalizeColumn(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashSeed(seed) {
  let value = 2166136261;
  for (const char of String(seed)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function seededRandom(seed) {
  let value = hashSeed(seed);
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function scheduleAnnouncement(bout) {
  return `Bout ${bout.boutNo}: ${bout.redPlayerName} versus ${bout.bluePlayerName}, ${bout.gender}, ${bout.weightCategory}`;
}

function bracketSizeFor(playerCount) {
  let size = 1;
  while (size < playerCount) size *= 2;
  return size;
}

function bracketEntryForPlayer(player) {
  return player ? { type: 'player', player } : null;
}

function bracketEntryForBout(boutNo) {
  return { type: 'bout', boutNo };
}

function bracketEntryName(entry) {
  if (!entry) return '';
  if (entry.type === 'player') return entry.player.name;
  return `Winner of Bout ${entry.boutNo}`;
}

function bracketPlayerId(entry) {
  return entry?.type === 'player' ? entry.player.id : null;
}

function createBracketBout({ boutNo, group, round, left, right }) {
  const bout = {
    boutNo,
    groupId: group.id,
    gender: group.gender,
    weightCategory: group.weightCategory,
    round,
    redPlayerId: bracketPlayerId(left),
    redPlayerName: bracketEntryName(left),
    redSourceBoutNo: left?.type === 'bout' ? left.boutNo : null,
    bluePlayerId: bracketPlayerId(right),
    bluePlayerName: bracketEntryName(right),
    blueSourceBoutNo: right?.type === 'bout' ? right.boutNo : null,
    status: left?.type === 'player' && right?.type === 'player' ? 'SCHEDULED' : 'PENDING',
    winner: null,
    winnerName: null,
    tieReason: '',
    announcement: ''
  };
  bout.announcement = scheduleAnnouncement(bout);
  return bout;
}

function addBracketBye({ byes, group, round, entry }) {
  if (!entry) return;
  const playerId = bracketPlayerId(entry);
  const playerName = bracketEntryName(entry);
  if (playerId) group.byePlayerIds.push(playerId);
  byes.push({
    groupId: group.id,
    gender: group.gender,
    weightCategory: group.weightCategory,
    round,
    playerId,
    playerName,
    sourceBoutNo: entry.type === 'bout' ? entry.boutNo : null,
    status: 'BYE',
    announcement: `${playerName} advances by bye in round ${round}, ${group.gender}, ${group.weightCategory}`
  });
}

function generateTournament(players, seed = crypto.randomBytes(8).toString('hex')) {
  const random = seededRandom(seed);
  const grouped = new Map();
  for (const player of players) {
    const key = `${player.gender}|${player.weightCategory.toLowerCase()}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(player);
  }

  const groups = [...grouped.entries()]
    .sort(([, left], [, right]) => {
      const genderOrder = left[0].gender.localeCompare(right[0].gender);
      return genderOrder || left[0].weightCategory.localeCompare(right[0].weightCategory, undefined, { numeric: true });
    });
  const expectedBouts = groups.reduce((total, [, groupPlayers]) => total + Math.max(0, groupPlayers.length - 1), 0);
  if (expectedBouts > MAX_SCHEDULE_BOUTS) {
    throw new TournamentImportError(`The generated single-elimination schedule would contain ${expectedBouts} bouts; maximum is ${MAX_SCHEDULE_BOUTS}`);
  }
  const schedule = [];
  const byes = [];
  const tournamentGroups = [];
  let boutNo = 1;

  groups.forEach(([, groupPlayers], groupIndex) => {
    const ordered = shuffled(groupPlayers, random);
    const bracketSize = bracketSizeFor(ordered.length);
    const group = {
      id: `G${String(groupIndex + 1).padStart(3, '0')}`,
      gender: groupPlayers[0].gender,
      weightCategory: groupPlayers[0].weightCategory,
      playerIds: groupPlayers.map(player => player.id),
      byePlayerIds: [],
      bracketSize,
      matchCount: 0,
      championId: null,
      championName: null
    };

    if (ordered.length === 1) {
      group.championId = ordered[0].id;
      group.championName = ordered[0].name;
      addBracketBye({ byes, group, round: 1, entry: bracketEntryForPlayer(ordered[0]) });
      tournamentGroups.push(group);
      return;
    }

    const byeCount = bracketSize - ordered.length;
    const slots = [];
    let playerIndex = 0;
    for (let pair = 0; pair < bracketSize / 2; pair += 1) {
      if (pair < byeCount) {
        slots.push(bracketEntryForPlayer(ordered[playerIndex++]));
        slots.push(null);
      } else {
        slots.push(bracketEntryForPlayer(ordered[playerIndex++]));
        slots.push(bracketEntryForPlayer(ordered[playerIndex++]));
      }
    }

    let round = 1;
    let entries = slots;
    while (entries.length > 1) {
      const nextEntries = [];
      for (let index = 0; index < entries.length; index += 2) {
        const left = entries[index];
        const right = entries[index + 1];
        if (left && right) {
          const redFirst = random() < 0.5;
          const bout = createBracketBout({
            boutNo,
            group,
            round,
            left: redFirst ? left : right,
            right: redFirst ? right : left
          });
          schedule.push(bout);
          group.matchCount += 1;
          nextEntries.push(bracketEntryForBout(boutNo));
          boutNo += 1;
        } else {
          const advancing = left || right;
          if (advancing) addBracketBye({ byes, group, round, entry: advancing });
          nextEntries.push(advancing);
        }
      }
      entries = nextEntries;
      round += 1;
    }
    tournamentGroups.push(group);
  });

  return {
    format: 'SINGLE_ELIMINATION',
    seed,
    generatedAt: new Date().toISOString(),
    players: deep(players),
    groups: tournamentGroups,
    schedule,
    byes,
    activeBoutNo: null
  };
}

class TournamentImportError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'TournamentImportError';
    this.errors = errors;
  }
}

const TOURNAMENT_COLUMN_ALIASES = {
  id: new Set(['id', 'playerid', 'competitorid', 'registrationid']),
  name: new Set(['name', 'playername', 'competitor', 'competitorname']),
  gender: new Set(['gender', 'sex']),
  weightCategory: new Set(['weight', 'weightcategory', 'weightclass', 'category']),
  stateCode: new Set(['state', 'statecode']),
  district: new Set(['district', 'city']),
  club: new Set(['club', 'clubname', 'team', 'teamname'])
};

function importTournamentPlayers(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: false,
      cellNF: false,
      cellStyles: false,
      bookVBA: false,
      dense: true,
      sheetRows: MAX_TOURNAMENT_PLAYERS + 2
    });
  } catch {
    throw new TournamentImportError('The uploaded file is not a readable Excel or CSV file');
  }

  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new TournamentImportError('The workbook does not contain a worksheet');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false
  });
  if (!rows.length) throw new TournamentImportError('The worksheet is empty');

  const headers = rows[0].map(normalizeColumn);
  const columns = {};
  for (const [field, aliases] of Object.entries(TOURNAMENT_COLUMN_ALIASES)) {
    const index = headers.findIndex(header => aliases.has(header));
    if (index >= 0) columns[field] = index;
  }
  const missing = ['name', 'gender', 'weightCategory'].filter(field => columns[field] === undefined);
  if (missing.length) {
    throw new TournamentImportError(`Missing required column(s): ${missing.join(', ')}`);
  }

  const players = [];
  const errors = [];
  const ids = new Set();
  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_TOURNAMENT_PLAYERS) {
    errors.push(`The file contains more than ${MAX_TOURNAMENT_PLAYERS} player rows`);
  }

  dataRows.slice(0, MAX_TOURNAMENT_PLAYERS).forEach((row, index) => {
    const rowNumber = index + 2;
    const value = field => String(row[columns[field]] ?? '').trim();
    if (row.every(cell => String(cell ?? '').trim() === '')) return;

    const name = value('name').slice(0, 64);
    const gender = normalizeGender(value('gender'));
    const weightCategory = value('weightCategory').slice(0, 32);
    const rawId = value('id');
    const id = (rawId || `P${String(players.length + 1).padStart(3, '0')}`).slice(0, 40);
    const stateCode = value('stateCode').toUpperCase();

    if (!name) errors.push(`Row ${rowNumber}: player name is required`);
    if (!gender) errors.push(`Row ${rowNumber}: gender must be MALE/M or FEMALE/F`);
    if (!weightCategory) errors.push(`Row ${rowNumber}: weight category is required`);
    if (ids.has(id.toLowerCase())) errors.push(`Row ${rowNumber}: duplicate player ID ${id}`);
    if (stateCode && !INDIAN_STATE_CODES.has(stateCode)) errors.push(`Row ${rowNumber}: invalid state code ${stateCode}`);
    if (!name || !gender || !weightCategory || ids.has(id.toLowerCase()) || (stateCode && !INDIAN_STATE_CODES.has(stateCode))) return;

    ids.add(id.toLowerCase());
    players.push({
      id,
      name,
      gender,
      weightCategory,
      stateCode,
      district: value('district').slice(0, 48),
      club: value('club').slice(0, 64)
    });
  });

  if (errors.length) throw new TournamentImportError('The player sheet could not be imported', errors.slice(0, 30));
  if (!players.length) throw new TournamentImportError('The worksheet does not contain any player rows');
  return players;
}

let match = makeMatch();
let arenaNumber = '';
let matchHistory = [];
let tournament = makeTournament();
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
  lastSeenAt: null
}]));
const remoteTechnicalPending = new Map();
const remoteLastBasePress = new Map();
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
let voteSettleGuard = null;
let pendingSystemPower = null;

function deep(v) { return JSON.parse(JSON.stringify(v)); }

function configureRuntimeRules(nextRules) {
  rules = nextRules;
  activeRulesMetadata = rulesMetadata(rules);
  ROUND_MS_DEFAULT = rules.match.roundDurationSeconds * 1000;
  BREAK_MS_DEFAULT = Number.isFinite(Number(process.env.SFTS_BREAK_MS))
    ? Math.max(50, Number(process.env.SFTS_BREAK_MS))
    : rules.match.breakDurationSeconds * 1000;
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
  match.breakMs = BREAK_MS_DEFAULT;
  match.configuredRoundMs = ROUND_MS_DEFAULT;
  if (match.phase === 'ROUND' && !match.roundStarted) match.timerMs = ROUND_MS_DEFAULT;
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, match.remoteCount));
  match.kyeShi.limitMs = KYESHI_LIMIT_MS;
}

function scoringRulesState() {
  return {
    basePointValues: [...rules.scoring.basePointValues],
    basePointLabels: { ...rules.scoring.basePointLabels },
    acceptedPointValues: [...rules.scoring.acceptedPointValues],
    technicalInput: deep(rules.scoring.technicalInput),
    gamJeomPointValue: rules.scoring.gamJeomPointValue
  };
}

function persistenceSnapshot() {
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
    arenaNumber,
    ruleset: deep(activeRulesMetadata),
    match: savedMatch,
    matchHistory: deep(matchHistory),
    tournament: deep(tournament)
  };
}

function persistState() {
  if (!persistenceReady) return;
  persistence.schedule(persistenceSnapshot());
  lastTimerPersistAt = Date.now();
}

function restorePersistedState(snapshot) {
  arenaNumber = normalizeArenaNumber(snapshot.arenaNumber);
  match = snapshot.match;
  for (const player of [match.red, match.blue]) {
    player.stats = { ...baseStats(), ...(player.stats || {}) };
  }
  match.ruleset ||= deep(activeRulesMetadata);
  match.remoteCount = Number.isInteger(match.remoteCount) && match.remoteCount >= MIN_ACTIVE_REMOTES && match.remoteCount <= MAX_ACTIVE_REMOTES
    ? match.remoteCount
    : MAX_ACTIVE_REMOTES;
  match.running = false;
  match.roundStarted = Boolean(match.roundStarted || match.timerMs < match.configuredRoundMs ||
    match.red.score > 0 || match.blue.score > 0 || match.red.gamjeom > 0 || match.blue.gamjeom > 0);
  match.kyeShi = {
    ...makeKyeShi(),
    ...(match.kyeShi && typeof match.kyeShi === 'object' ? match.kyeShi : {})
  };
  match.kyeShi.limitMs = KYESHI_LIMIT_MS;
  match.kyeShi.running = false;
  match.kyeShi.resumeMatch = false;
  match.kyeShi.elapsedMs = Math.max(0, Math.min(match.kyeShi.limitMs, Number(match.kyeShi.elapsedMs) || 0));
  kyeShiLastAt = null;
  match.votes = {};
  match.cornerRefereeHistory = Array.isArray(match.cornerRefereeHistory)
    ? match.cornerRefereeHistory
    : [];
  match.test = { active: false, presses: {} };
  matchHistory = snapshot.matchHistory;
  tournament = snapshot.tournament;
  refreshTournamentBracket();

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
  restorePersistedState(persistedState.snapshot);
  console.log(`Restored saved state from ${persistedState.source} snapshot`);
}
persistenceReady = true;
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
function fullState() {
  return {
    type: "state",
    arenaNumber,
    remoteButtons: [1, 2, 3, 4].map(corner => lastRemoteButtons.get(corner) || null),
    remoteScoreHighlights: deep(remoteScoreHighlights),
    remoteScoreValues: deep(remoteScoreValues),
    remoteScoreRevisions: deep(remoteScoreRevisions),
    match: deep(match),
    matchHistory: deep(matchHistory),
    tournament: deep(tournament),
    remotes: [...remoteStatuses.values()].map(status => deep(status)),
    usbImportOnly: USB_IMPORT_ONLY,
    ruleset: deep(activeRulesMetadata),
    scoringRules: scoringRulesState()
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
    kyeShi: deep(match.kyeShi),
    activeRemoteCount: match.remoteCount,
    requiredVotes: Math.floor(match.remoteCount / 2) + 1,
    connected: Boolean(remoteStatuses.get(ws.deviceId)?.connected),
    rssi: remoteStatuses.get(ws.deviceId)?.rssi ?? null,
    battery: remoteStatuses.get(ws.deviceId)?.battery ?? null,
    red: { score: match.red.score, gamjeom: match.red.gamjeom },
    blue: { score: match.blue.score, gamjeom: match.blue.gamjeom },
    votes: deep(match.votes)
  };
}
function state(persist = false) {
  if (persist) persistState();
  let text = null;
  for (const ws of wss.clients) {
    if (ws.role === 'remote') sendText(ws, JSON.stringify(remoteState(ws)), 'remote state broadcast');
    else if (ws.role === 'host' || ws.role === 'referee') {
      text ||= JSON.stringify(fullState());
      sendText(ws, text, 'state broadcast');
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
      await persistence.flush(persistenceSnapshot());
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
    hostSocket &&
    hostSocket.readyState === 1 &&
    hostSocket.hostToken &&
    req.get('x-sfts-host-token') === hostSocket.hostToken
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
function withUsbOperation(action) {
  const operation = usbOperation.then(action, action);
  usbOperation = operation.catch(() => {});
  return operation;
}

async function writePlayerTemplateToUsb(context) {
  if (!context.mounted) throw new Error('USB DRIVE IS NOT MOUNTED');
  const target = path.join(context.mountPath, USB_TEMPLATE_FILE);
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('USB TEMPLATE TARGET IS A SYMBOLIC LINK');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(target, createPlayerTemplateBuffer());
  const details = await stat(target);
  return { fileName: USB_TEMPLATE_FILE, size: details.size };
}

async function unmountUsb(context) {
  if (!context.mounted || !context.device?.path) throw new Error('USB DRIVE IS NOT MOUNTED');
  if (!/^\/dev\/[^/]+$/.test(context.device.path)) throw new Error('USB DEVICE PATH IS INVALID');
  await execFileAsync(UDISKSCTL_BIN, ['unmount', '--block-device', context.device.path]);
}

function tournamentScheduleRows() {
  const bouts = tournament.schedule.map(bout => ({
    Bout: bout.boutNo,
    Group: bout.groupId,
    Gender: bout.gender,
    'Weight Category': bout.weightCategory,
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
    Group: bye.groupId,
    Gender: bye.gender,
    'Weight Category': bye.weightCategory,
    Round: bye.round,
    'Red Player': bye.playerName,
    'Blue Player': 'BYE',
    Status: 'BYE',
    Winner: bye.playerId,
    Announcement: bye.announcement
  }));
  return [...bouts, ...byes];
}

function scheduleWorkbook() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(tournamentScheduleRows());
  XLSX.utils.book_append_sheet(workbook, sheet, 'Schedule');
  return workbook;
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

function findTournamentBout(boutNo) {
  const number = Number(boutNo);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return tournament.schedule.find(bout => bout.boutNo === number) || null;
}

function refreshTournamentBracket() {
  for (const bout of tournament.schedule) {
    for (const playerSide of ['red', 'blue']) {
      const sourceBoutNo = bout[`${playerSide}SourceBoutNo`];
      if (!sourceBoutNo) continue;
      const source = findTournamentBout(sourceBoutNo);
      const playerIdKey = `${playerSide}PlayerId`;
      const playerNameKey = `${playerSide}PlayerName`;
      if (source?.winner) {
        const player = tournament.players.find(item => item.id === source.winner);
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

  for (const bye of tournament.byes || []) {
    if (!bye.sourceBoutNo) continue;
    const source = findTournamentBout(bye.sourceBoutNo);
    if (source?.winner) {
      const player = tournament.players.find(item => item.id === source.winner);
      bye.playerId = source.winner;
      bye.playerName = source.winnerName || player?.name || `Winner of Bout ${bye.sourceBoutNo}`;
    } else {
      bye.playerId = null;
      bye.playerName = source?.status === 'TIE_PENDING'
        ? `Tie pending in Bout ${bye.sourceBoutNo}`
        : `Winner of Bout ${bye.sourceBoutNo}`;
    }
    bye.announcement = `${bye.playerName} advances by bye in round ${bye.round}, ${bye.gender}, ${bye.weightCategory}`;
  }

  for (const group of tournament.groups) {
    const groupBouts = tournament.schedule.filter(bout => bout.groupId === group.id);
    const final = groupBouts.reduce((current, bout) => (
      !current || bout.round > current.round ? bout : current
    ), null);
    if (final?.status === 'COMPLETED' && final.winner) {
      group.championId = final.winner;
      group.championName = final.winnerName;
    }
  }
}

function loadTournamentBout(bout) {
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
    match.phase === 'MATCH_END' ? match.matchNo + 1 : match.matchNo,
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
      return { ok: false, code: 'INVALID_PLAYER_DETAILS', message: `Both ${player} and ${player === 'RED' ? 'BLUE' : 'RED'} player details are required before announcing` };
    }
    const name = String(input.playerName || '').trim().slice(0, 24);
    if (!name) {
      return { ok: false, code: 'INVALID_PLAYER_DETAILS', message: `${player} player name is required before announcing` };
    }
    const weightCategory = String(input.weightCategory || '').trim().slice(0, 32);
    const stateCode = String(input.stateCode || '').trim().toUpperCase().slice(0, 2);
    if (stateCode && !INDIAN_STATE_CODES.has(stateCode)) {
      return { ok: false, code: 'INVALID_STATE_CODE', message: 'State code must be a valid Indian state code' };
    }
    players[player] = {
      name,
      weightCategory,
      stateCode,
      district: String(input.district || '').trim().slice(0, 48)
    };
  }

  const red = players.RED;
  const blue = players.BLUE;
  const weightText = red.weightCategory && red.weightCategory === blue.weightCategory
    ? `, ${red.weightCategory}`
    : red.weightCategory || blue.weightCategory
      ? `, Red weight category ${red.weightCategory || 'not specified'}, Blue weight category ${blue.weightCategory || 'not specified'}`
      : '';
  return {
    ok: true,
    text: `Bout ${match.matchNo}: ${red.name} versus ${blue.name}${weightText}`
  };
}

async function announceAnnouncement(text, fields = {}) {
  let audio = null;
  try {
    audio = await tts.synthesize(text);
  } catch (error) {
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

function createPlayerTemplateBuffer() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([
    { 'Player ID': 'M58-01', Name: 'Arjun Mehta', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'DL', District: 'New Delhi', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M58-02', Name: 'Rohan Singh', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'UP', District: 'Noida', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M58-03', Name: 'Karan Patel', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'GJ', District: 'Ahmedabad', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M58-04', Name: 'Vivek Rao', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'KA', District: 'Bengaluru', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M58-05', Name: 'Aditya Nair', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'KL', District: 'Kochi', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M58-06', Name: 'Nikhil Das', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'WB', District: 'Kolkata', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M58-07', Name: 'Manav Shah', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'MH', District: 'Mumbai', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M58-08', Name: 'Yash Verma', Gender: 'MALE', 'Weight Category': '58 kg', 'State Code': 'RJ', District: 'Jaipur', Club: 'SFTS Demo Club' },
    { 'Player ID': 'F49-01', Name: 'Ananya Kapoor', Gender: 'FEMALE', 'Weight Category': '49 kg', 'State Code': 'DL', District: 'New Delhi', Club: 'SFTS Demo Club' },
    { 'Player ID': 'F49-02', Name: 'Ishita Iyer', Gender: 'FEMALE', 'Weight Category': '49 kg', 'State Code': 'TN', District: 'Chennai', Club: 'SFTS Demo Club' },
    { 'Player ID': 'F49-03', Name: 'Meera Joshi', Gender: 'FEMALE', 'Weight Category': '49 kg', 'State Code': 'MH', District: 'Pune', Club: 'SFTS Demo Club' },
    { 'Player ID': 'F49-04', Name: 'Kavya Menon', Gender: 'FEMALE', 'Weight Category': '49 kg', 'State Code': 'KL', District: 'Thiruvananthapuram', Club: 'SFTS Demo Club' },
    { 'Player ID': 'F49-05', Name: 'Diya Bose', Gender: 'FEMALE', 'Weight Category': '49 kg', 'State Code': 'WB', District: 'Kolkata', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M68-01', Name: 'Aarav Gupta', Gender: 'MALE', 'Weight Category': '68 kg', 'State Code': 'HR', District: 'Gurugram', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M68-02', Name: 'Dev Malhotra', Gender: 'MALE', 'Weight Category': '68 kg', 'State Code': 'PB', District: 'Ludhiana', Club: 'SFTS Demo Club' },
    { 'Player ID': 'M68-03', Name: 'Kabir Khan', Gender: 'MALE', 'Weight Category': '68 kg', 'State Code': 'KA', District: 'Mysuru', Club: 'SFTS Demo Club' }
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Players');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function rulesSummary(rulePack) {
  return {
    format: rulePack.match.format,
    rounds: rulePack.match.rounds,
    roundsRequiredToWin: rulePack.match.roundsRequiredToWin,
    roundDurationSeconds: rulePack.match.roundDurationSeconds,
    breakDurationSeconds: rulePack.match.breakDurationSeconds,
    basePointValues: rulePack.scoring.basePointValues,
    basePointLabels: rulePack.scoring.basePointLabels,
    acceptedPointValues: rulePack.scoring.acceptedPointValues,
    technicalInput: rulePack.scoring.technicalInput,
    gamJeomPointValue: rulePack.scoring.gamJeomPointValue,
    gamJeomRoundLossAt: rulePack.penalties.gamJeom.roundLossAt,
    pointGap: rulePack.decisions.pointGap,
    maximumActiveRemotes: rulePack.voting.maximumActiveRemotes,
    kyeShiLimitSeconds: rulePack.medical.kyeShi.limitSeconds,
    tournamentFormat: rulePack.tournament.format
  };
}

async function readUsbRulesFile(fileName) {
  const context = await usbContext({ mountIfNeeded: true });
  const filePath = await selectedUsbFile(context, fileName, {
    allowedExtensions: USB_RULE_ALLOWED_EXTENSIONS,
    maxBytes: rulesConstants.maxBytes,
    extensionMessage: 'ONLY RULE PACK FILES CAN BE IMPORTED'
  });
  return readRulesFile(filePath);
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

app.post('/api/rules/apply', requireHostRequest, express.json({ limit: '8kb' }), async (req, res) => {
  if (!USB_IMPORT_ONLY) {
    res.status(404).json({ ok: false, message: 'USB RULE IMPORT IS DISABLED' });
    return;
  }
  if (tournamentMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before applying a ruleset' });
    return;
  }
  try {
    const rulePack = await withUsbOperation(async () => {
      if (tournamentMatchIsBusy()) throw new Error('Finish or reset the current match before applying a ruleset');
      const nextRules = await readUsbRulesFile(req.body?.fileName);
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
    const rulePack = await withUsbOperation(async () => {
      if (tournamentMatchIsBusy()) throw new Error('Finish or reset the current match before loading default rules');
      const defaultRules = await readRulesFile(rulesPaths.default);
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

app.post('/api/usb/import', requireHostRequest, express.json({ limit: '8kb' }), async (req, res) => {
  if (!USB_IMPORT_ONLY) {
    res.status(404).json({ ok: false, message: 'USB IMPORT MODE IS DISABLED' });
    return;
  }
  if (tournamentMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before importing a new player sheet' });
    return;
  }
  try {
    const result = await withUsbOperation(async () => {
      const context = await usbContext();
      const filePath = await selectedUsbFile(context, req.body?.fileName);
      const players = importTournamentPlayers(await readFile(filePath));
      tournament = generateTournament(players);
      state(true);
      return { ok: true, tournament: deep(tournament) };
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

app.post('/api/tournament/import', requireHostRequest, express.raw({ type: '*/*', limit: MAX_IMPORT_BYTES }), (req, res) => {
  if (USB_IMPORT_ONLY) {
    res.status(403).json({ ok: false, message: 'USB IMPORT IS REQUIRED ON THIS DEPLOYMENT' });
    return;
  }
  if (tournamentMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before importing a new player sheet' });
    return;
  }
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const players = importTournamentPlayers(buffer);
    tournament = generateTournament(players);
    state(true);
    res.json({ ok: true, tournament: deep(tournament) });
  } catch (error) {
    const details = error instanceof TournamentImportError ? error.errors : [];
    res.status(400).json({ ok: false, message: error.message || 'Player sheet import failed', errors: details });
  }
});

app.get('/api/tournament/template.xlsx', requireHostRequest, (req, res) => {
  if (USB_IMPORT_ONLY) {
    res.status(403).json({ ok: false, message: 'SAVE THE TEMPLATE TO THE USB FROM PLAYER SETTINGS' });
    return;
  }
  const output = createPlayerTemplateBuffer();
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.attachment('sfts-player-template.xlsx');
  res.send(output);
});

app.get('/api/tournament/schedule.xlsx', requireHostRequest, (req, res) => {
  const output = XLSX.write(scheduleWorkbook(), { type: 'buffer', bookType: 'xlsx' });
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.attachment('sfts-tournament-schedule.xlsx');
  res.send(output);
});

app.get('/api/tournament/schedule.csv', requireHostRequest, (req, res) => {
  const output = XLSX.write(scheduleWorkbook(), { type: 'string', bookType: 'csv' });
  res.type('text/csv');
  res.attachment('sfts-tournament-schedule.csv');
  res.send(output);
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
  return Number.isInteger(value) && Number.isFinite(value);
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

function clearRemoteCombination(corner) {
  const pending = remoteTechnicalPending.get(corner);
  if (pending?.timer) clearTimeout(pending.timer);
  remoteTechnicalPending.delete(corner);
  remoteLastBasePress.delete(corner);
}

function clearAllRemoteCombinations() {
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
    matchNo: match.matchNo,
    arenaNumber,
    corner,
    cornerReferee: cornerRefereeDisplayName(corner, button),
    button,
    score,
    pressedAt: new Date().toISOString()
  };
  match.cornerRefereeHistory.push(entry);
  return entry;
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
    state(true);
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
  status.connected = true;
  status.lastSeenAt = Date.now();
  if (ws.remoteSession) ws.remoteSession.lastSeenAt = status.lastSeenAt;
  if (Object.prototype.hasOwnProperty.call(fields, 'rssi')) status.rssi = normalizeRssi(fields.rssi);
  if (Object.prototype.hasOwnProperty.call(fields, 'battery')) status.battery = normalizeBattery(fields.battery);
  if (broadcast) state();
}

function handleRemoteStatus(ws, msg) {
  if (ws.role !== 'remote' || !ws.remoteSession) {
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
  updateRemoteStatus(ws, telemetry);
  send(ws, { type: 'remote_status_ack', deviceId: ws.deviceId, sessionId: ws.sessionId, accepted: true });
}

function remoteButton(button) {
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
  if (match.phase === 'ROUND') match.roundStarted = true;
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

function checkPointGap() {
  if (match.phase !== "ROUND") return;
  if (!rules.decisions.pointGap.enabled || !rules.decisions.pointGap.appliesToRounds.includes(match.round)) return;
  const diff = Math.abs(match.red.score - match.blue.score);
  if (diff >= rules.decisions.pointGap.difference) {
    const winner = match.red.score > match.blue.score ? "RED" : "BLUE";
    endRound(winner, `${rules.decisions.pointGap.difference}-POINT GAP`);
  }
}

function addPoint(player, points, source = "manual", countAsHit = true, allowPaused = false) {
  const technicalAward = source === 'referee-technical' && rules.scoring.technicalInput.enabled &&
    Object.values(rules.scoring.technicalInput.pointsByBasePoints).includes(points);
  const canScore = allowPaused ? operatorScoringIsAllowed() : scoringIsAllowed();
  if (!validPlayer(player) || (!validPoints(points) && !technicalAward) || !canScore) return false;
  side(player).score += points;
  if (countAsHit) addHitStat(player, points);
  emit({ type: 'scoreSound', player, points, source });
  checkPointGap();
  return true;
}

function addGamjeom(player, allowPaused = false) {
  const canScore = allowPaused ? operatorScoringIsAllowed() : scoringIsAllowed();
  if (!validPlayer(player) || !canScore) return false;
  const penalized = side(player);
  penalized.gamjeom += 1;
  const opponent = other(player);
  if (rules.scoring.gamJeomPointValue > 0 && rules.penalties.gamJeom.awardsPointToOpponent) {
    side(opponent).score += rules.scoring.gamJeomPointValue;
    emit({ type: 'scoreSound', player: opponent, points: rules.scoring.gamJeomPointValue, source: 'gamjeom' });
  }
  if (penalized.gamjeom >= rules.penalties.gamJeom.roundLossAt) {
    endRound(opponent, `${rules.penalties.gamJeom.roundLossAt} GAM-JEOM`);
    return true;
  }
  checkPointGap();
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
    if (r.winner === 'RED') wins.RED += 1;
    if (r.winner === 'BLUE') wins.BLUE += 1;
  }
  return wins;
}

function endRound(winner = null, reason = 'TIME 0:00') {
  if (match.phase !== 'ROUND') return;
  match.running = false;
  timerLastAt = null;
  match.timerMs = 0;
  const actualWinner = winner || winnerByScore();
  const record = {
    round: match.round,
    winner: actualWinner,
    reason,
    red: deep(match.red),
    blue: deep(match.blue)
  };
  clearAllRemoteCombinations();
  match.roundHistory.push(record);
  match.votes = {};

  emit({ type: 'roundEndSound' });
  emit({ type: 'roundEnd', record });

  const wins = countRoundWins();
  if (wins.RED >= 2) {
    finishMatch('RED', 'WON 2 ROUNDS');
    return;
  }
  if (wins.BLUE >= 2) {
    finishMatch('BLUE', 'WON 2 ROUNDS');
    return;
  }
  if (match.round >= 3) {
    finishMatch(actualWinner, 'ROUND 3 RESULT');
    return;
  }

  match.phase = 'BREAK';
  match.timerMs = match.breakMs;
  setRunning(true);
  state(true);
}

function finishMatch(winner, reason) {
  match.running = false;
  match.roundStarted = false;
  timerLastAt = null;
  match.phase = 'MATCH_END';
  match.matchWinner = winner;
  match.matchReason = reason;
  completeTournamentBout(winner);
  matchHistory.unshift({
    matchNo: match.matchNo,
    redName: playerDisplayName(match.red),
    blueName: playerDisplayName(match.blue),
    winner,
    winnerName: winner ? playerDisplayName(side(winner)) : 'DRAW',
    reason,
    rounds: deep(match.roundHistory),
    ruleset: deep(match.ruleset || activeRulesMetadata),
    endedAt: new Date().toISOString()
  });
  matchHistory = matchHistory.slice(0, 50);
  match.cornerRefereeHistory = [];
  clearRemoteScoreHighlights();
  emit({ type: 'matchEnd', winner, reason, match: deep(match) });
  state(true);
}

function startNextRound() {
  if (match.phase !== 'BREAK') return;
  match.round += 1;
  match.phase = 'ROUND';
  match.timerMs = match.configuredRoundMs;
  match.running = false;
  match.roundStarted = false;
  timerLastAt = null;
  match.kyeShi = makeKyeShi();
  kyeShiLastAt = null;
  match.red.score = 0;
  match.red.gamjeom = 0;
  match.red.stats = baseStats();
  match.blue.score = 0;
  match.blue.gamjeom = 0;
  match.blue.stats = baseStats();
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
  match = makeMatch(
    match.matchNo,
    match.red.name,
    match.blue.name,
    match.configuredRoundMs,
    match.red,
    match.blue
  );
  match.remoteCount = Math.min(MAX_ACTIVE_REMOTES, Math.max(MIN_ACTIVE_REMOTES, Number(remoteCount) || MAX_ACTIVE_REMOTES));
  clearAllRemoteCombinations();
  clearLastRemoteButtons();
  clearRemoteScoreHighlights();
  clearVoteSettleGuard();
  timerLastAt = null;
  kyeShiLastAt = null;
  state(true);
}

function newMatch() {
  if (tournament.activeBoutNo) {
    const bout = findTournamentBout(tournament.activeBoutNo);
    if (bout?.status === 'TIE_PENDING') return false;
  }
  const remoteCount = match.remoteCount;
  match = makeMatch(
    match.matchNo + 1,
    match.red.name,
    match.blue.name,
    match.configuredRoundMs,
    match.red,
    match.blue
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
      playerName: String(input.playerName || input.name || '').trim().slice(0, 24),
      weightCategory: String(input.weightCategory || '').trim().slice(0, 32),
      stateCode,
      district: hasStateCode
        ? String(input.district || '').trim().slice(0, 48)
        : ''
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
        voteSettleGuard = { player, points, technical, expiresAt: Date.now() + VOTE_SETTLE_MS };
        addPoint(player, points, technical ? 'referee-technical' : 'referee', !technical);
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
        emit({ type: 'award', ...result });
        state(true);
        return result;
      }
    }
  }
  state(true);
  return { awarded: false };
}

function recordRefereeVote(corner, vote) {
  if (voteSettleGuard) {
    if (Date.now() >= voteSettleGuard.expiresAt) {
      voteSettleGuard = null;
    } else if (vote.player === voteSettleGuard.player && vote.points === voteSettleGuard.points &&
      Boolean(vote.technical) === Boolean(voteSettleGuard.technical)) {
      return { awarded: false, ignored: true, count: 3 };
    }
  }
  if (vote.button) showLastRemoteButton(corner, vote.button);
  match.votes[corner] = vote;
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
  if (protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    sendError(ws, 'UNSUPPORTED_PROTOCOL', `Expected remote protocol v${REMOTE_PROTOCOL_VERSION}`);
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
    if (String(msg.token || '') !== expectedToken) {
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
    sendError(ws, 'DEVICE_BUSY', `${deviceId} is already connected`);
    return;
  }

  const corner = Number(deviceId.slice(1));
  const previousSession = remoteSessions.get(deviceId);
  const session = previousSession && previousSession.sessionId === sessionId &&
    Date.now() - (previousSession.lastSeenAt || 0) <= REMOTE_SESSION_TTL_MS
    ? previousSession
    : { sessionId, lastSequence: 0, acks: new Map(), lastSeenAt: Date.now() };

  ws.role = 'remote';
  ws.deviceId = deviceId;
  ws.corner = corner;
  ws.sessionId = sessionId;
  ws.firmware = String(msg.firmware || '').slice(0, 32);
  ws.remoteSession = session;
  remoteSockets.set(deviceId, ws);
  remoteSessions.set(deviceId, session);
  updateRemoteStatus(ws, helloTelemetry, false);

  send(ws, {
    type: 'remote_ready',
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    deviceId,
    corner,
    sessionId
  });
  send(ws, remoteState(ws));
  state();
}

function handleRemoteEvent(ws, msg) {
  if (ws.role !== 'remote' || !ws.remoteSession) {
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
  if (sequence <= session.lastSequence) {
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'SEQUENCE_REPLAY' });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  session.lastSequence = sequence;

  const button = String(msg.button || '').toUpperCase();
  if (ws.corner > match.remoteCount) {
    const ack = remoteAck(ws, sequence, { accepted: false, reason: 'REMOTE_DISABLED', awarded: false });
    rememberRemoteAck(session, sequence, ack);
    return;
  }
  if (button === 'CANCEL') {
    if (recordCornerRefereePress(ws.corner, button)) state(true);
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
    state(true);
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
    match.test.presses[`${ws.corner}-${vote.button}`] = true;
    emit({ type: 'testPress', corner: ws.corner, player: vote.player, points: vote.points, button: vote.button });
    state();
    const ack = remoteAck(ws, sequence, { accepted: true, reason: 'TEST_PRESS_RECORDED', test: true, awarded: false });
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
        button: vote.button
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
        button: `${vote.player}_TECHNICAL_${vote.points}`
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
  if (historyEntry) state(true);
  const outcome = completeRemoteVote(ws, sequence, {
    ...vote,
    basePoints: vote.points,
    technical: false
  });
  if (technicalPointsFor(vote.points) !== null && !outcome.awarded) {
    rememberBasePress(ws.corner, vote, historyEntry);
  }
}

wss.on('connection', ws => {
  ws.role = 'unknown';
  ws.corner = 0;
  ws.deviceId = null;
  ws.sessionId = null;
  ws.remoteSession = null;
  ws.hostToken = null;
  ws.messageWindowStartedAt = Date.now();
  ws.messageCount = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  syncTimer();

  ws.on('message', raw => {
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
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
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
      if (ws.role === 'remote') {
        const hasTelemetry = Object.prototype.hasOwnProperty.call(msg, 'rssi') || Object.prototype.hasOwnProperty.call(msg, 'battery');
        updateRemoteStatus(ws, hasTelemetry ? msg : {}, hasTelemetry);
        send(ws, { type: 'remote_pong', deviceId: ws.deviceId });
      }
      else sendError(ws, 'REMOTE_NOT_AUTHENTICATED', 'Send remote_hello before remote_ping');
      return;
    }
    if (msg.type === 'role') {
      if (ws.role !== 'unknown') {
        sendError(ws, 'ROLE_ALREADY_ASSIGNED', 'This connection already has a role');
        return;
      }
      const kioskAuthorized = KIOSK_MODE && msg.role === 'host' && isLoopbackAddress(ws._socket?.remoteAddress);
      assignRole(ws, msg.role, Number(msg.corner), msg.accessToken, kioskAuthorized);
      return;
    }

    if (msg.type === 'host') {
      if (ws.role !== 'host') return;

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

      if (msg.action === 'playPause' && (match.phase === 'ROUND' || match.phase === 'BREAK')) {
        setRunning(!match.running);
      }
      if (msg.action === 'setTime') {
        const rawMs = Number(msg.ms);
        const ms = validInteger(rawMs) ? Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, rawMs)) : ROUND_MS_DEFAULT;
        if (match.phase === 'ROUND') setRunning(false);
        match.configuredRoundMs = ms;
        if (match.phase === 'ROUND') {
          match.timerMs = ms;
        }
      }
      if (msg.action === 'resetRoundTimer' && match.phase === 'ROUND') {
        setRunning(false);
        if (match.phase === 'ROUND') match.timerMs = match.configuredRoundMs;
      }
      if (msg.action === 'playerSettings') {
        const result = updatePlayerSettings(msg.players);
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
        const name = String(msg.name || '').trim().slice(0, 24);
        if (msg.player === 'RED') match.red.playerName = name;
        if (msg.player === 'BLUE') match.blue.playerName = name;
      }
      if (msg.action === 'editScore') {
        if (!validPlayer(msg.player) || !operatorScoringIsAllowed()) {
          sendError(ws, 'ROUND_NOT_ACTIVE', 'Scores can only be edited during a round');
          return;
        }
        const parsed = Number(msg.value);
        const value = validInteger(parsed) ? Math.max(0, parsed) : 0;
        if (msg.player === 'RED') match.red.score = value;
        if (msg.player === 'BLUE') match.blue.score = value;
        checkPointGap();
      }
      if (msg.action === 'editGamjeom') {
        if (!validPlayer(msg.player) || !operatorScoringIsAllowed()) {
          sendError(ws, 'ROUND_NOT_ACTIVE', 'Gam-jeom can only be edited during a round');
          return;
        }
        const parsed = Number(msg.value);
        const value = validInteger(parsed) ? Math.max(0, Math.min(rules.penalties.gamJeom.roundLossAt, parsed)) : 0;
        if (msg.player === 'RED') match.red.gamjeom = value;
        if (msg.player === 'BLUE') match.blue.gamjeom = value;
        if (value >= rules.penalties.gamJeom.roundLossAt) {
          endRound(other(msg.player), `${rules.penalties.gamJeom.roundLossAt} GAM-JEOM`);
        }
      }
      if (msg.action === 'point' && !addPoint(msg.player, Number(msg.points), 'manual', true, true)) {
        sendError(ws, 'ROUND_NOT_ACTIVE', 'Points can only be awarded during a round');
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
      if (msg.action === 'setRemoteMode') {
        const result = setRemoteCount(msg.count);
        if (!result.ok) {
          sendError(ws, result.code, result.message);
          return;
        }
      }
      if (msg.action === 'testStart') {
        setRunning(false);
        match.test.active = true;
        match.test.presses = {};
        match.votes = {};
        emit({ type: 'testReset' });
      }
      if (msg.action === 'testStop') {
        resetTest();
        return;
      }
      state(true);
      return;
    }

    if (msg.type === 'ref') {
      if (ws.role !== 'referee' || ws.corner < 1 || ws.corner > 4) return;
      if (ws.corner > match.remoteCount) return;
      const player = msg.player;
      const points = Number(msg.points);

      if (msg.action === 'vote' && validPlayer(player) && validPoints(points)) {
        if (recordCornerRefereePress(ws.corner, cornerRefereeButtonLabel(player, points), points)) state(true);
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
        if (recordCornerRefereePress(ws.corner, 'CANCEL')) state(true);
        delete match.votes[ws.corner];
        state(true);
      }
    }
  });

  ws.on('error', error => {
    console.error('WebSocket connection error:', error.message);
  });
  ws.on('close', () => {
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
  const displayInterval = match.kyeShi.active ||
    (match.phase === 'ROUND' && match.running && match.timerMs <= 10_000)
    ? TIMER_DISPLAY_UPDATE_MS
    : 900;
  if (changed && Date.now() - lastStateAt >= displayInterval) state();
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
  console.log(`${signal} received; shutting down`);
  if (pendingSystemPower) {
    clearTimeout(pendingSystemPower.timer);
    pendingSystemPower = null;
  }
  try {
    await persistence.flush(persistenceSnapshot());
  } catch (error) {
    console.error(`Could not flush saved state during shutdown: ${error.message}`);
  }
  await persistence.release();
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Taekwondo Scorer v3 running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Wi-Fi:  http://${getLocalIPv4()}:${PORT}`);
  const configuredRemoteIds = [...REMOTE_IDS].filter(deviceId => expectedRemoteToken(deviceId));
  console.log(`Remote authentication configured for: ${configuredRemoteIds.join(', ') || 'none'}`);
  console.log(`Host access token: ${hostAccessToken}`);
  if (KIOSK_MODE) console.log('Kiosk mode: localhost host access is enabled');
});
