import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { packageKioskGuard } from '../deployment/scripts/package-kiosk-guard.js';

// Parse Chromium's actual CRX output independently of the packaging code.
function fields(bytes) {
  let offset = 0;
  const number = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do { byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    return value;
  };
  const result = new Map();
  while (offset < bytes.length) {
    const tag = number();
    assert.equal(tag & 7, 2);
    const size = number();
    result.set(Math.floor(tag / 8), bytes.subarray(offset, offset + size));
    offset += size;
  }
  return result;
}

test('native Chromium packages a signed guard with a stable device identity and updated port/version', {
  skip: !process.env.SFTS_TEST_CHROMIUM && 'Set SFTS_TEST_CHROMIUM to run native browser packaging validation'
}, async () => {
  const dataRoot = fileURLToPath(new URL('../data/', import.meta.url));
  await mkdir(dataRoot, { recursive: true });
  const temp = await mkdtemp(path.join(dataRoot, 'kiosk-package-'));
  const outputDir = path.join(temp, 'public');
  const keyPath = path.join(temp, 'private.pem');
  const previousMask = process.umask(0o077);
  try {
    const first = await packageKioskGuard({ browser: process.env.SFTS_TEST_CHROMIUM, port: 8080, outputDir, keyPath });
    const second = await packageKioskGuard({ browser: process.env.SFTS_TEST_CHROMIUM, port: 9090, outputDir, keyPath });
    assert.equal(second.id, first.id);
    assert.notEqual(second.version, first.version);
    const crx = await readFile(path.join(outputDir, 'guard.crx'));
    assert.equal(crx.toString('ascii', 0, 4), 'Cr24');
    assert.equal(crx.readUInt32LE(4), 3);
    const header = fields(crx.subarray(12, 12 + crx.readUInt32LE(8)));
    const proof = fields(header.get(2));
    const signed = header.get(10000);
    const archive = crx.subarray(12 + crx.readUInt32LE(8));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(signed.length);
    const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signed, archive]);
    const publicKey = createPublicKey({ key: proof.get(1), format: 'der', type: 'spki' });
    assert.equal(verify('sha256', payload, publicKey, proof.get(2)), true);
    assert.deepEqual(fields(signed).get(1), createHash('sha256').update(proof.get(1)).digest().subarray(0, 16));
    const zip = XLSX.CFB.read(archive, { type: 'buffer' });
    const content = file => XLSX.CFB.find(zip, file).content.toString('utf8');
    const manifest = JSON.parse(content('manifest.json'));
    assert.equal(manifest.version, second.version);
    assert.equal(manifest.update_url, 'http://127.0.0.1:9090/kiosk-guard/update.xml');
    assert.match(content('config.js'), /127\.0\.0\.1:9090/);
    assert.doesNotMatch(content('config.js'), /@PORT@/);
    const metadata = await readFile(path.join(outputDir, 'update.xml'), 'utf8');
    assert.ok(metadata.includes(`appid="${second.id}"`));
    assert.ok(metadata.includes(`version="${second.version}"`));
    assert.match(metadata, /http:\/\/127\.0\.0\.1:9090\/kiosk-guard\/guard\.crx/);
    if (process.platform !== 'win32') {
      assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(outputDir, 'guard.crx'))).mode & 0o777, 0o644);
    }
  } finally {
    process.umask(previousMask);
    assert.equal(path.dirname(temp), path.resolve(dataRoot));
    await rm(temp, { recursive: true, force: true });
  }
});
