import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// Read through the validated descriptor, not a second path lookup. The extra
// byte detects a file growing after stat without allocating its claimed size.
export async function readBoundedFile(file, maxBytes) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  const handle = await open(file, flags);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('Import source must be a regular file');
    if (details.size > maxBytes) throw new Error('Import file is too large');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, details.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes || length > details.size) throw new Error('Import file grew while being read; retry the operation');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
