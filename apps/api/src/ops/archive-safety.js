const isSafeArchivePath = entry => {
  if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) return false;
  if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) return false;
  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '' || normalized === '.') return true;
  return !normalized.split('/').some(segment => segment === '..');
};

export function validateArchivePaths(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Upload archive is empty or invalid');
  }
  for (const entry of entries) {
    if (!isSafeArchivePath(entry)) {
      throw new Error('Upload archive contains an unsafe path');
    }
  }
  return true;
}

export function validateArchiveTypes(verboseLines) {
  if (!Array.isArray(verboseLines) || verboseLines.length === 0) {
    throw new Error('Upload archive listing is empty or invalid');
  }
  for (const line of verboseLines) {
    const type = typeof line === 'string' ? line[0] : '';
    if (type !== '-' && type !== 'd') {
      throw new Error('Upload archive contains a link or special file');
    }
  }
  return true;
}
