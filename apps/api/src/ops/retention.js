import fs from 'node:fs/promises';
import path from 'node:path';

const PREFIX='archive-ly-backup-';
const SUFFIX='.tar.gz';

export async function pruneBackups(directory, retentionDays=30, now=Date.now()) {
  const days=Number(retentionDays);
  if(!Number.isInteger(days)||days<1||days>3650) throw new Error('BACKUP_RETENTION_DAYS must be an integer between 1 and 3650');
  await fs.mkdir(directory,{recursive:true});
  const cutoff=now-days*24*60*60*1000;
  const removed=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    if(!entry.isFile()||!entry.name.startsWith(PREFIX)||!entry.name.endsWith(SUFFIX)) continue;
    const fullPath=path.join(directory,entry.name);
    const stat=await fs.lstat(fullPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.mtimeMs>=cutoff) continue;
    await fs.unlink(fullPath);
    removed.push(entry.name);
  }
  return removed;
}
