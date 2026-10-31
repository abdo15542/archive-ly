import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sha256File } from './file-hash.js';
import { validateArchivePaths, validateArchiveTypes, validateBackupEntries } from './archive-safety.js';
import { restoreWithUploadSwap } from './restore-files.js';
import { fileURLToPath } from 'node:url';
import { startOperation, finishOperation } from './operation-log.js';
import { pool } from '../db/pool.js';

const run=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url));
const uploadDir=path.resolve(process.env.UPLOAD_DIR||path.resolve(here,'../../uploads'));
const databaseUrl=process.env.DATABASE_URL;
const archive=process.argv[2];

if(!databaseUrl||!archive){
 console.error('Usage: npm run restore -- /absolute/path/to/backup.tar.gz (DATABASE_URL is required)');
 process.exit(1);
}
const work=await fs.mkdtemp(path.join(os.tmpdir(),'archive-ly-restore-'));
let stageRoot='';
let operation=null;
try{
 operation=await startOperation('restore',{source:path.basename(path.resolve(archive))});
 const archivePath=path.resolve(archive);
 const outerListing=(await run('tar',['-tzf',archivePath])).stdout.split(/\r?\n/).filter(Boolean);
 validateBackupEntries(outerListing);
 const outerTypes=(await run('tar',['-tvzf',archivePath])).stdout.split(/\r?\n/).filter(Boolean);
 validateArchiveTypes(outerTypes);
 await run('tar',['-xzf',archivePath,'-C',work]);
 const manifest=JSON.parse(await fs.readFile(path.join(work,'manifest.json'),'utf8'));
 if(manifest.format!=='archive-ly-backup-v1'||!manifest.files?.['database.dump']||!manifest.files?.['uploads.tar.gz'])throw new Error('Unsupported or incomplete backup manifest');
 for(const name of ['database.dump','uploads.tar.gz']){
  if(await sha256File(path.join(work,name))!==manifest.files[name])throw new Error('SHA-256 verification failed for '+name);
 }
 // Stage beside the live uploads directory so the final rename stays on one filesystem.
 const uploadParent=path.dirname(uploadDir);
 await fs.mkdir(uploadParent,{recursive:true});
 stageRoot=await fs.mkdtemp(path.join(uploadParent,'.archive-ly-restore-stage-'));
 const stagedUploads=path.join(stageRoot,'uploads');
 await fs.mkdir(stagedUploads);
 const uploadsArchive=path.join(work,'uploads.tar.gz');
 const uploadEntries=(await run('tar',['-tzf',uploadsArchive])).stdout.split(/\r?\n/).filter(Boolean);
 validateArchivePaths(uploadEntries);
 const verbose=(await run('tar',['-tvzf',uploadsArchive])).stdout.split(/\r?\n/).filter(Boolean);
 validateArchiveTypes(verbose);
 await run('tar',['-xzf',uploadsArchive,'-C',stagedUploads]);
 console.log('Checksums verified. Switching uploads safely and restoring database...');
 await restoreWithUploadSwap({
  uploadDir,
  stagedUploads,
  restoreDatabase:()=>run('pg_restore',['--clean','--if-exists','--no-owner','--no-acl','--single-transaction','--dbname',databaseUrl,path.join(work,'database.dump')])
 });
 const archiveStat=await fs.stat(archivePath);
 await finishOperation(operation.id,{status:'succeeded',artifactName:path.basename(archivePath),artifactSizeBytes:archiveStat.size,metadata:{createdAt:manifest.createdAt}});
 console.log(JSON.stringify({status:'restored',backup:archivePath,createdAt:manifest.createdAt,uploadDir},null,2));
}catch(error){
 console.error('Restore failed:',error.stderr||error.message);
 if(operation)await finishOperation(operation.id,{status:'failed',artifactName:path.basename(path.resolve(archive)),error:error.stderr||error.message}).catch(logError=>console.error('Could not persist restore failure log:',logError.message));
 process.exitCode=1;
}finally{
 await fs.rm(work,{recursive:true,force:true});
 if(stageRoot)await fs.rm(stageRoot,{recursive:true,force:true}).catch(error=>{
  console.error('Restore staging cleanup required:',error.message);
 });
 await pool.end();
}
