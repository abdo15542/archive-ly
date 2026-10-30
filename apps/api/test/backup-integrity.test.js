import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

test('backup manifest SHA-256 detects modified backup components',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'archive-ly-integrity-'));
 try{
  const db=path.join(dir,'database.dump');const files=path.join(dir,'uploads.tar.gz');
  await fs.writeFile(db,'database payload');await fs.writeFile(files,'uploads payload');
  const hash=async p=>crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
  const manifest={'database.dump':await hash(db),'uploads.tar.gz':await hash(files)};
  assert.equal(await hash(db),manifest['database.dump']);assert.equal(await hash(files),manifest['uploads.tar.gz']);
  await fs.appendFile(files,'tampered');assert.notEqual(await hash(files),manifest['uploads.tar.gz']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
