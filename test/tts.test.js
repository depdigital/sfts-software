import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTts } from '../src/tts.js';

test('HTTP Piper audio is retained in memory instead of written to disk', async () => {
  const previousEngine = process.env.SFTS_TTS_ENGINE;
  const previousUrl = process.env.SFTS_TTS_URL;
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(41)]);
  wav.write('WAVE', 8, 'ascii');
  const piperServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(wav);
  });
  await new Promise(resolve => piperServer.listen(0, '127.0.0.1', resolve));

  try {
    process.env.SFTS_TTS_ENGINE = 'piper';
    process.env.SFTS_TTS_URL = `http://127.0.0.1:${piperServer.address().port}/synthesize`;
    const tts = createTts();
    const audio = await tts.synthesize('Test announcement');
    assert.match(audio.fileName, /^memory-[a-f0-9]{36}$/);
    assert.deepEqual(tts.audioBuffer(audio.fileName), wav);
    assert.equal(tts.audioPath(audio.fileName), null);
  } finally {
    await new Promise(resolve => piperServer.close(resolve));
    if (previousEngine === undefined) delete process.env.SFTS_TTS_ENGINE;
    else process.env.SFTS_TTS_ENGINE = previousEngine;
    if (previousUrl === undefined) delete process.env.SFTS_TTS_URL;
    else process.env.SFTS_TTS_URL = previousUrl;
  }
});

async function withHttpTts(handler, action) {
  const previousEngine = process.env.SFTS_TTS_ENGINE;
  const previousUrl = process.env.SFTS_TTS_URL;
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.SFTS_TTS_ENGINE = 'piper';
    process.env.SFTS_TTS_URL = `http://127.0.0.1:${server.address().port}/synthesize`;
    await action(createTts());
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousEngine === undefined) delete process.env.SFTS_TTS_ENGINE;
    else process.env.SFTS_TTS_ENGINE = previousEngine;
    if (previousUrl === undefined) delete process.env.SFTS_TTS_URL;
    else process.env.SFTS_TTS_URL = previousUrl;
  }
}

test('Piper responses cannot allocate an unlimited audio buffer', async () => {
  await withHttpTts((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': 3 * 1024 * 1024 });
    res.end('oversized');
  }, tts => assert.rejects(tts.synthesize('test'), /2 MB limit/));
  await withHttpTts((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    for (let i = 0; i < 40; i += 1) res.write(Buffer.alloc(65536));
    res.end();
  }, tts => assert.rejects(tts.synthesize('test'), /2 MB limit/));
});

test('speech cache respects its total byte budget and announcement queue stays bounded', async () => {
  const wav = Buffer.alloc(1024 * 1024);
  wav.write('RIFF');
  wav.write('WAVE', 8);
  await withHttpTts((req, res) => res.end(wav), async tts => {
    const items = [];
    for (let i = 0; i < 10; i += 1) items.push(await tts.synthesize(`announcement ${i}`));
    assert.equal(tts.audioBuffer(items[0].fileName), null);
    assert.equal(tts.audioBuffer(items[1].fileName), null);
    assert.equal(tts.audioBuffer(items[9].fileName).length, wav.length);
    const pending = Array.from({ length: 4 }, () => tts.synthesize('queued announcement'));
    await assert.rejects(tts.synthesize('queue overflow'), { code: 'TTS_BUSY' });
    await Promise.all(pending);
    assert.ok(await tts.synthesize('queue recovered'));
  });
});
