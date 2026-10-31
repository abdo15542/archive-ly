import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Install staged uploads before the database restore. If the database restore
 * fails, put the previous uploads directory back before propagating the error.
 * stagedUploads must live on the same filesystem as uploadDir for atomic renames.
 */
export async function restoreWithUploadSwap({ uploadDir, stagedUploads, restoreDatabase }) {
  if (typeof restoreDatabase !== 'function') throw new TypeError('restoreDatabase must be a function');
  const target = path.resolve(uploadDir);
  const staged = path.resolve(stagedUploads);
  const parent = path.dirname(target);
  if (path.dirname(staged) === target || staged === target || !staged.startsWith(parent + path.sep)) {
    throw new Error('Staged uploads must be a sibling path under the uploads parent directory');
  }

  await fs.mkdir(parent, { recursive: true });
  const [parentStat, stagedStat] = await Promise.all([fs.stat(parent), fs.lstat(staged)]);
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
    throw new Error('Staged uploads must be a real directory');
  }
  if (parentStat.dev !== stagedStat.dev) {
    throw new Error('Staged uploads and live uploads must be on the same filesystem');
  }

  const rollbackRoot = await fs.mkdtemp(path.join(parent, '.archive-ly-restore-rollback-'));
  const previous = path.join(rollbackRoot, 'previous-uploads');
  let hadPrevious = false;
  let installed = false;
  try {
    try {
      const current = await fs.lstat(target);
      if (!current.isDirectory() || current.isSymbolicLink()) {
        throw new Error('Live uploads path must be a real directory');
      }
      await fs.rename(target, previous);
      hadPrevious = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await fs.rename(staged, target);
    installed = true;
    await restoreDatabase();
  } catch (error) {
    try {
      if (installed) await fs.rm(target, { recursive: true, force: true });
      if (hadPrevious) await fs.rename(previous, target);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Database restore failed and uploads rollback also failed');
    }
    throw error;
  } finally {
    // If rollback itself failed, retain the rollback directory for manual recovery.
    if (!hadPrevious || installed || await exists(previous)) {
      await fs.rm(rollbackRoot, { recursive: true, force: true }).catch(error => {
        console.error('Could not remove restore rollback directory:', error.message);
      });
    }
  }

  // A cleanup failure must not turn a successful database+uploads restore into
  // a reported failure: the old copy is safe to remove manually later.
  await fs.rm(rollbackRoot, { recursive: true, force: true }).catch(error => {
    console.error('Restore succeeded; old uploads cleanup is pending:', error.message);
  });
  return { status: 'restored' };
}

async function exists(filePath) {
  try { await fs.lstat(filePath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
