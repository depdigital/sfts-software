import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

function validArchive(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 &&
    value.manualCompetition && typeof value.manualCompetition === 'object' &&
    Array.isArray(value.manualCompetition.categories) && Array.isArray(value.records)
  );
}

async function readArchive(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return validArchive(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function syncFile(file) {
  const handle = await open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function renameReplacing(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await rm(target, { force: true });
    await rename(source, target);
  }
}

export function createManualArchive({ dataDir, logger = console }) {
  const archiveFile = path.join(dataDir, 'manual-results.json');
  const backupFile = path.join(dataDir, 'manual-results.backup.json');
  let writeChain = Promise.resolve();

  async function load() {
    const primary = await readArchive(archiveFile);
    if (primary) return primary;
    const backup = await readArchive(backupFile);
    if (backup) {
      logger.warn('Manual result archive was unavailable; restored its backup');
      return backup;
    }
    return null;
  }

  async function write(snapshot) {
    await mkdir(dataDir, { recursive: true });
    const previous = await readArchive(archiveFile);
    if (previous) {
      const backupTemp = `${backupFile}.${process.pid}.tmp`;
      await copyFile(archiveFile, backupTemp);
      await syncFile(backupTemp);
      await renameReplacing(backupTemp, backupFile);
    }
    const tempFile = `${archiveFile}.${process.pid}.tmp`;
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameReplacing(tempFile, archiveFile);
  }

  function schedule(snapshot) {
    const copy = structuredClone(snapshot);
    writeChain = writeChain
      .catch(() => {})
      .then(() => write(copy))
      .catch(error => logger.error(`Could not save the manual result archive: ${error.message}`));
  }

  async function flush(snapshot = null) {
    await writeChain;
    if (snapshot) await write(structuredClone(snapshot));
  }

  return { archiveFile, backupFile, load, schedule, flush };
}
