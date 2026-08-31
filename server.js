import express from "express";
import http from "http";
import os from "os";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const ROUND_MS_DEFAULT = 60_000;
const BREAK_MS_DEFAULT = 35_000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static("public"));

function getLocalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "localhost";
}

app.get("/api/info", async (_req, res) => {
  const url = `http://${getLocalIPv4()}:${PORT}/`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 360 });
  res.json({ url, qr });
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

function deep(v) { return JSON.parse(JSON.stringify(v)); }
function state() {
  const payload = { type: "state", match: deep(match), matchHistory: deep(matchHistory) };
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }
}
function emit(message) {
  const text = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(text);
  }
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
  if (!['RED', 'BLUE'].includes(player)) return;
  if (![1,2,3].includes(points)) return;
  side(player).score += points;
  if (countAsHit) addHitStat(player, points);
  emit({ type: 'scoreSound', player, points, source });
  checkPointGap();
}

function addGamjeom(player) {
  if (!['RED', 'BLUE'].includes(player)) return;
  const penalized = side(player);
  penalized.gamjeom += 1;
  const opponent = other(player);
  side(opponent).score += 1;
  emit({ type: 'scoreSound', player: opponent, points: 1, source: 'gamjeom' });
  if (penalized.gamjeom >= 5) {
    endRound(opponent, '5 GAM-JEOM');
    return;
  }
  checkPointGap();
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
  match.running = true;
  state();
}

function finishMatch(winner, reason) {
  match.running = false;
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
  state();
}

function newMatch() {
  match = makeMatch(match.matchNo + 1, match.red.name, match.blue.name, match.configuredRoundMs);
  state();
}

function evaluateVotes() {
  for (const player of ['RED', 'BLUE']) {
    for (const points of [1,2,3]) {
      const total = Object.values(match.votes).filter(v => v.player === player && v.points === points).length;
      if (total >= 3) {
        addPoint(player, points, 'referee', true);
        match.votes = {};
        emit({ type: 'award', player, points, count: total });
        state();
        return;
      }
    }
  }
  state();
}

function resetTest() {
  match.test.active = false;
  match.test.presses = {};
  emit({ type: 'testReset' });
  state();
}

wss.on('connection', ws => {
  ws.role = 'unknown';
  ws.corner = 0;
  ws.send(JSON.stringify({ type: 'state', match: deep(match), matchHistory: deep(matchHistory) }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === 'role') {
      ws.role = msg.role;
      ws.corner = Math.max(1, Math.min(4, Number(msg.corner || 0)));
      return;
    }

    if (msg.type === 'host') {
      if (ws.role !== 'host') return;

      if (msg.action === 'playPause' && (match.phase === 'ROUND' || match.phase === 'BREAK')) {
        match.running = !match.running;
      }
      if (msg.action === 'setTime') {
        const ms = Math.max(1000, Math.floor(Number(msg.ms) || ROUND_MS_DEFAULT));
        match.configuredRoundMs = ms;
        if (match.phase === 'ROUND') {
          match.timerMs = ms;
          match.running = false;
        }
      }
      if (msg.action === 'resetRoundTimer' && match.phase === 'ROUND') {
        match.timerMs = match.configuredRoundMs;
        match.running = false;
      }
      if (msg.action === 'name') {
        const name = String(msg.name || '').trim().slice(0, 24) || (msg.player === 'RED' ? 'HONG' : 'CHUNG');
        if (msg.player === 'RED') match.red.name = name;
        if (msg.player === 'BLUE') match.blue.name = name;
      }
      if (msg.action === 'editScore') {
        const value = Math.max(0, Math.floor(Number(msg.value) || 0));
        if (msg.player === 'RED') match.red.score = value;
        if (msg.player === 'BLUE') match.blue.score = value;
        checkPointGap();
      }
      if (msg.action === 'editGamjeom') {
        const value = Math.max(0, Math.min(5, Math.floor(Number(msg.value) || 0)));
        if (msg.player === 'RED') match.red.gamjeom = value;
        if (msg.player === 'BLUE') match.blue.gamjeom = value;
        if (value >= 5) endRound(other(msg.player), '5 GAM-JEOM');
      }
      if (msg.action === 'point') addPoint(msg.player, Number(msg.points), 'manual', true);
      if (msg.action === 'gamjeom') addGamjeom(msg.player);
      if (msg.action === 'nextRound') startNextRound();
      if (msg.action === 'resetMatch') resetCurrentMatch();
      if (msg.action === 'newMatch') newMatch();
      if (msg.action === 'testStart') {
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

      if (msg.action === 'vote' && ['RED', 'BLUE'].includes(player) && [1,2,3].includes(points)) {
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
});

setInterval(() => {
  if (!match.running) return;
  match.timerMs -= 1000;
  if (match.timerMs <= 0) {
    match.timerMs = 0;
    match.running = false;
    if (match.phase === 'ROUND') endRound(null, 'TIME 0:00');
    else if (match.phase === 'BREAK') startNextRound();
    return;
  }
  state();
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Taekwondo Scorer v3 running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Wi-Fi:  http://${getLocalIPv4()}:${PORT}`);
});
