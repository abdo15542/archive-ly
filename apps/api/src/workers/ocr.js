import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { pool } from '../db/pool.js';
import { extractDocument } from './ocr-extractor.js';
import { createOcrWorker } from './ocr-runner.js';

const controller = new AbortController();
const workerId = randomUUID();
const workerName = process.env.OCR_WORKER_NAME || os.hostname();
let heartbeatTimer;
let heartbeatQueue = Promise.resolve();

function heartbeat(status = 'online') {
  heartbeatQueue = heartbeatQueue.then(() => pool.query(
    `INSERT INTO ocr_workers(id,worker_name,pid,status,started_at,last_seen_at,stopped_at)
     VALUES($1,$2,$3,$4,NOW(),NOW(),CASE WHEN $4='stopped' THEN NOW() ELSE NULL END)
     ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,last_seen_at=NOW(),
       stopped_at=CASE WHEN EXCLUDED.status='stopped' THEN NOW() ELSE NULL END`,
    [workerId, workerName, process.pid, status]
  )).catch(error => {
    console.error('OCR worker heartbeat failed:', error.message || error);
  });
  return heartbeatQueue;
}

const shutdown = signal => {
  console.log('OCR worker received', signal, '- finishing current job before shutdown.');
  controller.abort();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

const worker = createOcrWorker({ pool, extractDocument });
console.log('Arabic OCR worker started; language:', process.env.TESSERACT_LANG || 'ara+eng');
try {
  await heartbeat('online');
  heartbeatTimer = setInterval(() => heartbeat('online'), 10_000);
  heartbeatTimer.unref?.();
  await worker.run({ signal: controller.signal });
} finally {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await heartbeat('stopped');
  await pool.end();
  console.log('OCR worker stopped cleanly.');
}
