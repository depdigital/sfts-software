import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_VERSION = 1;
const DEFAULT_SAVE_DELAY_MS = 250;

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshot(value) {
  return Boolean(
    isObject(value) &&
    value.version === SNAPSHOT_VERSION &&
    typeof value.savedAt === 'string' &&
    isObject(value.match) &&
    isObject(value.match.red) &&
    isObject(value.match.blue) &&
    Array.isArray(value.match.roundHistory) &&
    isObject(value.match.votes) &&
    Array.isArray(value.matchHistory) &&
    isObject(value.tournament) &&
    Array.isArray(value.tournament.players) &&
    Array.isArray(value.tournament.groups) &&
    Array.isArray(value.tournament.schedule) &&
    Array.isArray(value.tournament.byes)
  );
}

async function readSnapshot(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const valid = isSnapshot(parsed);
    return { snapshot: valid ? parsed : null, invalid: !valid };
  } catch (error) {
    return { snapshot: null, invalid: error.code !== 'ENOENT' };
  }
}

export function createPersistence({ logger = console, dataDir: configuredDataDir = null } = {}) {
  const dataDir = path.resolve(configuredDataDir || process.env.SFTS_DATA_DIR || path.join(process.cwd(), 'data'));
  const stateFile = path.join(dataDir, 'sfts-state.json');
  const backupFile = path.join(dataDir, 'sfts-state.backup.json');
  const saveDelayMs = Math.max(50, Number(process.env.SFTS_STATE_SAVE_DELAY_MS) || DEFAULT_SAVE_DELAY_MS);
  let queuedSnapshot = null;
  let saveTimer = null;
  let writeChain = Promise.resolve();

  async function load() {
    const primary = await readSnapshot(stateFile);
    if (primary.snapshot) return { snapshot: primary.snapshot, source: 'primary' };
    if (primary.invalid) logger.warn('Primary saved state is invalid; trying the backup snapshot');

    const backup = await readSnapshot(backupFile);
    if (backup.snapshot) {
      logger.warn('Primary saved state was unavailable; restoring the backup snapshot');
      return { snapshot: backup.snapshot, source: 'backup' };
    }
    if (backup.invalid) logger.warn('Backup saved state is invalid; starting with a fresh state');

    return null;
  }

  async function writeSnapshot(snapshot) {
    await mkdir(dataDir, { recursive: true });
    const tempFile = path.join(dataDir, `sfts-state.${process.pid}.tmp`);
    const file = await open(tempFile, 'w');
    try {
      await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    if ((await readSnapshot(stateFile)).snapshot) {
      await copyFile(stateFile, backupFile);
    }

    try {
      await rename(tempFile, stateFile);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await rm(stateFile, { force: true });
      await rename(tempFile, stateFile);
    }
  }

  function logWriteError(error) {
    logger.error(`Could not save local state: ${error.message}`);
  }

  function drainQueue() {
    saveTimer = null;
    const snapshot = queuedSnapshot;
    queuedSnapshot = null;
    if (!snapshot) return;
    writeChain = writeChain.then(() => writeSnapshot(snapshot)).catch(logWriteError);
    if (queuedSnapshot && !saveTimer) saveTimer = setTimeout(drainQueue, saveDelayMs);
  }

  function schedule(snapshot) {
    queuedSnapshot = snapshot;
    if (!saveTimer) saveTimer = setTimeout(drainQueue, saveDelayMs);
  }

  async function flush(snapshot = null) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const queued = queuedSnapshot;
    queuedSnapshot = null;
    await writeChain;
    if (queued || snapshot) {
      writeChain = writeChain.then(() => writeSnapshot(snapshot || queued)).catch(logWriteError);
      await writeChain;
    }
  }

  return {
    dataDir,
    stateFile,
    backupFile,
    load,
    schedule,
    flush
  };
}
