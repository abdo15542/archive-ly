import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db/pool.js';
import authRoutes from './routes/auth.js';
import documentRoutes from './routes/documents.js';
import categoryRoutes from './routes/categories.js';
import adminRoutes from './routes/admin.js';

const jwtSecret = process.env.JWT_SECRET || '';
if (Buffer.byteLength(jwtSecret) < 32 || /replace-this|change-me/i.test(jwtSecret)) throw new Error('JWT_SECRET must be a unique secret of at least 32 bytes.');
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(process.env.WEB_DIST_DIR || path.join(here, '../../web/dist'));
const webIndex = path.join(webDist, 'index.html');
const hasWebBuild = fs.existsSync(webIndex);
const app = express();
app.disable('x-powered-by');
app.use(helmet());
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', service: 'archive-ly-api' });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected', service: 'archive-ly-api' });
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/admin', adminRoutes);
if (hasWebBuild) app.use(express.static(webDist, { index: false, maxAge: '1d', immutable: true }));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'المسار غير موجود' });
  if (req.method === 'GET' && hasWebBuild) return res.sendFile(webIndex);
  return res.status(404).json({ error: 'المسار غير موجود' });
});
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'حدث خطأ داخلي' });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`ARCHIVE LY API listening on port ${port}`));
