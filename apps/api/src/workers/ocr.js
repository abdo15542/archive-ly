import 'dotenv/config';
import { pool } from '../db/pool.js';
import { extractDocument } from './ocr-extractor.js';
import { failExhaustedOcrLeases } from './ocr-queue.js';

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

async function claim() {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  await failExhaustedOcrLeases(client);
  const r = await client.query(`SELECT j.id,j.document_id,d.stored_name,d.mime_type
   FROM ocr_jobs j JOIN documents d ON d.id=j.document_id
   WHERE (j.status='queued' AND j.attempts < 3)
      OR (j.status='processing' AND j.attempts < 3 AND j.locked_at<NOW()-INTERVAL '15 minutes')
   ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
  if (!r.rowCount) { await client.query('COMMIT'); return null; }
  const job = r.rows[0];
  const claimed = await client.query("UPDATE ocr_jobs SET status='processing',attempts=attempts+1,locked_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING attempts", [job.id]);
  await client.query("UPDATE documents SET ocr_status='processing',updated_at=NOW() WHERE id=$1", [job.document_id]);
  await client.query('COMMIT');
  return { ...job, attempts: claimed.rows[0].attempts };
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
}

async function processJob(job) {
 try {
  const text = await extractDocument(job);
  const client = await pool.connect();
  try {
   await client.query('BEGIN');
   const ownership = await client.query("SELECT status,attempts FROM ocr_jobs WHERE id=$1 FOR UPDATE", [job.id]);
   if (!ownership.rowCount || ownership.rows[0].status !== 'processing' || ownership.rows[0].attempts !== job.attempts) {
    await client.query('ROLLBACK');
    console.log('OCR result discarded because its lease is no longer current:', job.id);
    return;
   }
   await client.query("UPDATE documents SET extracted_text=$2,ocr_status='completed',updated_at=NOW() WHERE id=$1", [job.document_id, text]);
   await client.query("UPDATE ocr_jobs SET status='completed',last_error=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$1 AND status='processing' AND attempts=$2", [job.id, job.attempts]);
   await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log('OCR completed:', job.document_id, 'characters:', text.length);
 } catch (error) {
  const client = await pool.connect();
  try {
   await client.query('BEGIN');
   const result = await client.query('SELECT status,attempts FROM ocr_jobs WHERE id=$1 FOR UPDATE', [job.id]);
   if (!result.rowCount || result.rows[0].status !== 'processing' || result.rows[0].attempts !== job.attempts) {
    await client.query('ROLLBACK');
    console.log('OCR failure ignored because its lease is no longer current:', job.id);
    return;
   }
   const status = job.attempts >= 3 ? 'failed' : 'queued';
   await client.query("UPDATE ocr_jobs SET status=$2,last_error=$3,locked_at=NULL,updated_at=NOW() WHERE id=$1 AND status='processing' AND attempts=$4", [job.id, status, String(error.message).slice(0, 2000), job.attempts]);
   await client.query('UPDATE documents SET ocr_status=$2,updated_at=NOW() WHERE id=$1', [job.document_id, status === 'failed' ? 'failed' : 'pending']);
   await client.query('COMMIT');
  } catch (persistError) { await client.query('ROLLBACK'); throw persistError; }
  finally { client.release(); }
  console.error('OCR job failed:', job.document_id, error.message);
 }
}

console.log('Arabic OCR worker started; language:', process.env.TESSERACT_LANG || 'ara+eng');
while (!stopping) {
 try {
  const job = await claim();
  if (job) await processJob(job);
  else await new Promise(resolve => setTimeout(resolve, 2500));
 } catch (error) {
  console.error('OCR worker loop error:', error.message);
  await new Promise(resolve => setTimeout(resolve, 5000));
 }
}
await pool.end();
