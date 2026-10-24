import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { nextFixtureBout, refreshFixtureProgression, validFixtureGraph } from '../../src/fixtureProgression.js';

const require = createRequire(new URL('../../package.json', import.meta.url));
const WebSocket = require('ws');
const XLSX = require('xlsx');
const filePath = path.resolve('outputs/fixture-combinations-20261024/sfts-complete-tournament-test.xlsx');
const dataRoot = path.resolve('data');
const dataDir = path.join(dataRoot, `complete-template-validation-${process.pid}`);
assert.ok(dataDir.startsWith(dataRoot + path.sep));
const port = 36000 + process.pid % 1000;
const buffer = await fs.readFile(filePath);
const workbook = XLSX.read(buffer, { type: 'buffer' });
assert.deepEqual(workbook.SheetNames, ['Matches', 'Categories', 'Instructions', 'Exclusions']);
assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Matches).length, 672);
assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Categories).length, 84);
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), SFTS_DATA_DIR: dataDir, SFTS_HOST_TOKEN: 'complete-template-validation', SFTS_USB_IMPORT_ONLY: 'false' }
});
let socket;
try {
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Validation server did not start: ' + output)), 5000);
    const read = chunk => { output += String(chunk); if (output.includes('running on port')) { clearTimeout(timer); resolve(); } };
    server.stdout.on('data', read);
    server.stderr.on('data', read);
    server.once('error', reject);
  });
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Validation host authentication timed out')), 3000);
    socket.once('open', () => socket.send(JSON.stringify({ type: 'role', role: 'host', accessToken: 'complete-template-validation' })));
    socket.once('error', reject);
    socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'roleAccepted') { clearTimeout(timer); resolve(message.hostToken); } });
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/tournament/import?preview=true`, {
    method: 'POST', body: buffer,
    headers: {
      'Content-Type': 'application/octet-stream', 'X-SFTS-Host-Token': token,
      'X-SFTS-Import-Event': encodeURIComponent(JSON.stringify({ eventName: 'Complete Template Validation', eventDate: '2026-10-24', venue: 'Test Hall', arenaNumber: '1', competition: 'KYORUGI', autoAdvance: true }))
    }
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.workbook.categories.length, 84);
  let totalMatches = 0;
  for (const { fixture } of result.workbook.categories) {
    assert.equal(fixture.players.length, 9);
    assert.equal(fixture.schedule.filter(bout => bout.status === 'BYE').length, 7);
    const stages = [];
    for (let bout; (bout = nextFixtureBout(fixture));) {
      stages.push(bout.stage);
      bout.winner = stages.length % 2 ? 'BLUE' : 'RED';
      bout.winnerName = bout[bout.winner].playerName;
      bout.status = 'COMPLETED';
      refreshFixtureProgression(fixture);
    }
    assert.deepEqual(stages, ['PRELIMINARY', 'QUARTERFINAL', 'QUARTERFINAL', 'QUARTERFINAL', 'QUARTERFINAL', 'SEMIFINAL', 'SEMIFINAL', 'FINAL']);
    assert.ok(validFixtureGraph(fixture));
    totalMatches += stages.length;
  }
  console.log(JSON.stringify({ exportedFileImported: true, categories: 84, players: 756, byes: 588, simulatedContestedMatches: totalMatches, allCategoriesReachedFinal: true, excludedCombinations: XLSX.utils.sheet_to_json(workbook.Sheets.Exclusions).length }));
} finally {
  socket?.terminate();
  if (server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  await fs.rm(dataDir, { recursive: true, force: true });
}
