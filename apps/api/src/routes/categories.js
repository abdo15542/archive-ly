import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.get('/', async (_req,res,next) => {
  try { const r=await pool.query('SELECT id,name,description,created_at FROM categories ORDER BY name'); res.json({categories:r.rows}); }
  catch(e){next(e);}
});
router.post('/', requireRole('admin','archivist'), async (req,res,next) => {
  try {
    const p=z.object({name:z.string().trim().min(2).max(120),description:z.string().max(1000).optional()}).safeParse(req.body);
    if(!p.success) return res.status(400).json({error:'بيانات التصنيف غير صحيحة'});
    const r=await pool.query('INSERT INTO categories(name,description) VALUES($1,$2) RETURNING *',[p.data.name,p.data.description||null]);
    res.status(201).json({category:r.rows[0]});
  } catch(e){ if(e.code==='23505') return res.status(409).json({error:'اسم التصنيف موجود'}); next(e); }
});
router.delete('/:id', requireRole('admin'), async(req,res,next)=>{
  try { const r=await pool.query('DELETE FROM categories WHERE id=$1 RETURNING id',[req.params.id]); if(!r.rowCount)return res.status(404).json({error:'التصنيف غير موجود'}); res.status(204).end(); }
  catch(e){next(e);}
});
export default router;
