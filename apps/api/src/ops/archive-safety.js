import fs from 'node:fs/promises';
import path from 'node:path';

const isSafeArchivePath = entry => {
  if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) return false;
  const portable = entry.replaceAll(String.fromCharCode(92), '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) return false;
  const normalized = portable.replace(/^\.\//, '');
  if (normalized === '' || normalized === '.') return true;
  return !normalized.split('/').some(segment => segment === '..');
};

export function validateArchivePaths(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Upload archive is empty or invalid');
  for (const entry of entries) if (!isSafeArchivePath(entry)) throw new Error('Upload archive contains an unsafe path');
  return true;
}

export function validateArchiveTypes(verboseLines) {
  if (!Array.isArray(verboseLines) || verboseLines.length === 0) throw new Error('Upload archive listing is empty or invalid');
  for (const line of verboseLines) {
    const type = typeof line === 'string' ? line[0] : '';
    if (type !== '-' && type !== 'd') throw new Error('Upload archive contains a link or special file');
  }
  return true;
}

// Refuse symlinks and special files at every depth before creating a portable backup.
export async function assertSafeUploadTree(directory) {
  const rootStat = await fs.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Uploads path must be a real directory, not a link or special file');
  }
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) throw new Error('Uploads directory contains a symbolic link: ' + path.relative(directory, fullPath));
      if (stat.isDirectory()) await visit(fullPath);
      else if (!stat.isFile()) throw new Error('Uploads directory contains a special filesystem entry: ' + path.relative(directory, fullPath));
    }
  }
  await visit(directory);
  return true;
}
