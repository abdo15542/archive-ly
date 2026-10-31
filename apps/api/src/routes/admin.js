import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router=Router();
router.use(requireAuth,requireRole('admin'));
const roles=['admin','archivist','viewer','user'];
router.get('/users',async(req,res,next)=>{
 try{
  const page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1),limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit||'50',10)||50));
  const result=await pool.query('SELECT id,full_name,email,role,is_active,created_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',[limit,(page-1)*limit]);
  const count=await pool.query('SELECT COUNT(*)::int AS total FROM users');
  res.json({users:result.rows,pagination:{page,limit,total:count.rows[0].total}});
 }catch(e){next(e);}
});
router.post('/users',async(req,res,next)=>{
 const p=z.object({fullName:z.string().trim().min(2).max(160),email:z.string().trim().email().max(254),password:z.string().min(10).max(128),role:z.enum(roles)}).safeParse(req.body);
 if(!p.success)return res.status(400).json({error:'بيانات المستخدم غير صحيحة'});
 try{
  const hash=await bcrypt.hash(p.data.password,12),client=await pool.connect();
  let created;
  try{
   await client.query('BEGIN');
   const r=await client.query('INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,full_name,email,role,is_active,created_at',[p.data.fullName,p.data.email.toLowerCase(),hash,p.data.role]);
   created=r.rows[0];
   await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address,details) VALUES($1,'user.created','user',$2,$3,$4)",[req.user.sub,created.id,req.ip,JSON.stringify({role:created.role})]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  res.status(201).json({user:created});
 }catch(e){if(e.code==='23505')return res.status(409).json({error:'البريد الإلكتروني مستخدم'});next(e);}
});
router.patch('/users/:id',async(req,res,next)=>{
 const p=z.object({fullName:z.string().trim().min(2).max(160).optional(),role:z.enum(roles).optional(),isActive:z.boolean().optional()}).strict().safeParse(req.body);
 if(!p.success||!Object.keys(p.data||{}).length)return res.status(400).json({error:'بيانات التعديل غير صحيحة'});
 if(req.params.id===req.user.sub&&(p.data.isActive===false||p.data.role&&p.data.role!=='admin'))return res.status(400).json({error:'لا يمكنك تعطيل حسابك أو سحب صلاحية المسؤول من نفسك'});
 const d=p.data,client=await pool.connect();
 try{
  await client.query('BEGIN');
  const current=await client.query('SELECT role,is_active FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);
  if(!current.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'المستخدم غير موجود'});}
  const removesAdmin=current.rows[0].role==='admin'&&(d.role!==undefined&&d.role!=='admin'||d.isActive===false);
  if(removesAdmin){
   await client.query('SELECT pg_advisory_xact_lock($1)',[72910421]);
   const count=await client.query("SELECT COUNT(*)::int AS total FROM users WHERE role='admin' AND is_active=true");
   if(count.rows[0].total<=1){await client.query('ROLLBACK');return res.status(409).json({error:'لا يمكن إزالة آخر مسؤول نشط في النظام'});}
  }
  const r=await client.query('UPDATE users SET full_name=COALESCE($2,full_name),role=COALESCE($3,role),is_active=COALESCE($4,is_active),updated_at=NOW() WHERE id=$1 RETURNING id,full_name,email,role,is_active,created_at',[req.params.id,d.fullName||null,d.role||null,d.isActive??null]);
  await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address,details) VALUES($1,'user.updated','user',$2,$3,$4)",[req.user.sub,req.params.id,req.ip,JSON.stringify(d)]);
  await client.query('COMMIT');
  res.json({user:r.rows[0]});
 }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});
router.get('/audit-logs',async(req,res,next)=>{
 try{
  const parsedPage=Number.parseInt(req.query.page||'1',10);
  const parsedLimit=Number.parseInt(req.query.limit||'50',10);
  const page=Math.min(1000000,Math.max(1,Number.isSafeInteger(parsedPage)?parsedPage:1));
  const limit=Math.min(100,Math.max(1,Number.isSafeInteger(parsedLimit)?parsedLimit:50));
  const values=[];let where='WHERE 1=1';
  if(req.query.action){values.push(String(req.query.action).trim().slice(0,80));where+=` AND a.action=$${values.length}`;}
  if(req.query.resourceType){values.push(String(req.query.resourceType).trim().slice(0,60));where+=` AND a.resource_type=$${values.length}`;}
  const count=await pool.query(`SELECT COUNT(*)::int AS total FROM audit_logs a ${where}`,values);
  values.push(limit,(page-1)*limit);
  const limitParam=values.length-1,offsetParam=values.length;
  const r=await pool.query(`SELECT a.id,a.actor_id,u.full_name AS actor_name,a.action,a.resource_type,a.resource_id,a.ip_address,a.details,a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,values);
  const total=count.rows[0].total;
  res.json({logs:r.rows,pagination:{page,limit,total,totalPages:Math.ceil(total/limit)}});
 }catch(e){next(e);}
});

router.get('/ocr/queue',async(req,res,next)=>{
 try{
  const page=Math.max(1,Number.parseInt(req.query.page||'1',10)||1);
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit||'25',10)||25));
  const allowed=new Set(['queued','processing','completed','failed']);
  const status=allowed.has(String(req.query.status||''))?String(req.query.status):null;
  const summary=await pool.query(`SELECT
    COUNT(*) FILTER (WHERE status='queued')::int AS queued,
    COUNT(*) FILTER (WHERE status='processing')::int AS processing,
    COUNT(*) FILTER (WHERE status='completed')::int AS completed,
    COUNT(*) FILTER (WHERE status='failed')::int AS failed,
    MIN(created_at) FILTER (WHERE status='queued') AS oldest_queued_at,
    MIN(locked_at) FILTER (WHERE status='processing') AS oldest_processing_lock
    FROM ocr_jobs`);
  const values=[];
  let where='';
  if(status){values.push(status);where='WHERE j.status=$1';}
  values.push(limit,(page-1)*limit);
  const limitParam=values.length-1,offsetParam=values.length;
  const jobs=await pool.query('SELECT j.id,j.document_id,d.title AS document_title,j.status,j.attempts,j.last_error,j.locked_at,j.created_at,j.updated_at FROM ocr_jobs j JOIN documents d ON d.id=j.document_id '+where+' ORDER BY CASE j.status WHEN \'failed\' THEN 0 WHEN \'processing\' THEN 1 WHEN \'queued\' THEN 2 ELSE 3 END LIMIT $'+limitParam+' OFFSET $'+offsetParam,values);
  const countValues=status?[status]:[];
  const count=await pool.query(`SELECT COUNT(*)::int AS total FROM ocr_jobs j ${status?'WHERE j.status=$1':''}`,countValues);
  res.json({summary:summary.rows[0],jobs:jobs.rows,pagination:{page,limit,total:count.rows[0].total}});
 }catch(e){next(e);}
});

router.post('/ocr/jobs/:id/retry',async(req,res,next)=>{
 const jobId=Number(req.params.id);
 if(!Number.isSafeInteger(jobId)||jobId<1)return res.status(400).json({error:'رقم مهمة OCR غير صالح'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const current=await client.query('SELECT id,document_id,status FROM ocr_jobs WHERE id=$1 FOR UPDATE',[jobId]);
  if(!current.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'مهمة OCR غير موجودة'});}
  if(current.rows[0].status!=='failed'){await client.query('ROLLBACK');return res.status(409).json({error:'يمكن إعادة تشغيل المهام الفاشلة فقط'});}
  await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE',[current.rows[0].document_id]);
  const active=await client.query("SELECT id FROM ocr_jobs WHERE document_id=$1 AND id<>$2 AND status IN ('queued','processing') LIMIT 1",[current.rows[0].document_id,jobId]);
  if(active.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'توجد مهمة OCR نشطة لهذه الوثيقة بالفعل'});}
  await client.query("UPDATE ocr_jobs SET status='queued',attempts=0,last_error=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$1",[jobId]);
  await client.query("UPDATE documents SET ocr_status='pending',updated_at=NOW() WHERE id=$1",[current.rows[0].document_id]);
  await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address,details) VALUES($1,'ocr.job.requeued','ocr_job',$2,$3,$4)",[req.user.sub,String(jobId),req.ip,JSON.stringify({documentId:current.rows[0].document_id})]);
  await client.query('COMMIT');
  res.status(202).json({jobId,status:'queued',message:'أعيدت المهمة إلى طابور المعالجة'});
 }catch(e){await client.query('ROLLBACK');next(e);}finally{client.release();}
});

export default router;
