import 'dotenv/config';
import { pool } from '../db/pool.js';
import { extractDocument } from './ocr-extractor.js';
import { createOcrWorker } from './ocr-runner.js';

const controller = new AbortController();
const shutdown = signal => {
  console.log('OCR worker received', signal, '- finishing current job before shutdown.');
  controller.abort();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

const worker = createOcrWorker({ pool, extractDocument });
console.log('Arabic OCR worker started; language:', process.env.TESSERACT_LANG || 'ara+eng');
try {
  await worker.run({ signal: controller.signal });
} finally {
  await pool.end();
  console.log('OCR worker stopped cleanly.');
}
