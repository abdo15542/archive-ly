import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validFile } from '../utils/file-validation.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router=Router();
router.use(requireAuth);
const here=path.dirname(fileURLToPath(import.meta.url));
const uploadDir=path.resolve(process.env.UPLOAD_DIR || path.join(here,'../../uploads'));
fs.mkdirSync(uploadDir,{recursive:true});
const allowed=new Set(['application/pdf','image/jpeg','image/png','image/tiff']);
const storage=multer.diskStorage({destination:(_req,_file,cb)=>cb(null,uploadDir),filename:(_req,_file,cb)=>cb(null,crypto.randomUUID())});
const upload=multer({storage,limits:{fileSize:Number(process.env.MAX_FILE_SIZE_MB||30)*1024*1024,files:1},fileFilter:(_req,file,cb)=>allowed.has(file.mimetype)?cb(null,true):cb(Object.assign(new Error('نوع الملف غير مدعوم'),{status:415}))});

async function audit(actor,action,id,ip,details={}){
 await pool.query('INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address,details) VALUES($1,$2,$3,$4,$5,$6)',[actor,action,'document',id,ip,JSON.stringify(details)]);
}

router.get('/',async(req,res,next)=>{
 try{
  const page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1),limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit||'20',10)||20));
  const q=String(req.query.q||'').trim().slice(0,200),category=req.query.category||null,values=[];let where='WHERE 1=1';
  if(category&&!z.string().uuid().safeParse(String(category)).success)return res.status(400).json({error:'معرّف التصنيف غير صالح'});
  if(q){values.push(q);where+=` AND (title ILIKE '%'||$1||'%' OR subject ILIKE '%'||$1||'%' OR extracted_text ILIKE '%'||$1||'%' OR document_number ILIKE '%'||$1||'%')`;}
  if(category){values.push(String(category));where+=` AND category_id=${values.length}`;}
  const count=await pool.query(`SELECT COUNT(*)::int AS total FROM documents ${where}`,values);
  values.push(limit,page*limit-limit);
  const result=await pool.query(`SELECT id,title,document_number,subject,issuing_entity,document_date,category_id,original_name,mime_type,file_size,ocr_status,created_at FROM documents ${where} ORDER BY created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  res.json({documents:result.rows,pagination:{page,limit,total:count.rows[0].total}});
 }catch(e){next(e);}
});

router.post('/',requireRole('admin','archivist'),(req,res,next)=>{
 upload.single('file')(req,res,async(err)=>{
  if(err)return res.status(err.status||400).json({error:err.message});
  if(!req.file)return res.status(400).json({error:'يرجى إرفاق ملف'});
  try{
   const parsed=z.object({title:z.string().trim().min(2).max(250),documentNumber:z.string().max(100).optional(),subject:z.string().max(5000).optional(),issuingEntity:z.string().max(200).optional(),documentDate:z.string().date().optional(),categoryId:z.string().uuid().optional()}).safeParse(req.body);
   if(!parsed.success){fs.unlinkSync(req.file.path);return res.status(400).json({error:'بيانات الوثيقة غير صحيحة'});}
   if(!validFile(req.file.path,req.file.mimetype)){fs.unlinkSync(req.file.path);return res.status(415).json({error:'محتوى الملف لا يطابق نوعه المعلن'});}
   const sha=crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex'),d=parsed.data;
   const client=await pool.connect();
   let r;
   try{
    await client.query('BEGIN');
    r=await client.query(`INSERT INTO documents(title,document_number,subject,issuing_entity,document_date,category_id,original_name,stored_name,mime_type,file_size,sha256,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id,title,document_number,subject,issuing_entity,document_date,category_id,original_name,mime_type,file_size,ocr_status,created_at`,
    [d.title,d.documentNumber||null,d.subject||null,d.issuingEntity||null,d.documentDate||null,d.categoryId||null,req.file.originalname,req.file.filename,req.file.mimetype,req.file.size,sha,req.user.sub]);
    await client.query('INSERT INTO ocr_jobs(document_id) VALUES($1)',[r.rows[0].id]);
    await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address) VALUES($1,'document.created','document',$2,$3)",[req.user.sub,r.rows[0].id,req.ip]);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   res.status(201).json({document:r.rows[0],ocr:{status:'queued'}});
  }catch(e){try{fs.unlinkSync(req.file.path);}catch{}next(e);}
 });
});

router.get('/:id',async(req,res,next)=>{
 try{const r=await pool.query('SELECT id,title,document_number,subject,issuing_entity,document_date,category_id,original_name,mime_type,file_size,ocr_status,extracted_text,created_at,updated_at FROM documents WHERE id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'الوثيقة غير موجودة'});res.json({document:r.rows[0]});}
 catch(e){next(e);}
});
router.patch('/:id',requireRole('admin','archivist'),async(req,res,next)=>{
 try{
  const p=z.object({title:z.string().trim().min(2).max(250).optional(),documentNumber:z.string().max(100).nullable().optional(),subject:z.string().max(5000).nullable().optional(),issuingEntity:z.string().max(200).nullable().optional(),documentDate:z.string().date().nullable().optional(),categoryId:z.string().uuid().nullable().optional()}).strict().safeParse(req.body);
  if(!p.success||!Object.keys(p.data||{}).length)return res.status(400).json({error:'بيانات التعديل غير صحيحة'});
  const d=p.data,client=await pool.connect();
  let updated;
  try{
   await client.query('BEGIN');
   const r=await client.query(`UPDATE documents SET title=COALESCE($2,title),document_number=CASE WHEN $3 THEN $4 ELSE document_number END,subject=CASE WHEN $5 THEN $6 ELSE subject END,issuing_entity=CASE WHEN $7 THEN $8 ELSE issuing_entity END,document_date=CASE WHEN $9 THEN $10::date ELSE document_date END,category_id=CASE WHEN $11 THEN $12::uuid ELSE category_id END,updated_at=NOW() WHERE id=$1 RETURNING id,title,document_number,subject,issuing_entity,document_date,category_id,ocr_status,updated_at`,
   [req.params.id,d.title??null,'documentNumber'in d,d.documentNumber??null,'subject'in d,d.subject??null,'issuingEntity'in d,d.issuingEntity??null,'documentDate'in d,d.documentDate??null,'categoryId'in d,d.categoryId??null]);
   if(!r.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الوثيقة غير موجودة'});}
   updated=r.rows[0];
   await client.query('INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address) VALUES($1,$2,$3,$4,$5)',[req.user.sub,'document.updated','document',req.params.id,req.ip]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  res.json({document:updated});
 }catch(e){next(e);}
});
router.post('/:id/ocr/retry',requireRole('admin','archivist'),async(req,res,next)=>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const document=await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE',[req.params.id]);
  if(!document.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الوثيقة غير موجودة'});}
  const active=await client.query("SELECT id,status FROM ocr_jobs WHERE document_id=$1 AND status IN ('queued','processing') ORDER BY id DESC LIMIT 1",[req.params.id]);
  if(active.rowCount){
   await client.query('ROLLBACK');
   return res.status(202).json({status:active.rows[0].status,jobId:active.rows[0].id,message:'توجد مهمة OCR نشطة لهذه الوثيقة بالفعل'});
  }
  const queued=await client.query("INSERT INTO ocr_jobs(document_id,status) VALUES($1,'queued') RETURNING id",[req.params.id]);
  await client.query("UPDATE documents SET ocr_status='pending',updated_at=NOW() WHERE id=$1",[req.params.id]);
  await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address,details) VALUES($1,'document.ocr.retry','document',$2,$3,$4)",[req.user.sub,req.params.id,req.ip,JSON.stringify({jobId:queued.rows[0].id})]);
  await client.query('COMMIT');
  res.status(202).json({status:'queued',jobId:queued.rows[0].id});
 }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});
router.get('/:id/file',async(req,res,next)=>{
 try{
  const r=await pool.query('SELECT stored_name,original_name,mime_type FROM documents WHERE id=$1',[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'الوثيقة غير موجودة'});
  const filePath=path.join(uploadDir,r.rows[0].stored_name);if(!fs.existsSync(filePath))return res.status(404).json({error:'ملف الوثيقة غير متاح'});
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Type',r.rows[0].mime_type);res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(r.rows[0].original_name)}`);
  fs.createReadStream(filePath).pipe(res);
 }catch(e){next(e);}
});
router.delete('/:id',requireRole('admin','archivist'),async(req,res,next)=>{
 const client=await pool.connect();
 let storedName;
 try{
  await client.query('BEGIN');
  const found=await client.query('SELECT stored_name FROM documents WHERE id=$1 FOR UPDATE',[req.params.id]);
  if(!found.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الوثيقة غير موجودة'});}
  storedName=found.rows[0].stored_name;
  await client.query('DELETE FROM documents WHERE id=$1',[req.params.id]);
  await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address) VALUES($1,'document.deleted','document',$2,$3)",[req.user.sub,req.params.id,req.ip]);
  await client.query('COMMIT');
 }catch(e){
  try{await client.query('ROLLBACK');}catch{}
  return next(e);
 }finally{client.release();}
 const filePath=path.join(uploadDir,storedName);
 try{fs.unlinkSync(filePath);}catch(error){
  if(error.code!=='ENOENT')console.error('Could not remove archived document file:',{documentId:req.params.id,error});
 }
 res.status(204).end();
});

router.patch('/:id/ocr',requireRole('admin','archivist'),async(req,res,next)=>{
 try{
  const parsed=z.object({text:z.string().max(2000000)}).strict().safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'نص OCR غير صالح أو يتجاوز الحد المسموح'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const updated=await client.query("UPDATE documents SET extracted_text=$2,ocr_status='completed',updated_at=NOW() WHERE id=$1 RETURNING id,title,ocr_status,updated_at",[req.params.id,parsed.data.text]);
   if(!updated.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الوثيقة غير موجودة'});}
   await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address,details) VALUES($1,'document.ocr.corrected','document',$2,$3,$4)",[req.user.sub,req.params.id,req.ip,JSON.stringify({textLength:parsed.data.text.length})]);
   await client.query('COMMIT');
   res.json({document:updated.rows[0],message:'تم حفظ النص المصحح'});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }catch(e){next(e);}
});

export default router;
