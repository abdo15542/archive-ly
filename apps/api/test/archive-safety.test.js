import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArchivePaths, validateArchiveTypes, validateBackupEntries } from '../src/ops/archive-safety.js';

test('accepts normal relative archive paths', () => {
  assert.equal(validateArchivePaths(['./', './2026', '2026/scan.pdf']), true);
});

test('rejects absolute and parent traversal paths', () => {
  for (const entry of ['/etc/passwd', '../outside', 'docs/../../outside', 'C:/Windows/system.ini']) {
    assert.throws(() => validateArchivePaths([entry]), /unsafe path/);
  }
});

test('rejects malformed path entries', () => {
  for (const entry of ['', null, 42, 'bad\0name']) {
    assert.throws(() => validateArchivePaths([entry]));
  }
});

test('accepts regular files and directories only', () => {
  assert.equal(validateArchiveTypes(['-rw-r--r-- user/group 12 file.pdf', 'drwxr-xr-x user/group 0 scans/']), true);
});

test('rejects symbolic links, hard links and special files', () => {
  for (const line of ['lrwxrwxrwx user/group 0 link -> target', 'hrw-r--r-- user/group 0 hard link to target', 'crw-r--r-- user/group 0 device']) {
    assert.throws(() => validateArchiveTypes([line]), /link or special file/);
  }
});

test('rejects empty archive listings', () => {
  assert.throws(() => validateArchivePaths([]), /empty or invalid/);
  assert.throws(() => validateArchiveTypes([]), /empty or invalid/);
});

test('rejects symbolic links nested inside upload folders', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { assertSafeUploadTree } = await import('../src/ops/archive-safety.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-tree-'));
  try {
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'safe.txt'), 'safe');
    assert.equal(await assertSafeUploadTree(root), true);
    await fs.symlink(path.join(root, 'nested', 'safe.txt'), path.join(root, 'nested', 'linked.txt'));
    await assert.rejects(assertSafeUploadTree(root), /symbolic link/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects an uploads directory that is itself a symbolic link', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { assertSafeUploadTree } = await import('../src/ops/archive-safety.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-root-link-'));
  try {
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    await fs.mkdir(real);
    await fs.symlink(real, link);
    await assert.rejects(assertSafeUploadTree(link), /real directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('requires each outer backup file exactly once and accepts tar leading dot-slash paths', () => {
  assert.equal(validateBackupEntries(['database.dump', 'uploads.tar.gz', 'manifest.json']), true);
  assert.equal(validateBackupEntries(['./database.dump', './uploads.tar.gz', './manifest.json']), true);
  for (const entries of [
    ['database.dump', 'uploads.tar.gz', 'uploads.tar.gz'],
    ['database.dump', 'manifest.json'],
    ['database.dump', 'uploads.tar.gz', 'manifest.json', 'extra.txt'],
    ['nested/database.dump', 'uploads.tar.gz', 'manifest.json'],
    ['database.dump', 'uploads.tar.gz', '../manifest.json']
  ]) {
    assert.throws(() => validateBackupEntries(entries), /exactly once/);
  }
});
