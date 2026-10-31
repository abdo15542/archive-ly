import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db/pool.js';

test('PostgreSQL prevents more than one active OCR job per document', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const document = await client.query(
      `INSERT INTO documents(title,original_name,stored_name,mime_type,file_size,sha256)
       VALUES($1,$2,$3,'application/pdf',1,$4) RETURNING id`,
      ['اختبار قيد OCR', 'test.pdf', crypto.randomUUID(), 'a'.repeat(64)]
    );
    const documentId = document.rows[0].id;

    await client.query(
      "INSERT INTO ocr_jobs(document_id,status) VALUES($1,'queued')",
      [documentId]
    );

    await assert.rejects(
      client.query(
        "INSERT INTO ocr_jobs(document_id,status) VALUES($1,'processing')",
        [documentId]
      ),
      error => error.code === '23505'
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
