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

// tar may preserve a harmless leading "./" from archives created with -C DIR . or
// emit paths without it. Normalize that representation, but never accept nested,
// absolute, duplicate, or unexpected entries in the outer backup container.
export function validateBackupEntries(entries) {
  const allowed = ['database.dump', 'uploads.tar.gz', 'manifest.json'];
  const normalized = Array.isArray(entries)
    ? entries.map(entry => typeof entry === 'string' ? entry.replace(/^\.\//, '') : entry)
    : entries;
  if (!Array.isArray(normalized) || normalized.length !== allowed.length ||
      new Set(normalized).size !== allowed.length ||
      allowed.some(name => !normalized.includes(name)) ||
      normalized.some(name => typeof name !== 'string' || name.includes('/') || name.includes('\\') || name === '' || name === '.' || name === '..')) {
    throw new Error('Backup archive must contain each required file exactly once');
  }
  return true;
}
