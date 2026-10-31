import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validFile } from '../src/utils/file-validation.js';

test('accepts files whose signatures match their declared MIME types', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-file-signatures-'));
  const samples = [
    ['application/pdf', Buffer.from('%PDF-1.7\n')],
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['image/tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00])]
  ];

  try {
    for (const [mimeType, bytes] of samples) {
      const filePath = path.join(directory, `sample-${samples.indexOf(samples.find(item => item[0] === mimeType))}`);
      await fs.writeFile(filePath, bytes);
      assert.equal(validFile(filePath, mimeType), true, `expected ${mimeType} signature to pass`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects spoofed, truncated, and unsupported file types', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-file-invalid-'));
  try {
    const spoofed = path.join(directory, 'spoofed.pdf');
    const truncated = path.join(directory, 'short.png');
    await fs.writeFile(spoofed, 'this is not a PDF');
    await fs.writeFile(truncated, Buffer.from([137, 80, 78]));
    assert.equal(validFile(spoofed, 'application/pdf'), false);
    assert.equal(validFile(truncated, 'image/png'), false);
    assert.equal(validFile(spoofed, 'application/x-msdownload'), false);
    assert.equal(validFile(path.join(directory, 'missing.pdf'), 'application/pdf'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects a valid signature presented as a different MIME type', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-file-mismatch-'));
  try {
    const filePath = path.join(directory, 'image.jpg');
    await fs.writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.equal(validFile(filePath, 'application/pdf'), false);
    assert.equal(validFile(filePath, 'image/jpeg'), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
