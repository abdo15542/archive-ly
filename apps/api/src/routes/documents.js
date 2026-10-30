import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router=Router();
router.use(requireAuth);
const here=path.dirname(fileURLToPath(import.meta.url));
const uploadDir=path.resolve(process.env.UPLOAD_DIR || path.join(here,'../../uploads'));
fs.mkdirSync(uploadDir,{recursive:true});
const allowed=new Set(['application/pdf','image/jpeg','image/png','image/tiff']);
const storage=multer.diskStorage({
  destination:(_req,_file,cb)=>cb(null,uploadDir),
  filename:(_req,_file,cb)=>cb(null,crypto.randomUUID())
});
const upload=multer({
  storage,
  limits:{fileSize:Number(process.env.MAX_FILE_SIZE_MB||30)*1024*1024,files:1},
  fileFilter:(_req,file,cb)=>allowed.has(file.mimetype)?cb(null,true):cb(Object.assign(new Error('نوع الملف غير مدعوم'),{status:415}))
});

router.get('/',async(req,res,next)=>{
  try{
    const page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1);
    const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit||'20',10)||20));
    const q=String(req.query.q||'').trim().slice(0,200);
    const category=req.query.category||null;
    const values=[]; let where='WHERE 1=1';
    if(q){values.push(q);where+=` AND (title ILIKE '%'||$1||'%' OR subject ILIKE '%'||$1||'%' OR extracted_text ILIKE '%'||$1||'%' OR document_number ILIKE '%'||$1||'%')`;}
    if(category){values.push(category);where+=` AND category_id=$${values.length}`;}
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
      const p=z.object({
        title:z.string().trim().min(2).max(250),
        documentNumber:z.string().max(100).optional(),
        subject:z.string().max(5000).optional(),
        issuingEntity:z.string().max(200).optional(),
        documentDate:z.string().date().optional(),
        categoryId:z.string().uuid().optional()
      }).safeParse(req.body);
      if(!p.success){fs.unlinkSync(req.file.path);return res.status(400).json({error:'بيانات الوثيقة غير صحيحة'});}
      const bytes=fs.readFileSync(req.file.path);
      const sha=crypto.createHash('sha256').update(bytes).digest('hex');
      const d=p.data;
      const r=await pool.query(`INSERT INTO documents(title,document_number,subject,issuing_entity,document_date,category_id,original_name,stored_name,mime_type,file_size,sha256,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id,title,document_number,subject,issuing_entity,document_date,category_id,original_name,mime_type,file_size,ocr_status,created_at`,
      [d.title,d.documentNumber||null,d.subject||null,d.issuingEntity||null,d.documentDate||null,d.categoryId||null,req.file.originalname,req.file.filename,req.file.mimetype,req.file.size,sha,req.user.sub]);
      await pool.query('INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address) VALUES($1,$2,$3,$4,$5)',[req.user.sub,'document.created','document',r.rows[0].id,req.ip]);
      res.status(201).json({document:r.rows[0]});
    }catch(e){try{fs.unlinkSync(req.file.path);}catch{} next(e);}
  });
});

router.get('/:id/file',async(req,res,next)=>{
  try{
    const r=await pool.query('SELECT stored_name,original_name,mime_type FROM documents WHERE id=$1',[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:'الوثيقة غير موجودة'});
    const filePath=path.join(uploadDir,r.rows[0].stored_name);
    if(!fs.existsSync(filePath))return res.status(404).json({error:'ملف الوثيقة غير متاح'});
    res.setHeader('Content-Type',r.rows[0].mime_type);
    res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(r.rows[0].original_name)}`);
    fs.createReadStream(filePath).pipe(res);
  }catch(e){next(e);}
});

router.delete('/:id',requireRole('admin','archivist'),async(req,res,next)=>{
  try{
    const r=await pool.query('DELETE FROM documents WHERE id=$1 RETURNING stored_name',[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:'الوثيقة غير موجودة'});
    const filePath=path.join(uploadDir,r.rows[0].stored_name);
    if(fs.existsSync(filePath))fs.unlinkSync(filePath);
    await pool.query('INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address) VALUES($1,$2,$3,$4,$5)',[req.user.sub,'document.deleted','document',req.params.id,req.ip]);
    res.status(204).end();
  }catch(e){next(e);}
});
export default router;
