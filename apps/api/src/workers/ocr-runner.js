import { failExhaustedOcrLeases } from './ocr-queue.js';

export function createOcrWorker({ pool, extractDocument, logger = console, maxAttempts = 3, leaseMinutes = 15 }) {
  if (!pool?.connect || typeof extractDocument !== 'function') {
    throw new TypeError('OCR worker requires a PostgreSQL pool and extractDocument function');
  }

  async function claim() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await failExhaustedOcrLeases(client);
      const result = await client.query(`
        SELECT j.id,j.document_id,d.stored_name,d.mime_type
        FROM ocr_jobs j
        JOIN documents d ON d.id=j.document_id
        WHERE (j.status='queued' AND j.attempts < $1)
           OR (j.status='processing' AND j.attempts < $1
               AND j.locked_at < NOW() - ($2::int * INTERVAL '1 minute'))
        ORDER BY j.created_at,j.id
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1
      `, [maxAttempts, leaseMinutes]);
      if (!result.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const job = result.rows[0];
      const claimed = await client.query(
        "UPDATE ocr_jobs SET status='processing',attempts=attempts+1,locked_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING attempts",
        [job.id]
      );
      await client.query(
        "UPDATE documents SET ocr_status='processing',updated_at=NOW() WHERE id=$1",
        [job.document_id]
      );
      await client.query('COMMIT');
      return { ...job, attempts: claimed.rows[0].attempts };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function processJob(job) {
    let extracted;
    try {
      extracted = await extractDocument(job);
      if (typeof extracted !== 'string' || !extracted.trim()) {
        throw new Error('لم يستخرج OCR أي نص صالح من الوثيقة');
      }
    } catch (error) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(
          'SELECT status,attempts FROM ocr_jobs WHERE id=$1 FOR UPDATE',
          [job.id]
        );
        if (!current.rowCount || current.rows[0].status !== 'processing' || current.rows[0].attempts !== job.attempts) {
          await client.query('ROLLBACK');
          logger.info?.('OCR failure ignored because its lease is no longer current:', job.id);
          return { status: 'stale' };
        }
        const status = job.attempts >= maxAttempts ? 'failed' : 'queued';
        await client.query(
          "UPDATE ocr_jobs SET status=$2,last_error=$3,locked_at=NULL,updated_at=NOW() WHERE id=$1 AND status='processing' AND attempts=$4",
          [job.id, status, String(error.message || error).slice(0, 2000), job.attempts]
        );
        await client.query(
          'UPDATE documents SET ocr_status=$2,updated_at=NOW() WHERE id=$1',
          [job.document_id, status === 'failed' ? 'failed' : 'pending']
        );
        await client.query('COMMIT');
        logger.error?.('OCR job failed:', job.document_id, error.message || error);
        return { status, error };
      } catch (persistError) {
        await client.query('ROLLBACK');
        throw persistError;
      } finally {
        client.release();
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ownership = await client.query(
        'SELECT status,attempts FROM ocr_jobs WHERE id=$1 FOR UPDATE',
        [job.id]
      );
      if (!ownership.rowCount || ownership.rows[0].status !== 'processing' || ownership.rows[0].attempts !== job.attempts) {
        await client.query('ROLLBACK');
        logger.info?.('OCR result discarded because its lease is no longer current:', job.id);
        return { status: 'stale' };
      }
      const updated = await client.query(
        "UPDATE ocr_jobs SET status='completed',last_error=NULL,locked_at=NULL,updated_at=NOW() WHERE id=$1 AND status='processing' AND attempts=$2",
        [job.id, job.attempts]
      );
      if (updated.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { status: 'stale' };
      }
      await client.query(
        "UPDATE documents SET extracted_text=$2,ocr_status='completed',updated_at=NOW() WHERE id=$1",
        [job.document_id, extracted]
      );
      await client.query('COMMIT');
      logger.info?.('OCR completed:', job.document_id, 'characters:', extracted.length);
      return { status: 'completed', text: extracted };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function runOnce() {
    const job = await claim();
    if (!job) return { status: 'idle' };
    return processJob(job);
  }

  async function run({ signal, pollIntervalMs = 2500, errorDelayMs = 5000 } = {}) {
    const pause = ms => new Promise(resolve => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener('abort', abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        done();
      }
      signal?.addEventListener('abort', abort, { once: true });
    });
    while (!signal?.aborted) {
      try {
        const result = await runOnce();
        if (result.status === 'idle') await pause(pollIntervalMs);
      } catch (error) {
        logger.error?.('OCR worker loop error:', error.message || error);
        await pause(errorDelayMs);
      }
    }
  }

  return { claim, processJob, runOnce, run };
}
