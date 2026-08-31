import express from "express";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const ROUND_MS_DEFAULT = 60_000;
const BREAK_MS_DEFAULT = 35_000;
const MAX_TIMER_MS = 60 * 60 * 1000;
const TIMER_TICK_MS = 250;
const HEARTBEAT_MS = 10_000;
const MAX_WS_PAYLOAD = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const REMOTE_PROTOCOL_VERSION = 1;
const REMOTE_IDS = new Set(['C1', 'C2', 'C3', 'C4']);
const REMOTE_ACK_CACHE_SIZE = 100;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD });
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(publicDir));

function getLocalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "localhost";
}

app.get("/api/info", async (_req, res) => {
  try {
    const url = `http://${getLocalIPv4()}:${PORT}/`;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 360 });
    res.json({ url, qr });
  } catch (error) {
    console.error('QR generation failed:', error.message);
    res.status(500).json({ error: 'Unable to generate connection QR code' });
  }
});

const baseStats = () => ({ plus1: 0, plus2: 0, plus3: 0 });
function makeSide(name) {
  return { name, score: 0, gamjeom: 0, stats: baseStats() };
}
function makeMatch(matchNo = 1, redName = "HONG", blueName = "CHUNG", roundMs = ROUND_MS_DEFAULT) {
  return {
    matchNo,
    round: 1,
    configuredRoundMs: roundMs,
    timerMs: roundMs,
    breakMs: BREAK_MS_DEFAULT,
    running: false,
    phase: "ROUND", // ROUND | BREAK | MATCH_END
    red: makeSide(redName),
    blue: makeSide(blueName),
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

let match = makeMatch();
let matchHistory = [];
let hostSocket = null;
const refereeSockets = new Map();
const remoteSockets = new Map();
const remoteSessions = new Map();
let timerLastAt = null;
let lastStateAt = 0;

function deep(v) { return JSON.parse(JSON.stringify(v)); }
function sendText(ws, text, label = 'send') {
  if (!ws || ws.readyState !== 1) return false;
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
function broadcast(text, label) {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      console.error(`Closing slow WebSocket client during ${label}`);
      ws.terminate();
      continue;
    }
    sendText(ws, text, label);
  }
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
  const payload = { type: "state", match: deep(match), matchHistory: deep(matchHistory) };
  const text = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.role === 'remote') sendText(ws, JSON.stringify(remoteState(ws)), 'remote state broadcast');
    else sendText(ws, text, 'state broadcast');
  }
  lastStateAt = Date.now();
}
function emit(message) {
  const text = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.role !== 'remote') sendText(ws, text, 'broadcast');
  }
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message });
}

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

function syncTimer(now = Date.now()) {
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
  timerLastAt = Date.now();
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
    send(ws, { type: 'roleAccepted', role: 'host' });
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
  matchHistory.unshift({
    matchNo: match.matchNo,
    redName: match.red.name,
    blueName: match.blue.name,
    winner,
    winnerName: winner ? side(winner).name : 'DRAW',
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
  match = makeMatch(match.matchNo, match.red.name, match.blue.name, match.configuredRoundMs);
  timerLastAt = null;
  state();
}

function newMatch() {
  match = makeMatch(match.matchNo + 1, match.red.name, match.blue.name, match.configuredRoundMs);
  timerLastAt = null;
  state();
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

  const deviceId = String(msg.deviceId || '').toUpperCase();
  const sessionId = String(msg.sessionId || '');
  const protocolVersion = Number(msg.protocolVersion);
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

  const sequence = Number(msg.sequence);
  if (String(msg.deviceId || '').toUpperCase() !== ws.deviceId || String(msg.sessionId || '') !== ws.sessionId) {
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
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  syncTimer();
  send(ws, { type: 'state', match: deep(match), matchHistory: deep(matchHistory) });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

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
      if (msg.action === 'name') {
        if (!validPlayer(msg.player)) {
          sendError(ws, 'INVALID_PLAYER', 'Invalid player');
          return;
        }
        const name = String(msg.name || '').trim().slice(0, 24) || (msg.player === 'RED' ? 'HONG' : 'CHUNG');
        if (msg.player === 'RED') match.red.name = name;
        if (msg.player === 'BLUE') match.blue.name = name;
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
      if (msg.action === 'testStart') {
        setRunning(false);
        match.test.active = true;
        match.test.presses = {};
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
