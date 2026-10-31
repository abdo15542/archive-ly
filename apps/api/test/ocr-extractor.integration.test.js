import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPdfPageLimit, extractDocument, commandOutput, ocrImage } from '../src/workers/ocr-extractor.js';

test('OCR page limit defaults safely and rejects invalid or excessive values', () => {
  assert.equal(getPdfPageLimit(undefined), 15);
  assert.equal(getPdfPageLimit('25'), 25);
  for (const value of ['0', '-1', '1.5', 'NaN', '101', '999999999999999999']) {
    assert.throws(() => getPdfPageLimit(value), /between 1 and 100/);
  }
});

test('OCR rejects unsafe stored filenames and missing source files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ocr-input-'));
  try {
    await assert.rejects(
      extractDocument({ stored_name: '../outside.pdf', mime_type: 'application/pdf' }, { uploadDir: root }),
      /invalid stored filename/
    );
    await assert.rejects(
      extractDocument({ stored_name: 'missing.pdf', mime_type: 'application/pdf' }, { uploadDir: root }),
      /ENOENT/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OCR uses real pdftotext extraction for a generated PDF fixture', {
  skip: process.env.SKIP_OCR_BINARY_TESTS === '1'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ocr-pdf-'));
  try {
    const content = 'Archive LY integration fixture: searchable text extraction must work.';
    const stream = 'BT /F1 18 Tf 72 720 Td (' + content + ') Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + Buffer.byteLength(stream, 'ascii') + ' >>\nstream\n' + stream + '\nendstream'
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf, 'binary'));
      pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
    }
    const xref = Buffer.byteLength(pdf, 'binary');
    pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
    pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    await fs.writeFile(path.join(root, 'fixture.pdf'), pdf, 'binary');
    const result = await extractDocument(
      { stored_name: 'fixture.pdf', mime_type: 'application/pdf' },
      { uploadDir: root }
    );
    assert.match(result, /Archive LY integration fixture/);
    const renderedPrefix = path.join(root, 'rendered');
    await commandOutput('pdftoppm', ['-f', '1', '-l', '1', '-r', '200', '-png', path.join(root, 'fixture.pdf'), renderedPrefix]);
    const rendered = path.join(root, 'rendered-1.png');
    const recognized = await ocrImage(rendered, commandOutput);
    assert.match(recognized.toLowerCase(), /archive/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('Arabic OCR recognizes Arabic text rendered into a real image', {
  skip: process.env.SKIP_OCR_BINARY_TESTS === '1'
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-ocr-arabic-'));
  try {
    const svg = path.join(root, 'arabic.svg');
    const png = path.join(root, 'arabic.png');
    await fs.writeFile(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="420"><rect width="100%" height="100%" fill="#fff"/><text x="900" y="275" text-anchor="middle" font-family="Noto Naskh Arabic" font-size="170" fill="#000">الأرشيف الليبي</text></svg>`, 'utf8');
    await commandOutput('rsvg-convert', ['-o', png, svg], 60000);
    const recognized = await ocrImage(png, commandOutput);
    assert.match(recognized.replace(/\\s/g, ''), /الأرشيف/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
