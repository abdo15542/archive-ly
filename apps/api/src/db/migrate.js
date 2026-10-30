import 'dotenv/config';
import { pool } from './pool.js';

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin','archivist','viewer','user')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(250) NOT NULL,
  document_number VARCHAR(100),
  subject TEXT,
  issuing_entity VARCHAR(200),
  document_date DATE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type VARCHAR(120) NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size >= 0),
  sha256 CHAR(64) NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  ocr_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending','processing','completed','failed','not_required')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS documents_date_idx ON documents(document_date DESC);
CREATE INDEX IF NOT EXISTS documents_category_idx ON documents(category_id);
CREATE INDEX IF NOT EXISTS documents_search_idx ON documents USING GIN (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(subject,'') || ' ' || coalesce(extracted_text,'')));
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id TEXT,
  ip_address INET,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ocr_jobs (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ocr_jobs_queue_idx ON ocr_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
`;

try {
  await pool.query(schema);
  console.log('Database migrations completed.');
} catch (error) {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
