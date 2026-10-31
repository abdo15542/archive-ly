import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { pool } from '../db/pool.js';
import { extractDocument } from './ocr-extractor.js';
import { createOcrWorker } from './ocr-runner.js';
import { createOcrHeartbeat } from './ocr-heartbeat.js';

const controller = new AbortController();
const workerId = randomUUID();
const workerName = process.env.OCR_WORKER_NAME || os.hostname();
let heartbeatTimer;

const heartbeat = createOcrHeartbeat({ pool, workerId, workerName, pid: process.pid });
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
