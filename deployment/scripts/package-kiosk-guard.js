import { execFile } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Use Chromium's own CRX packer. Unpacked extensions cannot load when the
// browser's ExtensionInstallBlocklist is '*', even with an ID exception.
export async function packageKioskGuard({ browser, port, outputDir, keyPath, sourceDir = fileURLToPath(new URL('../kiosk-guard/', import.meta.url)) }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid kiosk port');
  const tempRoot = await realpath(os.tmpdir());
  const staging = await mkdtemp(path.join(tempRoot, 'sfts-guard-'));
  try {
    await mkdir(outputDir, { recursive: true, mode: 0o755 });
    const source = path.join(staging, 'extension');
    await mkdir(source);
    const manifest = JSON.parse(await readFile(path.join(sourceDir, 'manifest.json'), 'utf8'));
    // A new version is required for changed configuration as well as source.
    // Preserve a monotonic counter across repeated installs and clock changes.
    let previous = 0;
    try { previous = JSON.parse(await readFile(path.join(outputDir, 'build.json'), 'utf8')).serial; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('Invalid prior kiosk guard build');
    const serial = Math.max(Math.floor(Date.now() / 1000), previous + 1);
    manifest.version = `1.0.${Math.floor(serial / 65536)}.${serial % 65536}`;
    manifest.update_url = `http://127.0.0.1:${port}/kiosk-guard/update.xml`;
    await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
    for (const file of ['background.js', 'guard.js', 'config.js']) {
      const content = (await readFile(path.join(sourceDir, file), 'utf8')).replaceAll('@PORT@', String(port));
      await writeFile(path.join(source, file), content);
    }
    const args = ['--headless=new', '--no-sandbox', '--no-first-run', '--noerrdialogs', '--no-message-box',
      `--user-data-dir=${path.join(staging, 'profile')}`, `--pack-extension=${source}`];
    try { await readFile(keyPath); args.push(`--pack-extension-key=${keyPath}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Packaging runs as root during maintenance, with no web page open. The
    // live kiosk continues to run as the ordinary service/desktop user.
    await run(browser, args, { timeout: 30_000, windowsHide: true });
    if (!args.some(arg => arg.startsWith('--pack-extension-key='))) {
      await writeFile(keyPath, await readFile(`${source}.pem`), { mode: 0o600, flag: 'wx' });
    }
    await chmod(keyPath, 0o600);
    const publicKey = createPublicKey(await readFile(keyPath)).export({ type: 'spki', format: 'der' });
    const id = [...createHash('sha256').update(publicKey).digest().subarray(0, 16)]
      .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
    const crx = await readFile(`${source}.crx`);
    if (crx.toString('ascii', 0, 4) !== 'Cr24' || crx.readUInt32LE(4) !== 3) throw new Error('Chromium did not produce a CRX3 package');
    const update = `<?xml version="1.0" encoding="UTF-8"?>\n<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${id}"><updatecheck codebase="http://127.0.0.1:${port}/kiosk-guard/guard.crx" version="${manifest.version}" /></app></gupdate>\n`;
    // Publish package first and update metadata last, using atomic replacements.
    for (const [file, content] of [['guard.crx', crx], ['build.json', JSON.stringify({ id, serial, version: manifest.version })], ['update.xml', update]]) {
      const target = path.join(outputDir, file);
      await writeFile(`${target}.tmp`, content, { mode: 0o644 });
      await chmod(`${target}.tmp`, 0o644);
      await rename(`${target}.tmp`, target);
    }
    return { id, version: manifest.version };
  } finally {
    if (path.dirname(staging) !== tempRoot || !path.basename(staging).startsWith('sfts-guard-')) throw new Error('Unexpected packaging temporary directory');
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [browser, port, outputDir, keyPath] = process.argv.slice(2);
  const result = await packageKioskGuard({ browser, port: Number(port), outputDir, keyPath });
  process.stdout.write(`${result.id}\n`);
}
