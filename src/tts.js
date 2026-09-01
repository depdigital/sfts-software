import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_TEXT_LENGTH = 240;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_LIMIT = 100;

function envNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function configuredEngine() {
  return String(process.env.SFTS_TTS_ENGINE || 'browser').trim().toLowerCase();
}

function cacheFileName(text, model) {
  return `${createHash('sha256').update(`${model}\0${text}`).digest('hex')}.wav`;
}

function isUsableAudio(file) {
  return stat(file)
    .then(result => result.isFile() && result.size > 44)
    .catch(() => false);
}

function runPiper({ command, model, text, outputFile, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['--model', model, '--output_file', outputFile], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Piper timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (code === 0) finish();
      else finish(new Error(`Piper exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdin.end(`${text}\n`);
  });
}

export function createTts({ logger = console } = {}) {
  const engine = configuredEngine();
  const command = String(process.env.SFTS_TTS_COMMAND || (process.platform === 'win32' ? 'piper.exe' : 'piper')).trim();
  const model = String(process.env.SFTS_TTS_MODEL || '').trim();
  const cacheDir = path.resolve(process.env.SFTS_TTS_CACHE_DIR || path.join(process.cwd(), 'data', 'tts'));
  const timeoutMs = envNumber('SFTS_TTS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 120000);
  const cacheLimit = envNumber('SFTS_TTS_CACHE_LIMIT', DEFAULT_CACHE_LIMIT, 1, 1000);
  let queue = Promise.resolve();
  let warned = false;

  function warn(error) {
    if (warned) return;
    warned = true;
    logger.warn(`Local TTS unavailable; browser speech fallback will be used: ${error.message}`);
  }

  async function trimCache() {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    const wavFiles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.wav$/.test(entry.name)) continue;
      const file = path.join(cacheDir, entry.name);
      const details = await stat(file).catch(() => null);
      if (details) wavFiles.push({ file, mtime: details.mtimeMs });
    }
    wavFiles.sort((left, right) => right.mtime - left.mtime);
    await Promise.all(wavFiles.slice(cacheLimit).map(item => rm(item.file, { force: true })));
  }

  async function generate(text) {
    if (engine !== 'piper' || !model) return null;
    const normalizedText = String(text || '').trim().slice(0, MAX_TEXT_LENGTH);
    if (!normalizedText) return null;
    await mkdir(cacheDir, { recursive: true });
    const fileName = cacheFileName(normalizedText, model);
    const outputFile = path.join(cacheDir, fileName);
    if (await isUsableAudio(outputFile)) return { fileName };

    try {
      await runPiper({ command, model, text: normalizedText, outputFile, timeoutMs });
      if (!(await isUsableAudio(outputFile))) throw new Error('Piper produced an empty audio file');
      await trimCache();
      return { fileName };
    } catch (error) {
      await rm(outputFile, { force: true }).catch(() => {});
      warn(error);
      return null;
    }
  }

  function synthesize(text) {
    const next = queue.then(() => generate(text));
    queue = next.catch(() => null);
    return next;
  }

  function audioPath(fileName) {
    if (!/^[a-f0-9]{64}\.wav$/.test(String(fileName || ''))) return null;
    return path.join(cacheDir, fileName);
  }

  return {
    enabled: engine === 'piper' && Boolean(model),
    synthesize,
    audioPath
  };
}
