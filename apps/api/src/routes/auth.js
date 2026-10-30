import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128)
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) });

router.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'بيانات التسجيل غير صحيحة' });
    const { fullName, email, password } = parsed.data;
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    if (count.rows[0].count > 0) return res.status(403).json({ error: 'إنشاء الحسابات متاح للمسؤول فقط بعد إنشاء أول مسؤول' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,full_name,email,role',
      [fullName, email.toLowerCase(), hash, 'admin']
    );
    const user = result.rows[0];
    const token = jwt.sign({ sub: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.status(201).json({ user, token });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'البريد الإلكتروني مستخدم' });
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'بيانات الدخول غير صحيحة' });
    const { email, password } = parsed.data;
    const result = await pool.query('SELECT id,full_name,email,password_hash,role,is_active FROM users WHERE email=$1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
    const token = jwt.sign({ sub: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ user: { id:user.id, fullName:user.full_name, email:user.email, role:user.role }, token });
  } catch (error) { next(error); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT id,full_name,email,role FROM users WHERE id=$1 AND is_active=TRUE', [req.user.sub]);
    if (!result.rowCount) return res.status(401).json({ error: 'الحساب غير متاح' });
    res.json({ user: result.rows[0] });
  } catch (error) { next(error); }
});
export default router;
