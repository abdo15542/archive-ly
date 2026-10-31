import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArchivePaths, validateArchiveTypes } from '../src/ops/archive-safety.js';

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
