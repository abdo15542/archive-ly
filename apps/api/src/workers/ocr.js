import 'dotenv/config';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pool } from '../db/pool.js';

const run=async(command,args,timeout=180000)=>{
 await new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(command+' timed out'));},timeout);
  child.stdout.on('data',d=>stdout+=d.toString());
  child.stderr.on('data',d=>stderr+=d.toString());
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(stderr.slice(-2000)||command+' exited '+code));});
  child.stdoutText=()=>stdout;
  child.stderrText=()=>stderr;
  child.on('close',()=>{child.stdoutText=()=>stdout;});
  run.lastOutput=()=>stdout;
 });
 return run.lastOutput();
};

async function commandOutput(command,args,timeout=180000){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
  let out='',err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(command+' timed out'));},timeout);
  child.stdout.on('data',d=>out+=d.toString());child.stderr.on('data',d=>err+=d.toString());
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error(err.slice(-2000)||command+' exited '+code));});
 });
}
async function ocrImage(file){
 return commandOutput('tesseract',[file,'stdout','-l',process.env.TESSERACT_LANG||'ara+eng','--psm','3'],180000);
}
async function extractDocument(doc){
 const root=path.resolve(process.env.UPLOAD_DIR||'./uploads'),file=path.join(root,doc.stored_name);
 await fs.access(file);
 if(doc.mime_type!=='application/pdf')return (await ocrImage(file)).trim();
 let text='';
 try{text=(await commandOutput('pdftotext',['-layout',file,'-'],60000)).trim();}catch{}
 if(text.length>40)return text;
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'archive-ocr-'));
 try{
  const prefix=path.join(temp,'page');
  await commandOutput('pdftoppm',['-f','1','-l',String(Number(process.env.OCR_MAX_PDF_PAGES||15)),'-r','180','-png',file,prefix],180000);
  const pages=(await fs.readdir(temp)).filter(n=>n.endsWith('.png')).sort();
  if(!pages.length)throw new Error('لم يمكن تحويل صفحات PDF إلى صور');
  const extracted=[];
  for(const page of pages)extracted.push(await ocrImage(path.join(temp,page)));
  return extracted.join('\n\n').trim();
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}

let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});

async function claim(){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const r=await client.query(`SELECT j.id,j.document_id,d.stored_name,d.mime_type
   FROM ocr_jobs j JOIN documents d ON d.id=j.document_id
   WHERE j.status='queued' OR (j.status='processing' AND j.locked_at<NOW()-INTERVAL '15 minutes')
   ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
  if(!r.rowCount){await client.query('COMMIT');return null;}
  const job=r.rows[0];
  await client.query("UPDATE ocr_jobs SET status='processing',attempts=attempts+1,locked_at=NOW(),updated_at=NOW() WHERE id=$1",[job.id]);
  await client.query("UPDATE documents SET ocr_status='processing',updated_at=NOW() WHERE id=$1",[job.document_id]);
  await client.query('COMMIT');return job;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function processJob(job){
 try{
  const text=await extractDocument(job);
  await pool.query("UPDATE documents SET extracted_text=$2,ocr_status='completed',updated_at=NOW() WHERE id=$1",[job.document_id,text]);
  await pool.query("UPDATE ocr_jobs SET status='completed',last_error=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$1",[job.id]);
  console.log('OCR completed:',job.document_id,'characters:',text.length);
 }catch(error){
  const result=await pool.query('SELECT attempts FROM ocr_jobs WHERE id=$1',[job.id]);
  const attempts=result.rows[0]?.attempts||1;
  const status=attempts>=3?'failed':'queued';
  await pool.query('UPDATE ocr_jobs SET status=$2,last_error=$3,locked_at=NULL,updated_at=NOW() WHERE id=$1',[job.id,status,String(error.message).slice(0,2000)]);
  await pool.query('UPDATE documents SET ocr_status=$2,updated_at=NOW() WHERE id=$1',[job.document_id,status==='failed'?'failed':'pending']);
  console.error('OCR job failed:',job.document_id,error.message);
 }
}
console.log('Arabic OCR worker started; language:',process.env.TESSERACT_LANG||'ara+eng');
while(!stopping){
 try{const job=await claim();if(job)await processJob(job);else await new Promise(r=>setTimeout(r,2500));}
 catch(error){console.error('OCR worker loop error:',error.message);await new Promise(r=>setTimeout(r,5000));}
}
await pool.end();
