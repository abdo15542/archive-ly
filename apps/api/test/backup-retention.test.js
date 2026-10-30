import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneBackups } from '../src/ops/retention.js';

test('retention removes only expired project backup archives',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'archive-ly-retention-'));
 try{
  const old=path.join(dir,'archive-ly-backup-old.tar.gz');
  const recent=path.join(dir,'archive-ly-backup-new.tar.gz');
  const unrelated=path.join(dir,'database.dump');
  await Promise.all([fs.writeFile(old,'old'),fs.writeFile(recent,'new'),fs.writeFile(unrelated,'keep')]);
  const now=Date.now();
  await fs.utimes(old,new Date(now-40*86400000),new Date(now-40*86400000));
  const removed=await pruneBackups(dir,30,now);
  assert.deepEqual(removed,['archive-ly-backup-old.tar.gz']);
  await assert.rejects(fs.access(old));
  await fs.access(recent);
  await fs.access(unrelated);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('retention rejects unsafe retention periods',async()=>{
 await assert.rejects(()=>pruneBackups(os.tmpdir(),0),/BACKUP_RETENTION_DAYS/);
 await assert.rejects(()=>pruneBackups(os.tmpdir(),1.5),/BACKUP_RETENTION_DAYS/);
});
