import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 32000 + (process.pid % 1000);
const hostToken = 'score-count-test-host';

function message(socket, predicate, timeoutMs = 5000) {
  const index = socket.messages.findIndex(predicate);
  if (index >= 0) return Promise.resolve(socket.messages.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    waiter.timer = setTimeout(() => {
      socket.waiters.splice(socket.waiters.indexOf(waiter), 1);
      reject(new Error('Timed out waiting for scoring message'));
    }, timeoutMs);
    socket.waiters.push(waiter);
  });
}

async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.messages = [];
  socket.waiters = [];
  socket.on('message', raw => {
    const value = JSON.parse(String(raw));
    const index = socket.waiters.findIndex(waiter => waiter.predicate(value));
    if (index < 0) return socket.messages.push(value);
    const [waiter] = socket.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

const send = (socket, value) => socket.send(JSON.stringify(value));
const emptyStats = () => ({ plus1: 0, plus2: 0, plus3: 0, technicalChest: 0, technicalHead: 0 });

function assertReconciled(record) {
  for (const [player, opponent] of [['red', 'blue'], ['blue', 'red']]) {
    const stats = record[player].stats;
    assert.equal(record[player].score,
      stats.plus1 + 2 * stats.plus2 + 3 * stats.plus3 +
      4 * stats.technicalChest + 6 * stats.technicalHead + record[opponent].gamjeom,
      `${player} score must include every counted action and opponent penalty`);
  }
}

test('finishing awards keep scores, counts, broadcasts and saved history consistent', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-score-count-'));
  const clients = [];
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port), SFTS_DATA_DIR: dataDir,
      SFTS_RULES_FILE: path.join(projectRoot, 'config', 'rules.default.json'),
      SFTS_BREAK_MS: '60000', SFTS_HOST_TOKEN: hostToken,
      SFTS_ALLOW_UNPAIRED_REMOTES: 'true', SFTS_USB_IMPORT_ONLY: 'false',
      SFTS_TTS_ENGINE: 'browser'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    for (const socket of clients) socket.terminate();
    if (server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5000);
    server.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('running on port')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', chunk => { output += String(chunk); });
    server.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}: ${output}`));
    });
  });

  const host = await connect();
  clients.push(host);
  send(host, { type: 'role', role: 'host', accessToken: hostToken });
  await message(host, msg => msg.type === 'roleAccepted');
  await message(host, msg => msg.type === 'state');
  const remotes = [];
  for (let corner = 1; corner <= 4; corner += 1) {
    const socket = await connect();
    clients.push(socket);
    const remote = { socket, deviceId: `C${corner}`, sessionId: `score-count-${corner}`, sequence: 0 };
    send(socket, { type: 'remote_hello', protocolVersion: 2,
      deviceId: remote.deviceId, sessionId: remote.sessionId });
    await message(socket, msg => msg.type === 'remote_ready');
    remotes.push(remote);
  }

  async function hostAction(action, fields, predicate) {
    host.messages = [];
    send(host, { type: 'host', action, ...fields });
    return message(host, msg => msg.type === 'state' && predicate(msg));
  }
  async function reset(remoteCount) {
    await hostAction('resetMatch', {}, msg => msg.match.round === 1 && !msg.match.running);
    await hostAction('setRemoteMode', { count: remoteCount }, msg => msg.match.remoteCount === remoteCount);
  }
  async function start(round) {
    await hostAction('playPause', {}, msg => msg.match.running && msg.match.round === round);
  }
  async function next(round) {
    await hostAction('nextRound', {}, msg => msg.match.phase === 'ROUND' && msg.match.round === round);
    await start(round);
  }
  async function press(remote, button) {
    const sequence = ++remote.sequence;
    send(remote.socket, { type: 'remote_event', deviceId: remote.deviceId,
      sessionId: remote.sessionId, sequence, button, ageMs: 0 });
    const ack = await message(remote.socket, msg => msg.type === 'remote_event_ack' && msg.sequence === sequence);
    assert.equal(ack.accepted, true, ack.reason);
    return ack;
  }
  async function award(player, basePoints, technical, remoteCount, input = 'combined') {
    const required = Math.floor(remoteCount / 2) + 1;
    for (const remote of remotes.slice(0, required)) {
      if (technical && input === 'paired') {
        assert.equal((await press(remote, `${player}_TECHNICAL`)).reason, 'TECHNICAL_PENDING');
      }
      const button = technical && input === 'combined'
        ? `${player}_TECHNICAL_${basePoints}` : `${player}_${basePoints}`;
      await press(remote, button);
    }
    const result = await message(host, msg => msg.type === 'award');
    assert.equal(result.player, player);
    assert.equal(result.points, technical ? (basePoints === 2 ? 4 : 6) : basePoints);
  }
  async function checkRound(player, score, expectedStats, round = 1) {
    const { record } = await message(host, msg => msg.type === 'roundEnd' && msg.record.round === round);
    assert.equal(record.winner, player);
    assert.equal(record[player.toLowerCase()].score, score);
    assert.deepEqual(record[player.toLowerCase()].stats, { ...emptyStats(), ...expectedStats });
    assertReconciled(record);
    return record;
  }

  const cases = [
    { name: 'screenshot 1: three technical head kicks', actions: [[3, true], [3, true], [3, true]],
      score: 18, stats: { technicalHead: 3 } },
    { name: 'screenshot 2: normal head and two technical head kicks', actions: [[3, false], [3, true], [3, true]],
      score: 15, stats: { plus3: 1, technicalHead: 2 }, input: 'paired' },
    { name: 'four technical chest kicks', actions: Array.from({ length: 4 }, () => [2, true]),
      score: 16, stats: { technicalChest: 4 } }
  ];
  for (const remoteCount of [1, 2, 3, 4]) {
    for (const player of ['RED', 'BLUE']) {
      for (const scenario of cases) {
        await t.test(`${remoteCount} remotes / ${player} / ${scenario.name}`, async () => {
          await reset(remoteCount);
          await start(1);
          for (const [points, technical] of scenario.actions) {
            await award(player, points, technical, remoteCount, scenario.input);
          }
          const record = await checkRound(player, scenario.score, scenario.stats);
          const state = await message(host, msg => msg.type === 'state' && msg.match.phase === 'BREAK');
          assert.deepEqual(state.match.roundHistory[0], record);
          assert.deepEqual(state.match[player.toLowerCase()], record[player.toLowerCase()]);
        });
      }
    }
  }

  await t.test('match-winning technical kick reaches every saved copy exactly once', async () => {
    await reset(4);
    await start(1);
    for (let round = 1; round <= 2; round += 1) {
      if (round === 2) await next(2);
      for (let hit = 0; hit < 3; hit += 1) await award('RED', 3, true, 4);
      await checkRound('RED', 18, { technicalHead: 3 }, round);
    }
    const ended = await message(host, msg => msg.type === 'matchEnd');
    assert.equal(ended.winner, 'RED');
    assert.deepEqual(ended.match.red.stats, { ...emptyStats(), technicalHead: 3 });
    ended.match.roundHistory.forEach(assertReconciled);
    const state = await message(host, msg => msg.type === 'state' && msg.match.phase === 'MATCH_END');
    const id = state.matchHistory[0].id;
    let saved;
    const deadline = Date.now() + 5000;
    do {
      try { saved = JSON.parse(await readFile(path.join(dataDir, 'sfts-state.json'), 'utf8')); } catch {}
      if (saved?.matchHistory?.[0]?.id === id) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(saved?.matchHistory?.[0]?.id, id, 'completed match must be persisted');
    const archived = saved.matchHistory[0];
    assert.equal(archived.red.stats.technicalHead, 3);
    assertReconciled(archived);
    assert.equal(archived.rounds.length, 2);
    archived.rounds.forEach(record => {
      assert.equal(record.red.stats.technicalHead, 3);
      assertReconciled(record);
    });
  });

  for (const [player, basePoints] of [['RED', 2], ['BLUE', 3]]) {
    await t.test(`golden round / ${player} / technical ${basePoints}`, async () => {
      await reset(1);
      await start(1);
      for (let hit = 0; hit < 3; hit += 1) await award('RED', 3, true, 1);
      await checkRound('RED', 18, { technicalHead: 3 });
      await next(2);
      for (let hit = 0; hit < 3; hit += 1) await award('BLUE', 3, true, 1);
      await checkRound('BLUE', 18, { technicalHead: 3 }, 2);
      await hostAction('nextRound', {}, msg => msg.match.round === 3 && msg.match.phase === 'ROUND');
      await hostAction('setTime', { ms: 1000 }, msg => msg.match.timerMs === 1000);
      await start(3);
      await message(host, msg => msg.type === 'state' && msg.match.tieDecision?.mode === 'CHOOSE_METHOD');
      await hostAction('startGoldenRound', {}, msg => msg.match.breakTarget === 'GOLDEN');
      await next(4);
      await award(player, basePoints, true, 1);
      const record = await checkRound(player, basePoints === 2 ? 4 : 6,
        basePoints === 2 ? { technicalChest: 1 } : { technicalHead: 1 }, 4);
      assert.equal(record.goldenRound, true);
      const ended = await message(host, msg => msg.type === 'matchEnd');
      assert.equal(ended.winner, player);
      assert.deepEqual(ended.match.roundHistory.at(-1), record);
      assert.deepEqual(ended.match[player.toLowerCase()], record[player.toLowerCase()]);
    });
  }
});
