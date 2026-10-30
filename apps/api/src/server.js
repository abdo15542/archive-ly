import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pool } from './db/pool.js';
import authRoutes from './routes/auth.js';
import documentRoutes from './routes/documents.js';
import categoryRoutes from './routes/categories.js';
import adminRoutes from './routes/admin.js';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','), credentials: true }));
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
app.use((req, res) => res.status(404).json({ error: 'المسار غير موجود' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'حدث خطأ داخلي' });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`ARCHIVE LY API listening on port ${port}`));
