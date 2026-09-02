import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTts } from '../src/tts.js';

test('HTTP Piper audio is retained in memory instead of written to disk', async () => {
  const previousEngine = process.env.SFTS_TTS_ENGINE;
  const previousUrl = process.env.SFTS_TTS_URL;
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(41)]);
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
