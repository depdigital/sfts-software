import express from "express";
import crypto from "node:crypto";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import * as XLSX from "xlsx";
import { createTts } from "./tts.js";

const PORT = Number(process.env.PORT || 8080);
const ROUND_MS_DEFAULT = 60_000;
const BREAK_MS_DEFAULT = 35_000;
const MAX_TIMER_MS = 60 * 60 * 1000;
const TIMER_TICK_MS = 250;
const HEARTBEAT_MS = 10_000;
const MAX_WS_PAYLOAD = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_TOURNAMENT_PLAYERS = 500;
const MAX_SCHEDULE_BOUTS = 5000;
const REMOTE_PROTOCOL_VERSION = 1;
const REMOTE_IDS = new Set(['C1', 'C2', 'C3', 'C4']);
const REMOTE_ACK_CACHE_SIZE = 100;
const INDIAN_STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CG', 'DD', 'DL', 'DN', 'GA', 'GJ',
  'HR', 'HP', 'JK', 'JH', 'KA', 'KL', 'LA', 'LD', 'MP', 'MH', 'MN', 'ML',
  'MZ', 'NL', 'OD', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TS', 'TR', 'UK', 'UP', 'WB'
]);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD });
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const tts = createTts();
app.use(express.static(publicDir));

app.get('/api/tts/audio/:file', (req, res) => {
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

const baseStats = () => ({ plus1: 0, plus2: 0, plus3: 0 });
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
    running: false,
    phase: "ROUND", // ROUND | BREAK | MATCH_END
    red: makeSide(redName, redProfile),
    blue: makeSide(blueName, blueProfile),
    votes: {},
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
    format: 'ROUND_ROBIN',
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
  return `Bout ${bout.boutNo}: ${bout.redPlayerName} vs ${bout.bluePlayerName}, ${bout.gender}, ${bout.weightCategory}`;
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
  const expectedBouts = groups.reduce((total, [, groupPlayers]) => (
    total + (groupPlayers.length * Math.max(0, groupPlayers.length - 1)) / 2
  ), 0);
  if (expectedBouts > MAX_SCHEDULE_BOUTS) {
    throw new TournamentImportError(`The generated round-robin schedule would contain ${expectedBouts} bouts; maximum is ${MAX_SCHEDULE_BOUTS}`);
  }
  const schedule = [];
  const byes = [];
  const tournamentGroups = [];
  let boutNo = 1;

  groups.forEach(([, groupPlayers], groupIndex) => {
    const ordered = shuffled(groupPlayers, random);
    const circle = [...ordered];
    if (circle.length % 2 === 1) circle.push(null);
    const rounds = Math.max(1, circle.length - 1);
    const group = {
      id: `G${String(groupIndex + 1).padStart(3, '0')}`,
      gender: groupPlayers[0].gender,
      weightCategory: groupPlayers[0].weightCategory,
      playerIds: groupPlayers.map(player => player.id),
      byePlayerIds: [],
      matchCount: 0
    };

    for (let round = 1; round <= rounds; round += 1) {
      const pairCount = circle.length / 2;
      for (let pair = 0; pair < pairCount; pair += 1) {
        const first = circle[pair];
        const second = circle[circle.length - 1 - pair];
        if (!first || !second) {
          const bye = first || second;
          if (bye) {
            group.byePlayerIds.push(bye.id);
            byes.push({
              groupId: group.id,
              gender: group.gender,
              weightCategory: group.weightCategory,
              round,
              playerId: bye.id,
              playerName: bye.name,
              announcement: `${bye.name} receives a bye in round ${round}, ${group.gender}, ${group.weightCategory}`
            });
          }
          continue;
        }
        const red = random() < 0.5 ? first : second;
        const blue = red === first ? second : first;
        const bout = {
          boutNo,
          groupId: group.id,
          gender: group.gender,
          weightCategory: group.weightCategory,
          round,
          redPlayerId: red.id,
          redPlayerName: red.name,
          bluePlayerId: blue.id,
          bluePlayerName: blue.name,
          status: 'SCHEDULED',
          winner: null,
          winnerName: null,
          announcement: ''
        };
        bout.announcement = scheduleAnnouncement(bout);
        schedule.push(bout);
        group.matchCount += 1;
        boutNo += 1;
      }
      const last = circle.pop();
      circle.splice(1, 0, last);
    }
    tournamentGroups.push(group);
  });

  return {
    format: 'ROUND_ROBIN',
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
let matchHistory = [];
let tournament = makeTournament();
let hostSocket = null;
const refereeSockets = new Map();
const remoteSockets = new Map();
const remoteSessions = new Map();
let timerLastAt = null;
let lastStateAt = 0;

function deep(v) { return JSON.parse(JSON.stringify(v)); }
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
  return { type: "state", match: deep(match), matchHistory: deep(matchHistory), tournament: deep(tournament) };
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
    red: { score: match.red.score, gamjeom: match.red.gamjeom },
    blue: { score: match.blue.score, gamjeom: match.blue.gamjeom },
    votes: deep(match.votes)
  };
}
function state() {
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
  return match.test.active || match.running || match.phase === 'BREAK' || (
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
  match = makeMatch(
    match.matchNo,
    red.name,
    blue.name,
    match.configuredRoundMs,
    { ...red, playerName: red.name },
    { ...blue, playerName: blue.name }
  );
  timerLastAt = null;
  bout.status = 'IN_PROGRESS';
  tournament.activeBoutNo = bout.boutNo;
  return { ok: true };
}

function completeTournamentBout(winner) {
  if (!tournament.activeBoutNo) return;
  const bout = findTournamentBout(tournament.activeBoutNo);
  if (!bout) return;
  bout.status = 'COMPLETED';
  bout.winner = winner === 'RED' ? bout.redPlayerId : winner === 'BLUE' ? bout.bluePlayerId : null;
  bout.winnerName = winner === 'RED' ? bout.redPlayerName : winner === 'BLUE' ? bout.bluePlayerName : null;
  tournament.activeBoutNo = null;
}

async function announceTournamentBout(bout) {
  let audio = null;
  try {
    audio = await tts.synthesize(bout.announcement);
  } catch (error) {
    console.error('Local TTS failed:', error.message);
  }
  emit({
    type: 'announcement',
    boutNo: bout.boutNo,
    text: bout.announcement,
    ...(audio ? { audioUrl: `/api/tts/audio/${audio.fileName}` } : {})
  });
}

app.post('/api/tournament/import', requireHostRequest, express.raw({ type: '*/*', limit: MAX_IMPORT_BYTES }), (req, res) => {
  if (tournamentMatchIsBusy()) {
    res.status(409).json({ ok: false, message: 'Finish or reset the current match before importing a new player sheet' });
    return;
  }
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const players = importTournamentPlayers(buffer);
    tournament = generateTournament(players);
    state();
    res.json({ ok: true, tournament: deep(tournament) });
  } catch (error) {
    const details = error instanceof TournamentImportError ? error.errors : [];
    res.status(400).json({ ok: false, message: error.message || 'Player sheet import failed', errors: details });
  }
});

app.get('/api/tournament/template.xlsx', requireHostRequest, (req, res) => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([{
    'Player ID': 'P001',
    Name: 'Example Player',
    Gender: 'MALE',
    'Weight Category': '-58 kg',
    'State Code': 'DL',
    District: 'New Delhi',
    Club: 'Example Club'
  }]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Players');
  const output = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
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
  return Number.isInteger(points) && [1, 2, 3].includes(points);
}

function validInteger(value) {
  return Number.isInteger(value) && Number.isFinite(value);
}

function validRemoteSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

function remoteButton(button) {
  const matchButton = /^((?:RED|BLUE))_([123])$/.exec(String(button || '').toUpperCase());
  if (!matchButton) return null;
  return { player: matchButton[1], points: Number(matchButton[2]) };
}

function expectedRemoteToken(deviceId) {
  return process.env[`SFTS_REMOTE_TOKEN_${deviceId}`] || null;
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
  return match.phase === 'ROUND' && !match.test.active;
}

function syncTimer(now = performance.now()) {
  if (!match.running || timerLastAt === null) return false;
  const elapsed = Math.max(0, now - timerLastAt);
  if (!elapsed) return false;

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
    return;
  }
  if (match.timerMs <= 0) return;
  match.running = true;
  timerLastAt = performance.now();
}

function releaseRole(ws) {
  if (hostSocket === ws) hostSocket = null;
  if (ws.role === 'referee' && refereeSockets.get(ws.corner) === ws) {
    refereeSockets.delete(ws.corner);
    if (match.votes[ws.corner]) {
      delete match.votes[ws.corner];
      state();
    }
  }
  if (ws.role === 'remote' && remoteSockets.get(ws.deviceId) === ws) {
    remoteSockets.delete(ws.deviceId);
    if (match.votes[ws.corner]) {
      delete match.votes[ws.corner];
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

function assignRole(ws, role, corner) {
  if (role === 'host') {
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

function checkPointGap() {
  if (match.phase !== "ROUND") return;
  const diff = Math.abs(match.red.score - match.blue.score);
  if (diff >= 15) {
    const winner = match.red.score > match.blue.score ? "RED" : "BLUE";
    endRound(winner, "15-POINT GAP");
  }
}

function addPoint(player, points, source = "manual", countAsHit = true) {
  if (!validPlayer(player) || !validPoints(points) || !scoringIsAllowed()) return false;
  side(player).score += points;
  if (countAsHit) addHitStat(player, points);
  emit({ type: 'scoreSound', player, points, source });
  checkPointGap();
  return true;
}

function addGamjeom(player) {
  if (!validPlayer(player) || !scoringIsAllowed()) return false;
  const penalized = side(player);
  penalized.gamjeom += 1;
  const opponent = other(player);
  side(opponent).score += 1;
  emit({ type: 'scoreSound', player: opponent, points: 1, source: 'gamjeom' });
  if (penalized.gamjeom >= 5) {
    endRound(opponent, '5 GAM-JEOM');
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
  state();
}

function finishMatch(winner, reason) {
  match.running = false;
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
    endedAt: new Date().toISOString()
  });
  matchHistory = matchHistory.slice(0, 50);
  emit({ type: 'matchEnd', winner, reason, match: deep(match) });
  state();
}

function startNextRound() {
  if (match.phase !== 'BREAK') return;
  match.round += 1;
  match.phase = 'ROUND';
  match.timerMs = match.configuredRoundMs;
  match.running = false;
  timerLastAt = null;
  match.red.score = 0;
  match.red.gamjeom = 0;
  match.red.stats = baseStats();
  match.blue.score = 0;
  match.blue.gamjeom = 0;
  match.blue.stats = baseStats();
  match.votes = {};
  state();
}

function resetCurrentMatch() {
  if (tournament.activeBoutNo) {
    const bout = findTournamentBout(tournament.activeBoutNo);
    if (bout && bout.status === 'IN_PROGRESS') bout.status = 'SCHEDULED';
    tournament.activeBoutNo = null;
  }
  match = makeMatch(
    match.matchNo,
    match.red.name,
    match.blue.name,
    match.configuredRoundMs,
    match.red,
    match.blue
  );
  timerLastAt = null;
  state();
}

function newMatch() {
  match = makeMatch(
    match.matchNo + 1,
    match.red.name,
    match.blue.name,
    match.configuredRoundMs,
    match.red,
    match.blue
  );
  timerLastAt = null;
  state();
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
  for (const player of ['RED', 'BLUE']) {
    for (const points of [1,2,3]) {
      const total = Object.values(match.votes).filter(v => v.player === player && v.points === points).length;
      if (total >= 3) {
        addPoint(player, points, 'referee', true);
        match.votes = {};
        const result = { awarded: true, player, points, count: total };
        emit({ type: 'award', player, points, count: total });
        state();
        return result;
      }
    }
  }
  state();
  return { awarded: false };
}

function resetTest() {
  match.test.active = false;
  match.test.presses = {};
  emit({ type: 'testReset' });
  state();
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
  if (!expectedToken && !allowUnpaired) {
    sendError(ws, 'REMOTE_NOT_CONFIGURED', `No token configured for ${deviceId}`);
    return;
  }
  if (expectedToken && String(msg.token || '') !== expectedToken) {
    sendError(ws, 'UNAUTHORIZED_REMOTE', 'Remote authentication failed');
    return;
  }
  const existing = remoteSockets.get(deviceId);
  if (existing && existing !== ws && existing.readyState === 1) {
    sendError(ws, 'DEVICE_BUSY', `${deviceId} is already connected`);
    return;
  }

  const corner = Number(deviceId.slice(1));
  const previousSession = remoteSessions.get(deviceId);
  const session = previousSession && previousSession.sessionId === sessionId
    ? previousSession
    : { sessionId, lastSequence: 0, acks: new Map() };

  ws.role = 'remote';
  ws.deviceId = deviceId;
  ws.corner = corner;
  ws.sessionId = sessionId;
  ws.firmware = String(msg.firmware || '').slice(0, 32);
  ws.remoteSession = session;
  remoteSockets.set(deviceId, ws);
  remoteSessions.set(deviceId, session);

  send(ws, {
    type: 'remote_ready',
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    deviceId,
    corner,
    sessionId
  });
  send(ws, remoteState(ws));
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
  if (button === 'CANCEL') {
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
    delete match.votes[ws.corner];
    state();
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
    match.test.presses[`${ws.corner}-${vote.player}-${vote.points}`] = true;
    emit({ type: 'testPress', corner: ws.corner, player: vote.player, points: vote.points });
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

  match.votes[ws.corner] = vote;
  const voteCount = Object.values(match.votes)
    .filter(item => item.player === vote.player && item.points === vote.points).length;
  const outcome = evaluateVotes();
  const ack = remoteAck(ws, sequence, {
    accepted: true,
    reason: outcome.awarded ? 'POINT_AWARDED' : 'VOTE_RECORDED',
    awarded: outcome.awarded,
    voteCount: outcome.awarded ? outcome.count : voteCount
  });
  rememberRemoteAck(session, sequence, ack);
}

wss.on('connection', ws => {
  ws.role = 'unknown';
  ws.corner = 0;
  ws.deviceId = null;
  ws.sessionId = null;
  ws.remoteSession = null;
  ws.hostToken = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  syncTimer();

  ws.on('message', raw => {
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
    if (msg.type === 'remote_ping') {
      if (ws.role === 'remote') send(ws, { type: 'remote_pong', deviceId: ws.deviceId });
      else sendError(ws, 'REMOTE_NOT_AUTHENTICATED', 'Send remote_hello before remote_ping');
      return;
    }
    if (msg.type === 'role') {
      if (ws.role !== 'unknown') {
        sendError(ws, 'ROLE_ALREADY_ASSIGNED', 'This connection already has a role');
        return;
      }
      assignRole(ws, msg.role, Number(msg.corner));
      return;
    }

    if (msg.type === 'host') {
      if (ws.role !== 'host') return;

      if (msg.action === 'playPause' && (match.phase === 'ROUND' || match.phase === 'BREAK')) {
        setRunning(!match.running);
      }
      if (msg.action === 'setTime') {
        const rawMs = Number(msg.ms);
        const ms = validInteger(rawMs) ? Math.min(MAX_TIMER_MS, Math.max(1000, rawMs)) : ROUND_MS_DEFAULT;
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
        if (!validPlayer(msg.player) || !scoringIsAllowed()) {
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
        if (!validPlayer(msg.player) || !scoringIsAllowed()) {
          sendError(ws, 'ROUND_NOT_ACTIVE', 'Gam-jeom can only be edited during a round');
          return;
        }
        const parsed = Number(msg.value);
        const value = validInteger(parsed) ? Math.max(0, Math.min(5, parsed)) : 0;
        if (msg.player === 'RED') match.red.gamjeom = value;
        if (msg.player === 'BLUE') match.blue.gamjeom = value;
        if (value >= 5) endRound(other(msg.player), '5 GAM-JEOM');
      }
      if (msg.action === 'point' && !addPoint(msg.player, Number(msg.points), 'manual', true)) {
        sendError(ws, 'ROUND_NOT_ACTIVE', 'Points can only be awarded during a round');
      }
      if (msg.action === 'gamjeom' && !addGamjeom(msg.player)) {
        sendError(ws, 'ROUND_NOT_ACTIVE', 'Gam-jeom can only be awarded during a round');
      }
      if (msg.action === 'nextRound') startNextRound();
      if (msg.action === 'resetMatch') resetCurrentMatch();
      if (msg.action === 'newMatch') {
        if (match.phase !== 'MATCH_END') {
          sendError(ws, 'MATCH_NOT_ENDED', 'A new match can only start after match end');
          return;
        }
        newMatch();
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
        void announceTournamentBout(bout);
        return;
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
      state();
      return;
    }

    if (msg.type === 'ref') {
      if (ws.role !== 'referee' || ws.corner < 1 || ws.corner > 4) return;
      const player = msg.player;
      const points = Number(msg.points);

      if (msg.action === 'vote' && validPlayer(player) && validPoints(points)) {
        if (match.test.active) {
          match.test.presses[`${ws.corner}-${player}-${points}`] = true;
          emit({ type: 'testPress', corner: ws.corner, player, points });
          state();
          return;
        }
        if (match.phase !== 'ROUND') return;
        match.votes[ws.corner] = { player, points };
        evaluateVotes();
        return;
      }

      if (msg.action === 'cancel' && !match.test.active) {
        delete match.votes[ws.corner];
        state();
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
      state();
    }
    if (wasHost && match.test.active) resetTest();
  });
});

setInterval(() => {
  const changed = syncTimer();
  if (changed && Date.now() - lastStateAt >= 900) state();
}, TIMER_TICK_MS);

setInterval(() => {
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

function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
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
});
