import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBoundedFile } from '../src/safeFiles.js';

test('bounded import reads reject oversized files and return exact content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfts-safe-read-'));
  try {
    const file = path.join(dir, 'players.csv');
    await writeFile(file, '12345');
    assert.equal((await readBoundedFile(file, 5)).toString(), '12345');
    await assert.rejects(readBoundedFile(file, 4), /too large/);
    await assert.rejects(readBoundedFile(dir, 100));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
