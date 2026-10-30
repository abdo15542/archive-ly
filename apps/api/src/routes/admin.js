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
 try{
  const p=z.object({fullName:z.string().trim().min(2).max(160),email:z.string().trim().email().max(254),password:z.string().min(10).max(128),role:z.enum(roles)}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'بيانات المستخدم غير صحيحة'});
  const hash=await bcrypt.hash(p.data.password,12);
  const r=await pool.query('INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,full_name,email,role,is_active,created_at',[p.data.fullName,p.data.email.toLowerCase(),hash,p.data.role]);
  await pool.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address) VALUES($1,'user.created','user',$2,$3)",[req.user.sub,r.rows[0].id,req.ip]);
  res.status(201).json({user:r.rows[0]});
 }catch(e){if(e.code==='23505')return res.status(409).json({error:'البريد الإلكتروني مستخدم'});next(e);}
});
router.patch('/users/:id',async(req,res,next)=>{
 try{
  const p=z.object({fullName:z.string().trim().min(2).max(160).optional(),role:z.enum(roles).optional(),isActive:z.boolean().optional()}).strict().safeParse(req.body);
  if(!p.success||!Object.keys(p.data||{}).length)return res.status(400).json({error:'بيانات التعديل غير صحيحة'});
  if(req.params.id===req.user.sub&&(p.data.isActive===false||p.data.role&&p.data.role!=='admin'))return res.status(400).json({error:'لا يمكنك تعطيل حسابك أو سحب صلاحية المسؤول من نفسك'});
  const d=p.data;
  const r=await pool.query('UPDATE users SET full_name=COALESCE($2,full_name),role=COALESCE($3,role),is_active=COALESCE($4,is_active),updated_at=NOW() WHERE id=$1 RETURNING id,full_name,email,role,is_active,created_at',[req.params.id,d.fullName||null,d.role||null,d.isActive??null]);
  if(!r.rowCount)return res.status(404).json({error:'المستخدم غير موجود'});
  await pool.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,ip_address,details) VALUES($1,'user.updated','user',$2,$3,$4)",[req.user.sub,req.params.id,req.ip,JSON.stringify(d)]);
  res.json({user:r.rows[0]});
 }catch(e){next(e);}
});
router.get('/audit-logs',async(req,res,next)=>{
 try{
  const limit=Math.min(200,Math.max(1,Number.parseInt(req.query.limit||'50',10)||50));
  const values=[];let where='WHERE 1=1';
  if(req.query.action){values.push(String(req.query.action).slice(0,80));where+=` AND a.action=$${values.length}`;}
  if(req.query.resourceType){values.push(String(req.query.resourceType).slice(0,60));where+=` AND a.resource_type=$${values.length}`;}
  values.push(limit);
  const r=await pool.query(`SELECT a.id,a.actor_id,u.full_name AS actor_name,a.action,a.resource_type,a.resource_id,a.ip_address,a.details,a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ${where} ORDER BY a.created_at DESC LIMIT $${values.length}`,values);
  res.json({logs:r.rows});
 }catch(e){next(e);}
});
export default router;
