import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { createOcrWorker } from '../src/workers/ocr-runner.js';

test('OCR worker claims a queued job and atomically persists extracted text and completion state', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const storedName = crypto.randomUUID() + '.pdf';
  let documentId;
  let jobId;
  try {
    const document = await pool.query(
      `INSERT INTO documents(title,original_name,stored_name,mime_type,file_size,sha256,ocr_status)
       VALUES($1,$2,$3,'application/pdf',1,$4,'pending') RETURNING id`,
      ['اختبار عامل OCR', 'worker-test.pdf', storedName, crypto.randomBytes(32).toString('hex')]
    );
    documentId = document.rows[0].id;
    const job = await pool.query(
      "INSERT INTO ocr_jobs(document_id,status) VALUES($1,'queued') RETURNING id",
      [documentId]
    );
    jobId = job.rows[0].id;

    const worker = createOcrWorker({
      pool,
      extractDocument: async input => {
        assert.equal(input.document_id, documentId);
        assert.equal(input.stored_name, storedName);
        return 'نص عربي مفهرس من عامل OCR';
      },
      logger: { info() {}, error() {} }
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'completed');
    assert.match(result.text, /نص عربي مفهرس/);

    const persisted = await pool.query(
      `SELECT j.status AS job_status,j.attempts,j.locked_at,
              d.ocr_status,d.extracted_text
       FROM ocr_jobs j JOIN documents d ON d.id=j.document_id
       WHERE j.id=$1`,
      [jobId]
    );
    assert.equal(persisted.rows[0].job_status, 'completed');
    assert.equal(persisted.rows[0].attempts, 1);
    assert.equal(persisted.rows[0].locked_at, null);
    assert.equal(persisted.rows[0].ocr_status, 'completed');
    assert.equal(persisted.rows[0].extracted_text, 'نص عربي مفهرس من عامل OCR');
  } finally {
    if (documentId) await pool.query('DELETE FROM documents WHERE id=$1', [documentId]);
  }
});

test('OCR worker requeues a failed first attempt and marks the document pending', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const storedName = crypto.randomUUID() + '.pdf';
  let documentId;
  let jobId;
  try {
    const document = await pool.query(
      `INSERT INTO documents(title,original_name,stored_name,mime_type,file_size,sha256,ocr_status)
       VALUES($1,$2,$3,'application/pdf',1,$4,'pending') RETURNING id`,
      ['اختبار إعادة محاولة OCR', 'worker-retry.pdf', storedName, crypto.randomBytes(32).toString('hex')]
    );
    documentId = document.rows[0].id;
    const job = await pool.query(
      "INSERT INTO ocr_jobs(document_id,status) VALUES($1,'queued') RETURNING id",
      [documentId]
    );
    jobId = job.rows[0].id;
    const worker = createOcrWorker({
      pool,
      extractDocument: async () => { throw new Error('OCR binary temporarily unavailable'); },
      logger: { info() {}, error() {} }
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'queued');
    const persisted = await pool.query(
      `SELECT j.status AS job_status,j.attempts,j.last_error,d.ocr_status
       FROM ocr_jobs j JOIN documents d ON d.id=j.document_id WHERE j.id=$1`,
      [jobId]
    );
    assert.equal(persisted.rows[0].job_status, 'queued');
    assert.equal(persisted.rows[0].attempts, 1);
    assert.match(persisted.rows[0].last_error, /temporarily unavailable/);
    assert.equal(persisted.rows[0].ocr_status, 'pending');
  } finally {
    if (documentId) await pool.query('DELETE FROM documents WHERE id=$1', [documentId]);
  }
});

test('OCR worker rejects empty extraction and eventually fails exhausted attempts', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const storedName = crypto.randomUUID() + '.pdf';
  let documentId;
  let jobId;
  try {
    const document = await pool.query(
      `INSERT INTO documents(title,original_name,stored_name,mime_type,file_size,sha256,ocr_status)
       VALUES($1,$2,$3,'application/pdf',1,$4,'pending') RETURNING id`,
      ['اختبار استخراج فارغ', 'worker-empty.pdf', storedName, crypto.randomBytes(32).toString('hex')]
    );
    documentId = document.rows[0].id;
    const job = await pool.query(
      "INSERT INTO ocr_jobs(document_id,status,attempts) VALUES($1,'queued',2) RETURNING id",
      [documentId]
    );
    jobId = job.rows[0].id;
    const worker = createOcrWorker({
      pool,
      extractDocument: async () => '  ',
      logger: { info() {}, error() {} }
    });
    const result = await worker.runOnce();
    assert.equal(result.status, 'failed');
    const persisted = await pool.query(
      `SELECT j.status AS job_status,j.attempts,d.ocr_status,j.last_error
       FROM ocr_jobs j JOIN documents d ON d.id=j.document_id WHERE j.id=$1`,
      [jobId]
    );
    assert.equal(persisted.rows[0].job_status, 'failed');
    assert.equal(persisted.rows[0].attempts, 3);
    assert.equal(persisted.rows[0].ocr_status, 'failed');
    assert.match(persisted.rows[0].last_error, /لم يستخرج OCR/);
  } finally {
    if (documentId) await pool.query('DELETE FROM documents WHERE id=$1', [documentId]);
  }
});

test('OCR worker exits promptly when shutdown is requested during idle polling', async () => {
  const controller = new AbortController();
  let connects = 0;
  const fakePool = {
    async connect() {
      connects += 1;
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
          if (sql.includes('UPDATE ocr_jobs')) return { rowCount: 0, rows: [] };
          if (sql.includes('SELECT j.id')) return { rowCount: 0, rows: [] };
          throw new Error('Unexpected SQL in shutdown test');
        },
        release() {}
      };
    }
  };
  const worker = createOcrWorker({
    pool: fakePool,
    extractDocument: async () => 'unused',
    logger: { info() {}, error() {} }
  });
  const running = worker.run({ signal: controller.signal, pollIntervalMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await running;
  assert.equal(connects, 1);
});
