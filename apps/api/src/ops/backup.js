import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafeUploadTree } from './archive-safety.js';

const run=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url));
const uploadDir=path.resolve(process.env.UPLOAD_DIR||path.resolve(here,'../../uploads'));
const backupDir=path.resolve(process.env.BACKUP_DIR||path.resolve(here,'../../../../backups'));
const databaseUrl=process.env.DATABASE_URL;
const digest=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
let temporaryOutput='';

if(!databaseUrl){console.error('DATABASE_URL is required');process.exit(1);}
await fs.mkdir(backupDir,{recursive:true});
const work=await fs.mkdtemp(path.join(os.tmpdir(),'archive-ly-backup-'));
try{
 const dump=path.join(work,'database.dump');const uploads=path.join(work,'uploads.tar.gz');
 await run('pg_dump',['--format=custom','--no-owner','--no-acl','--file',dump,databaseUrl]);
 await fs.mkdir(uploadDir,{recursive:true});
 await assertSafeUploadTree(uploadDir);
 await run('tar',['-czf',uploads,'-C',uploadDir,'.']);
 const manifest={format:'archive-ly-backup-v1',createdAt:new Date().toISOString(),files:{'database.dump':await digest(dump),'uploads.tar.gz':await digest(uploads)}};
 await fs.writeFile(path.join(work,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 const output=path.join(backupDir,'archive-ly-backup-'+stamp+'-'+process.pid+'.tar.gz');
 temporaryOutput=output+'.partial';
 await run('tar',['-czf',temporaryOutput,'-C',work,'database.dump','uploads.tar.gz','manifest.json']);
 await fs.chmod(temporaryOutput,0o600);
 // Publish only a complete archive: rename is atomic because the temporary file is on the same filesystem.
 await fs.rename(temporaryOutput,output);
 temporaryOutput='';
 console.log(JSON.stringify({status:'created',file:output,sha256:await digest(output),manifest},null,2));
}catch(error){console.error('Backup failed:',error.stderr||error.message);process.exitCode=1;}
finally{
 if(temporaryOutput)await fs.rm(temporaryOutput,{force:true});
 await fs.rm(work,{recursive:true,force:true});
}
