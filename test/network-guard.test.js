import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkGuard, createRateLimiter } from '../src/networkGuard.js';

test('rate buckets reject floods, refill, and expire keys without growing unbounded', () => {
  let time = 0;
  const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 2, ttlMs: 2000, now: () => time });
  assert.equal(limiter.take('one'), true);
  assert.equal(limiter.take('one'), true);
  assert.equal(limiter.take('one'), false);
  assert.equal(limiter.take('two'), true);
  assert.equal(limiter.take('three'), false);
  time = 1000;
  assert.equal(limiter.take('one'), true);
  assert.equal(limiter.take('one'), false);
  time = 4001;
  assert.equal(limiter.take('three'), true);
});

test('only local server hosts and exact same-origin browser requests are admitted', () => {
  const guard = createNetworkGuard({ port: 8080 });
  const req = (host, origin) => ({ headers: { host, ...(origin === undefined ? {} : { origin }) }, socket: { localAddress: '::ffff:192.168.50.102' } });
  assert.equal(guard.trustedRequest(req('192.168.50.102:8080')), true);
  assert.equal(guard.trustedRequest(req('127.0.0.1:8080', 'http://127.0.0.1:8080')), true);
  assert.equal(guard.trustedRequest(req('localhost:8080', 'http://localhost:8080')), true);
  for (const [host, origin] of [
    ['evil.invalid:8080', undefined],
    ['127.0.0.1:8080', 'null'],
    ['127.0.0.1:8080', 'http://evil.invalid:8080'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/path'],
    ['127.0.0.1:8081', undefined],
    ['127.0.0.1:8080@evil.invalid', undefined]
  ]) assert.equal(guard.trustedRequest(req(host, origin)), false, `${host} / ${origin}`);
});
