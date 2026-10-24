import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManualArchive } from '../src/manualArchive.js';

test('manual archive coalesces bursts, preserves complete latest records and restores a valid backup', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sfts-archive-'));
  try {
    const archive = createManualArchive({ dataDir, logger: { warn() {}, error() {} } });
    let snapshots = 0;
    for (let i = 0; i < 100; i += 1) archive.schedule(() => {
      snapshots += 1;
      return { version: 1, manualCompetition: { categories: [{ id: 'C1' }] }, records: Array.from({ length: i + 1 }, (_, id) => ({ id })) };
    });
    await archive.flush();
    assert.ok(snapshots <= 2);
    assert.equal(JSON.parse(await readFile(archive.archiveFile, 'utf8')).records.length, 100);
    await archive.flush({ version: 1, manualCompetition: { categories: [] }, records: [{ id: 101 }] });
    await writeFile(archive.archiveFile, '{broken');
    assert.equal((await archive.load()).records.length, 100);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('archive flush reports storage failures and recovers on the next successful save', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sfts-archive-error-'));
  const blocked = path.join(temp, 'not-a-directory');
  try {
    await writeFile(blocked, 'blocked');
    const status = [];
    const archive = createManualArchive({ dataDir: blocked, logger: { error() {} }, onStatus: ok => status.push(ok) });
    const snapshot = { version: 1, manualCompetition: { categories: [] }, records: [] };
    await assert.rejects(archive.flush(snapshot));
    await rm(blocked);
    await archive.flush(snapshot);
    assert.deepEqual(status, [false, true]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
