import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256File } from '../src/ops/file-hash.js';

test('sha256File hashes files incrementally and matches the standard digest', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-hash-'));
  const file = path.join(directory, 'large-payload.bin');
  const payload = Buffer.alloc(3 * 1024 * 1024 + 137, 0x5a);
  try {
    await fs.writeFile(file, payload);
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    assert.equal(await sha256File(file), expected);
    await fs.writeFile(file, '');
    assert.equal(await sha256File(file), crypto.createHash('sha256').update('').digest('hex'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
