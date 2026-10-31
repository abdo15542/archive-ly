import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { validateArchivePaths, validateArchiveTypes, validateBackupEntries } from './archive-safety.js';
import { fileURLToPath } from 'node:url';

const run=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url));
const uploadDir=path.resolve(process.env.UPLOAD_DIR||path.resolve(here,'../../uploads'));
const databaseUrl=process.env.DATABASE_URL;
const archive=process.argv[2];
const digest=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

if(!databaseUrl||!archive){
 console.error('Usage: npm run restore -- /absolute/path/to/backup.tar.gz (DATABASE_URL is required)');
 process.exit(1);
}
const work=await fs.mkdtemp(path.join(os.tmpdir(),'archive-ly-restore-'));
let oldUploads='';
try{
 const archivePath=path.resolve(archive);
 const outerListing=(await run('tar',['-tzf',archivePath])).stdout.split('\n').filter(Boolean);
 validateBackupEntries(outerListing);
 const outerTypes=(await run('tar',['-tvzf',archivePath])).stdout.split('\n').filter(Boolean);
 validateArchiveTypes(outerTypes);
 await run('tar',['-xzf',archivePath,'-C',work]);
 const manifest=JSON.parse(await fs.readFile(path.join(work,'manifest.json'),'utf8'));
 if(manifest.format!=='archive-ly-backup-v1'||!manifest.files?.['database.dump']||!manifest.files?.['uploads.tar.gz'])throw new Error('Unsupported or incomplete backup manifest');
 for(const name of ['database.dump','uploads.tar.gz']){
  if(await digest(path.join(work,name))!==manifest.files[name])throw new Error('SHA-256 verification failed for '+name);
 }
 const stagedUploads=path.join(work,'restored-uploads');
 await fs.mkdir(stagedUploads);
 const uploadsArchive=path.join(work,'uploads.tar.gz');
 const uploadEntries=(await run('tar',['-tzf',uploadsArchive])).stdout.split('\n').filter(Boolean);
 validateArchivePaths(uploadEntries);
 const verbose=(await run('tar',['-tvzf',uploadsArchive])).stdout.split('\n').filter(Boolean);
 validateArchiveTypes(verbose);
 await run('tar',['-xzf',uploadsArchive,'-C',stagedUploads]);
 console.log('Checksums verified. Restoring database...');
 await run('pg_restore',['--clean','--if-exists','--no-owner','--no-acl','--single-transaction','--dbname',databaseUrl,path.join(work,'database.dump')]);
 await fs.mkdir(path.dirname(uploadDir),{recursive:true});
 try{
  await fs.access(uploadDir);
  oldUploads=uploadDir+'.pre-restore-'+Date.now();
  await fs.rename(uploadDir,oldUploads);
 }catch(e){if(e.code!=='ENOENT')throw e;}
 try{await fs.rename(stagedUploads,uploadDir);}
 catch(e){if(oldUploads)await fs.rename(oldUploads,uploadDir);throw e;}
 if(oldUploads)await fs.rm(oldUploads,{recursive:true,force:true});
 console.log(JSON.stringify({status:'restored',backup:archivePath,createdAt:manifest.createdAt,uploadDir},null,2));
}catch(error){
 console.error('Restore failed:',error.stderr||error.message);
 process.exitCode=1;
}finally{
 await fs.rm(work,{recursive:true,force:true});
}
