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

    await client.query('SAVEPOINT duplicate_active_job');
    await assert.rejects(
      client.query(
        "INSERT INTO ocr_jobs(document_id,status) VALUES($1,'processing')",
        [documentId]
      ),
      error => error.code === '23505'
    );
    await client.query('ROLLBACK TO SAVEPOINT duplicate_active_job');

    // Completed history must not prevent a later OCR attempt.
    await client.query("UPDATE ocr_jobs SET status='completed' WHERE document_id=$1", [documentId]);
    await client.query("INSERT INTO ocr_jobs(document_id,status) VALUES($1,'queued')", [documentId]);
    const jobs = await client.query(
      "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('queued','processing'))::int AS active FROM ocr_jobs WHERE document_id=$1",
      [documentId]
    );
    assert.equal(jobs.rows[0].total, 2);
    assert.equal(jobs.rows[0].active, 1);

    // A reclaimed job gets a new attempt number; an expired worker must not
    // be able to publish its stale result over the newer worker's result.
    const leaseDocument = await client.query(
      `INSERT INTO documents(title,original_name,stored_name,mime_type,file_size,sha256)
       VALUES($1,$2,$3,'application/pdf',1,$4) RETURNING id`,
      ['اختبار ملكية مهمة OCR', 'lease.pdf', crypto.randomUUID(), 'b'.repeat(64)]
    );
    const leaseJob = await client.query(
      "INSERT INTO ocr_jobs(document_id,status,attempts) VALUES($1,'processing',1) RETURNING id",
      [leaseDocument.rows[0].id]
    );
    await client.query(
      "UPDATE ocr_jobs SET attempts=2,status='processing',locked_at=NOW() WHERE id=$1",
      [leaseJob.rows[0].id]
    );
    const staleCompletion = await client.query(
      "UPDATE ocr_jobs SET status='completed' WHERE id=$1 AND status='processing' AND attempts=$2",
      [leaseJob.rows[0].id, 1]
    );
    assert.equal(staleCompletion.rowCount, 0);
    const currentCompletion = await client.query(
      "UPDATE ocr_jobs SET status='completed' WHERE id=$1 AND status='processing' AND attempts=$2",
      [leaseJob.rows[0].id, 2]
    );
    assert.equal(currentCompletion.rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('abandoned OCR leases at the retry limit are failed instead of reclaimed forever', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const document = await client.query(
      `INSERT INTO documents(title,original_name,stored_name,mime_type,file_size,sha256,ocr_status)
       VALUES($1,$2,$3,'application/pdf',1,$4,'processing') RETURNING id`,
      ['اختبار استنفاد OCR', 'exhausted.pdf', crypto.randomUUID(), 'c'.repeat(64)]
    );
    const job = await client.query(
      `INSERT INTO ocr_jobs(document_id,status,attempts,locked_at)
       VALUES($1,'processing',3,NOW()-INTERVAL '16 minutes') RETURNING id`,
      [document.rows[0].id]
    );
    const { failExhaustedOcrLeases } = await import('../src/workers/ocr-queue.js');
    assert.equal(await failExhaustedOcrLeases(client), 1);
    const state = await client.query(
      `SELECT j.status,j.locked_at,d.ocr_status,j.last_error
       FROM ocr_jobs j JOIN documents d ON d.id=j.document_id WHERE j.id=$1`,
      [job.rows[0].id]
    );
    assert.equal(state.rows[0].status, 'failed');
    assert.equal(state.rows[0].locked_at, null);
    assert.equal(state.rows[0].ocr_status, 'failed');
    assert.match(state.rows[0].last_error, /استنفاد محاولات OCR/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
