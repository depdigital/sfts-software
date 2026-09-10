import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_VERSION = 1;
const DEFAULT_SAVE_DELAY_MS = 250;
const WRITE_RETRIES = 3;

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hasOptionalString(value, key) {
  return !Object.prototype.hasOwnProperty.call(value, key) || typeof value[key] === 'string';
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSide(value) {
  return Boolean(
    isObject(value) && typeof value.name === 'string' && typeof value.playerName === 'string' &&
    hasOptionalString(value, 'division') && typeof value.weightCategory === 'string' &&
    hasOptionalString(value, 'categoryGroup') && typeof value.stateCode === 'string' &&
    typeof value.district === 'string' && hasOptionalString(value, 'club') && isNonNegativeInteger(value.score) &&
    isNonNegativeInteger(value.gamjeom) && isObject(value.stats) &&
    isNonNegativeInteger(value.stats.plus1) && isNonNegativeInteger(value.stats.plus2) &&
    isNonNegativeInteger(value.stats.plus3) &&
    (!Object.prototype.hasOwnProperty.call(value.stats, 'technicalChest') || isNonNegativeInteger(value.stats.technicalChest)) &&
    (!Object.prototype.hasOwnProperty.call(value.stats, 'technicalHead') || isNonNegativeInteger(value.stats.technicalHead))
  );
}

function isMatch(value) {
  return Boolean(
    isObject(value) && isNonNegativeInteger(value.matchNo) && value.matchNo > 0 &&
    isNonNegativeInteger(value.round) && value.round > 0 &&
    Number.isFinite(value.configuredRoundMs) && value.configuredRoundMs >= 0 &&
    Number.isFinite(value.timerMs) && value.timerMs >= 0 &&
    Number.isFinite(value.breakMs) && value.breakMs >= 0 && typeof value.running === 'boolean' &&
    ['ROUND', 'BREAK', 'TIE_DECISION', 'MATCH_END'].includes(value.phase) && isSide(value.red) && isSide(value.blue) &&
    isObject(value.votes) && Array.isArray(value.roundHistory) &&
    (value.matchWinner === null || value.matchWinner === 'RED' || value.matchWinner === 'BLUE') &&
    typeof value.matchReason === 'string' && isObject(value.test) &&
    typeof value.test.active === 'boolean' && isObject(value.test.presses)
  );
}

function isTournamentPlayer(value) {
  return Boolean(
    isObject(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.name === 'string' && value.name.length > 0 &&
    (value.gender === 'MALE' || value.gender === 'FEMALE') &&
    hasOptionalString(value, 'division') && typeof value.weightCategory === 'string' &&
    hasOptionalString(value, 'categoryGroup') &&
    (value.weightCategory.length > 0 || value.categoryGroup?.length > 0) &&
    typeof value.stateCode === 'string' && typeof value.district === 'string' && typeof value.club === 'string'
  );
}

function isTournamentPlacement(value) {
  return Boolean(
    isObject(value) && [1, 2, 3].includes(value.place) &&
    typeof value.playerId === 'string' && value.playerId.length > 0 &&
    typeof value.playerName === 'string' && value.playerName.length > 0 &&
    typeof value.basis === 'string' && value.basis.length > 0 &&
    (value.sourceBoutNo === null || (isNonNegativeInteger(value.sourceBoutNo) && value.sourceBoutNo > 0))
  );
}

function isTournamentPlacementPolicy(value) {
  return Boolean(
    isObject(value) && typeof value.enabled === 'boolean' &&
    value.thirdPlacePolicy === 'BOTH_SEMIFINAL_LOSERS' && isObject(value.labels) &&
    typeof value.labels.first === 'string' && value.labels.first.length > 0 &&
    typeof value.labels.second === 'string' && value.labels.second.length > 0 &&
    typeof value.labels.third === 'string' && value.labels.third.length > 0
  );
}

function isTournament(value) {
  if (!isObject(value) || !Array.isArray(value.players) || !value.players.every(isTournamentPlayer)) return false;
  if (!Array.isArray(value.groups) || !value.groups.every(group => (
    isObject(group) && typeof group.id === 'string' && typeof group.gender === 'string' &&
    hasOptionalString(group, 'division') && typeof group.weightCategory === 'string' &&
    hasOptionalString(group, 'categoryGroup') &&
    (group.weightCategory.length > 0 || group.categoryGroup?.length > 0) && Array.isArray(group.playerIds) &&
    Array.isArray(group.byePlayerIds) &&
    (!Object.prototype.hasOwnProperty.call(group, 'resultStatus') || ['PENDING', 'COMPLETED', 'DISABLED'].includes(group.resultStatus)) &&
    (!Object.prototype.hasOwnProperty.call(group, 'placements') || (
      Array.isArray(group.placements) && group.placements.every(isTournamentPlacement)
    ))
  ))) return false;
  if (!Array.isArray(value.schedule) || !value.schedule.every(bout => (
    isObject(bout) && isNonNegativeInteger(bout.boutNo) && bout.boutNo > 0 &&
    typeof bout.groupId === 'string' && typeof bout.gender === 'string' &&
    hasOptionalString(bout, 'division') && typeof bout.weightCategory === 'string' &&
    hasOptionalString(bout, 'categoryGroup') &&
    (bout.weightCategory.length > 0 || bout.categoryGroup?.length > 0) &&
    isNonNegativeInteger(bout.round) && bout.round > 0 &&
    typeof bout.redPlayerName === 'string' && typeof bout.bluePlayerName === 'string' &&
    typeof bout.status === 'string' && (bout.winner === null || typeof bout.winner === 'string') &&
    (bout.winnerName === null || typeof bout.winnerName === 'string')
  ))) return false;
  if (!Array.isArray(value.byes) || !value.byes.every(bye => isObject(bye) && typeof bye.status === 'string')) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'placementPolicy') && !isTournamentPlacementPolicy(value.placementPolicy)) return false;
  return value.activeBoutNo === null || (isNonNegativeInteger(value.activeBoutNo) && value.activeBoutNo > 0);
}

function isSnapshot(value) {
  return Boolean(
    isObject(value) && value.version === SNAPSHOT_VERSION && typeof value.savedAt === 'string' &&
    (!Object.prototype.hasOwnProperty.call(value, 'arenaNumber') || typeof value.arenaNumber === 'string') &&
    (!Object.prototype.hasOwnProperty.call(value, 'cleanShutdown') || typeof value.cleanShutdown === 'boolean') &&
    isMatch(value.match) && Array.isArray(value.matchHistory) && isTournament(value.tournament) &&
    (!Object.prototype.hasOwnProperty.call(value, 'manualCompetition') || (
      isObject(value.manualCompetition) && Array.isArray(value.manualCompetition.categories)
    )) && (!Object.prototype.hasOwnProperty.call(value, 'manualMatchRecords') || Array.isArray(value.manualMatchRecords))
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

async function syncDirectory(dataDir) {
  try {
    const directory = await open(dataDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Directory fsync is not supported on every Windows filesystem.
  }
}

export function createPersistence({ logger = console, dataDir: configuredDataDir = null } = {}) {
  const dataDir = path.resolve(configuredDataDir || process.env.SFTS_DATA_DIR || path.join(process.cwd(), 'data'));
  const stateFile = path.join(dataDir, 'sfts-state.json');
  const backupFile = path.join(dataDir, 'sfts-state.backup.json');
  const lockFile = path.join(dataDir, 'sfts-state.lock');
  const saveDelayMs = Math.max(50, Number(process.env.SFTS_STATE_SAVE_DELAY_MS) || DEFAULT_SAVE_DELAY_MS);
  let queuedSnapshot = null;
  let saveTimer = null;
  let writeChain = Promise.resolve();
  let lockOwned = false;

  async function acquire() {
    await mkdir(dataDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = await open(lockFile, 'wx');
        try {
          await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
          await lock.sync();
        } finally {
          await lock.close();
        }
        lockOwned = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(await readFile(lockFile, 'utf8')); } catch { /* stale or partial lock */ }
        const pid = Number(owner?.pid);
        let alive = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); alive = true; } catch { alive = false; }
        }
        if (alive) throw new Error(`another server process (PID ${pid}) is using ${dataDir}`);
        await rm(lockFile, { force: true });
      }
    }
    throw new Error('could not acquire the local state lock');
  }

  async function release() {
    if (!lockOwned) return;
    lockOwned = false;
    await rm(lockFile, { force: true });
  }

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

  async function writeJsonAtomically(fileName, contents) {
    const tempFile = `${fileName}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const file = await open(tempFile, 'w');
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(tempFile, fileName);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await rm(fileName, { force: true });
      await rename(tempFile, fileName);
    }
  }

  async function writeSnapshot(snapshot) {
    await mkdir(dataDir, { recursive: true });
    const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
    if ((await readSnapshot(stateFile)).snapshot) {
      const backupTemp = `${backupFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      await copyFile(stateFile, backupTemp);
      try {
        const backup = await open(backupTemp, 'r+');
        try { await backup.sync(); } finally { await backup.close(); }
        await rename(backupTemp, backupFile);
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
        await rm(backupFile, { force: true });
        await rename(backupTemp, backupFile);
      }
    }
    await writeJsonAtomically(stateFile, contents);
    await syncDirectory(dataDir);
  }

  async function writeWithRetry(snapshot) {
    let lastError;
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
      try {
        await writeSnapshot(snapshot);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < WRITE_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  function logWriteError(error) {
    logger.error(`Could not save local state: ${error.message}`);
  }

  function drainQueue() {
    saveTimer = null;
    const pendingSnapshot = queuedSnapshot;
    queuedSnapshot = null;
    if (!pendingSnapshot) return;
    writeChain = writeChain
      .then(() => writeWithRetry(typeof pendingSnapshot === 'function' ? pendingSnapshot() : pendingSnapshot))
      .catch(logWriteError);
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
      const pendingSnapshot = snapshot || queued;
      writeChain = writeChain
        .then(() => writeWithRetry(typeof pendingSnapshot === 'function' ? pendingSnapshot() : pendingSnapshot))
        .catch(logWriteError);
      await writeChain;
    }
  }

  return { dataDir, stateFile, backupFile, lockFile, acquire, release, load, schedule, flush };
}
