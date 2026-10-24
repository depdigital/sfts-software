import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_TEXT_LENGTH = 240;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_LIMIT = 100;
const MEMORY_AUDIO_LIMIT = 20;
const MEMORY_AUDIO_TTL_MS = 10 * 60 * 1000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_ANNOUNCEMENTS = 4;

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
    .then(result => result.isFile() && result.size > 44 && result.size <= MAX_AUDIO_BYTES)
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
      child.kill('SIGKILL');
      finish(new Error(`Piper timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.once('error', error => finish(error));
    child.stdin.once('error', error => finish(error));
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
  const synthesizeUrl = String(process.env.SFTS_TTS_URL || '').trim();
  const cacheDir = path.resolve(process.env.SFTS_TTS_CACHE_DIR || path.join(process.cwd(), 'data', 'tts'));
  const timeoutMs = envNumber('SFTS_TTS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 120000);
  const cacheLimit = envNumber('SFTS_TTS_CACHE_LIMIT', DEFAULT_CACHE_LIMIT, 1, 1000);
  const memoryAudio = new Map();
  let queue = Promise.resolve();
  let pending = 0;
  let memoryAudioBytes = 0;
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

  function trimMemoryAudio() {
    const now = Date.now();
    for (const [fileName, item] of memoryAudio) {
      if (item.expiresAt <= now) {
        memoryAudioBytes -= item.buffer.length;
        memoryAudio.delete(fileName);
      }
    }
    while (memoryAudio.size > MEMORY_AUDIO_LIMIT || memoryAudioBytes > MAX_MEMORY_AUDIO_BYTES) {
      const oldest = memoryAudio.keys().next().value;
      memoryAudioBytes -= memoryAudio.get(oldest).buffer.length;
      memoryAudio.delete(oldest);
    }
  }

  function storeMemoryAudio(buffer) {
    trimMemoryAudio();
    const fileName = `memory-${randomBytes(18).toString('hex')}`;
    memoryAudio.set(fileName, { buffer, expiresAt: Date.now() + MEMORY_AUDIO_TTL_MS });
    memoryAudioBytes += buffer.length;
    trimMemoryAudio();
    return { fileName };
  }

  async function generateFromHttp(text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(synthesizeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Piper HTTP service returned ${response.status}`);
      if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
        await response.body?.cancel();
        throw new Error('Piper WAV exceeds the 2 MB limit');
      }
      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of response.body) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_AUDIO_BYTES) throw new Error('Piper WAV exceeds the 2 MB limit');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks, totalBytes);
      if (buffer.length <= 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Piper HTTP service returned an invalid WAV file');
      }
      return storeMemoryAudio(buffer);
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`Piper HTTP service timed out after ${timeoutMs} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate(text) {
    if (engine !== 'piper' || (!model && !synthesizeUrl)) return null;
    const normalizedText = String(text || '').trim().slice(0, MAX_TEXT_LENGTH);
    if (!normalizedText) return null;
    if (synthesizeUrl) return generateFromHttp(normalizedText);
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
    if (pending >= MAX_PENDING_ANNOUNCEMENTS) {
      const error = new Error('Announcement queue is full; wait for the current announcements');
      error.code = 'TTS_BUSY';
      return Promise.reject(error);
    }
    pending += 1;
    const next = queue.then(() => generate(text)).finally(() => { pending -= 1; });
    queue = next.catch(() => null);
    return next;
  }

  function audioPath(fileName) {
    if (!/^[a-f0-9]{64}\.wav$/.test(String(fileName || ''))) return null;
    return path.join(cacheDir, fileName);
  }

  function audioBuffer(fileName) {
    trimMemoryAudio();
    return memoryAudio.get(String(fileName))?.buffer || null;
  }

  const memoryCleanupTimer = setInterval(trimMemoryAudio, 60_000);
  memoryCleanupTimer.unref?.();

  return {
    enabled: engine === 'piper' && Boolean(model || synthesizeUrl),
    synthesize,
    audioPath,
    audioBuffer
  };
}
