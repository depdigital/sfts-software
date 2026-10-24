import { Worker } from 'node:worker_threads';

// One lazy worker, no backlog. The Pi keeps its memory and CPU for Chromium,
// scoring and Piper, and releases the file libraries when idle.
export function createFileJobs({ timeoutMs = 30_000, idleMs = 15_000 } = {}) {
  let worker = null;
  let active = null;
  let idleTimer = null;
  let sequence = 0;

  function finish(error, result) {
    if (!active) return;
    const job = active;
    active = null;
    clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(result);
    idleTimer = setTimeout(() => { void close(); }, idleMs);
    idleTimer.unref?.();
    worker?.unref();
  }

  function startWorker() {
    const instance = new Worker(new URL('./fileWorker.js', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    });
    worker = instance;
    instance.on('message', message => {
      if (worker !== instance || message.id !== active?.id) return;
      finish(message.error ? new Error(message.error) : null, message.result);
    });
    instance.on('error', error => {
      if (worker !== instance) return;
      worker = null;
      finish(error);
    });
    instance.on('exit', code => {
      if (worker !== instance) return;
      worker = null;
      if (active) finish(new Error(`File operation worker exited (${code}); retry the operation`));
    });
  }

  async function close() {
    clearTimeout(idleTimer);
    const instance = worker;
    worker = null;
    if (active) finish(new Error('File operation cancelled'));
    clearTimeout(idleTimer);
    if (instance) await instance.terminate();
  }

  function run(type, data) {
    if (active) return Promise.reject(new Error('Another file operation is running; retry when it finishes'));
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      active = { id: ++sequence, resolve, reject };
      active.timer = setTimeout(() => {
        finish(new Error('File operation timed out; check the file and retry'));
        void close();
      }, timeoutMs);
      try {
        if (!worker) startWorker();
        worker.ref();
        worker.postMessage({ id: active.id, type, data });
      } catch (error) {
        finish(error);
      }
    });
  }

  return { run, close };
}
