import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoreWithUploadSwap } from '../src/ops/restore-files.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ly-restore-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uploadDir = path.join(root, 'uploads');
  const stageRoot = await fs.mkdtemp(path.join(root, '.stage-'));
  const stagedUploads = path.join(stageRoot, 'uploads');
  await fs.mkdir(uploadDir);
  await fs.mkdir(stagedUploads);
  await fs.writeFile(path.join(uploadDir, 'current.txt'), 'current data');
  await fs.writeFile(path.join(stagedUploads, 'restored.txt'), 'restored data');
  return { uploadDir, stagedUploads };
}

test('successful database restore atomically installs staged uploads', async t => {
  const { uploadDir, stagedUploads } = await fixture(t);
  let databaseRestored = false;
  await restoreWithUploadSwap({
    uploadDir, stagedUploads,
    restoreDatabase: async () => { databaseRestored = true; }
  });
  assert.equal(databaseRestored, true);
  assert.equal(await fs.readFile(path.join(uploadDir, 'restored.txt'), 'utf8'), 'restored data');
  await assert.rejects(fs.access(path.join(uploadDir, 'current.txt')), { code: 'ENOENT' });
});

test('database restore failure rolls the previous uploads directory back', async t => {
  const { uploadDir, stagedUploads } = await fixture(t);
  await assert.rejects(
    restoreWithUploadSwap({
      uploadDir, stagedUploads,
      restoreDatabase: async () => { throw new Error('simulated pg_restore failure'); }
    }),
    /simulated pg_restore failure/
  );
  assert.equal(await fs.readFile(path.join(uploadDir, 'current.txt'), 'utf8'), 'current data');
  await assert.rejects(fs.access(path.join(uploadDir, 'restored.txt')), { code: 'ENOENT' });
});

test('restore without an existing uploads directory removes newly installed files on failure', async t => {
  const { uploadDir, stagedUploads } = await fixture(t);
  await fs.rm(uploadDir, { recursive: true, force: true });
  await assert.rejects(
    restoreWithUploadSwap({
      uploadDir, stagedUploads,
      restoreDatabase: async () => { throw new Error('database unavailable'); }
    }),
    /database unavailable/
  );
  await assert.rejects(fs.access(uploadDir), { code: 'ENOENT' });
});

test('restore refuses a symlink as the live uploads directory', async t => {
  const { uploadDir, stagedUploads } = await fixture(t);
  const real = uploadDir + '-real';
  await fs.rename(uploadDir, real);
  await fs.symlink(real, uploadDir, 'dir');
  await assert.rejects(
    restoreWithUploadSwap({ uploadDir, stagedUploads, restoreDatabase: async () => {} }),
    /real directory/
  );
  assert.equal(await fs.readFile(path.join(real, 'current.txt'), 'utf8'), 'current data');
});
