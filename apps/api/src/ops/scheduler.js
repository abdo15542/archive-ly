import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneBackups } from './retention.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const backupScript=path.join(here,'backup.js');
const backupDir=path.resolve(process.env.BACKUP_DIR||path.resolve(here,'../../../../backups'));
const intervalHours=Number(process.env.BACKUP_INTERVAL_HOURS||24);
const retentionDays=Number(process.env.BACKUP_RETENTION_DAYS||30);

if(!Number.isFinite(intervalHours)||intervalHours<1||intervalHours>8760) {
  console.error('BACKUP_INTERVAL_HOURS must be between 1 and 8760');
  process.exit(1);
}
if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>3650) {
  console.error('BACKUP_RETENTION_DAYS must be an integer between 1 and 3650');
  process.exit(1);
}

let stopping=false;
let activeChild=null;
let timer=null;
const intervalMs=intervalHours*60*60*1000;

function runBackup() {
  return new Promise((resolve,reject)=>{
    console.log('[backup-scheduler] Starting backup:',new Date().toISOString());
    const child=spawn(process.execPath,[backupScript],{stdio:'inherit',env:process.env});
    activeChild=child;
    child.once('error',reject);
    child.once('close',code=>{
      activeChild=null;
      if(code!==0){reject(new Error('Backup process exited with code '+code));return;}
      resolve();
    });
  });
}

async function cycle() {
  if(stopping)return;
  try {
    await runBackup();
    const removed=await pruneBackups(backupDir,retentionDays);
    console.log('[backup-scheduler] Backup succeeded; expired backups removed:',removed.length);
  } catch(error) {
    console.error('[backup-scheduler] Backup cycle failed:',error.message);
  } finally {
    if(!stopping) timer=setTimeout(cycle,intervalMs);
  }
}

function shutdown(signal) {
  if(stopping)return;
  stopping=true;
  console.log('[backup-scheduler] Received',signal,'; shutting down');
  if(timer)clearTimeout(timer);
  if(activeChild)activeChild.kill('SIGTERM');
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

console.log('[backup-scheduler] Interval hours:',intervalHours,'Retention days:',retentionDays);
await cycle();
