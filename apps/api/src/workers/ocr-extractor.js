import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function getPdfPageLimit(value = process.env.OCR_MAX_PDF_PAGES) {
  if (value === undefined || value === '') return 15;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('OCR_MAX_PDF_PAGES must be an integer between 1 and 100');
  }
  return parsed;
}

export function commandOutput(command, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(command + ' timed out'));
    }, timeout);
    child.stdout.on('data', data => { out += data.toString(); });
    child.stderr.on('data', data => { err += data.toString(); });
    child.on('error', error => finish(reject, error));
    child.on('close', code => {
      if (code === 0) finish(resolve, out);
      else finish(reject, new Error(err.slice(-2000) || command + ' exited ' + code));
    });
  });
}

export async function ocrImage(file, run = commandOutput) {
  return run('tesseract', [file, 'stdout', '-l', process.env.TESSERACT_LANG || 'ara+eng', '--psm', '3'], 180000);
}

export async function extractDocument(doc, options = {}) {
  const uploadDir = path.resolve(options.uploadDir || process.env.UPLOAD_DIR || './uploads');
  const run = options.commandOutput || commandOutput;
  const imageOcr = options.ocrImage || (file => ocrImage(file, run));
  if (!doc || typeof doc.stored_name !== 'string' || path.basename(doc.stored_name) !== doc.stored_name) {
    throw new Error('OCR document has an invalid stored filename');
  }
  const file = path.join(uploadDir, doc.stored_name);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('OCR source is not a regular file');

  if (doc.mime_type !== 'application/pdf') {
    const text = (await imageOcr(file)).trim();
    if (!text) throw new Error('لم يتم استخراج نص من الصورة');
    return text;
  }

  let text = '';
  try {
    text = (await run('pdftotext', ['-layout', file, '-'], 60000)).trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('أداة pdftotext غير مثبتة في بيئة OCR');
  }
  if (text.length > 40) return text;

  const pageLimit = getPdfPageLimit();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ocr-'));
  try {
    const prefix = path.join(temp, 'page');
    await run('pdftoppm', ['-f', '1', '-l', String(pageLimit), '-r', '180', '-png', file, prefix], 180000);
    const pages = (await fs.readdir(temp))
      .filter(name => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!pages.length) throw new Error('لم يمكن تحويل صفحات PDF إلى صور');
    const extracted = [];
    for (const page of pages) extracted.push((await imageOcr(path.join(temp, page))).trim());
    const result = extracted.filter(Boolean).join('\n\n').trim();
    if (!result) throw new Error('لم يتم استخراج نص من صفحات PDF');
    return result;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
