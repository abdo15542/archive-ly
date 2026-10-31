import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveStoredFilePath, verifyFileSha256 } from '../src/utils/file-integrity.js';

test('stored filenames are constrained to generated UUIDs inside upload directory', () => {
  const root = path.join(os.tmpdir(), 'archive-ly-uploads');
  assert.equal(
    resolveStoredFilePath(root, '123e4567-e89b-42d3-a456-426614174000'),
    path.join(root, '123e4567-e89b-42d3-a456-426614174000')
  );
  assert.throws(() => resolveStoredFilePath(root, '../../etc/passwd'), /filename is invalid/);
  assert.throws(() => resolveStoredFilePath(root, 'document.pdf'), /filename is invalid/);
});

test('streaming SHA-256 verification accepts intact files and rejects modified files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-file-integrity-'));
  const file = path.join(directory, 'document.bin');
  const content = Buffer.from('archived document bytes');
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  try {
    await fs.writeFile(file, content);
    assert.equal(await verifyFileSha256(file, digest), true);
    await fs.appendFile(file, 'tampered');
    assert.equal(await verifyFileSha256(file, digest), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('checksum verification rejects malformed stored hashes', async () => {
  await assert.rejects(verifyFileSha256('/not-read-because-hash-is-invalid', 'invalid'), /checksum is invalid/);
});

test('checksum verification refuses symbolic links', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-symlink-'));
  const target = path.join(directory, 'target.bin');
  const link = path.join(directory, 'link.bin');
  try {
    await fs.writeFile(target, 'outside target');
    await fs.symlink(target, link);
    const digest = crypto.createHash('sha256').update('outside target').digest('hex');
    await assert.rejects(verifyFileSha256(link, digest), /not a regular file/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
