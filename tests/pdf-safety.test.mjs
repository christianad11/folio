import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {checkPDFBytes, inspectPDFDocument} from '../dist/pdf-safety.mjs';

// Parsing-only tests use the actual bundled PDF.js worker. No canvas is drawn.
globalThis.DOMMatrix = class DOMMatrix {};
const pdfjs = await import('../dist/vendor/pdf.mjs');

function fixture({catalog = '', page = '', extra = []} = {}) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R ${page} >>`,
    '<< /Length 0 >>\nstream\n\nendstream', ...extra
  ];
  let output = '%PDF-1.7\n', offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(output));
}

async function inspect(bytes) {
  checkPDFBytes(bytes);
  const task = pdfjs.getDocument({data: bytes, isEvalSupported: false, enableXfa: false, stopAtErrors: true, useSystemFonts: true});
  try { return await inspectPDFDocument(await task.promise); }
  finally { await task.destroy(); }
}

test('ordinary PDFs and the Folio sample pass local preflight', async () => {
  assert.equal((await inspect(fixture())).policyVersion, 1);
  assert.equal((await inspect(new Uint8Array(await fs.readFile(new URL('../dist/assets/the-art-of-paying-attention.pdf', import.meta.url))))).policyVersion, 1);
});

test('document JavaScript is rejected without running it', async () => {
  await assert.rejects(inspect(fixture({catalog: '/OpenAction 5 0 R', extra: ['<< /S /JavaScript /JS (app.alert\(test\)) >>']})), /contains JavaScript/);
});

test('page JavaScript is rejected without running it', async () => {
  await assert.rejects(inspect(fixture({page: '/AA << /O 5 0 R >>', extra: ['<< /S /JavaScript /JS (app.alert\(test\)) >>']})), /page script/);
});

test('embedded attachments are rejected', async () => {
  await assert.rejects(inspect(fixture({catalog: '/Names << /EmbeddedFiles << /Names [(note.txt) 5 0 R] >> >>', extra: ['<< /Type /Filespec /F (note.txt) /EF << /F 6 0 R >> >>', '<< /Type /EmbeddedFile /Length 4 >>\nstream\ntest\nendstream']})), /embedded files/);
});

test('automatic print actions are rejected', async () => {
  await assert.rejects(inspect(fixture({catalog: '/OpenAction 5 0 R', extra: ['<< /S /Named /N /Print >>']})), /automatic actions/);
});

test('XFA forms and invalid file types are rejected', async () => {
  await assert.rejects(inspect(fixture({catalog: '/AcroForm 5 0 R', extra: ['<< /XFA 6 0 R /Fields [] >>', '<< /Length 7 >>\nstream\n<xdp />\nendstream']})), /XFA/);
  assert.throws(() => checkPDFBytes(new TextEncoder().encode('not a PDF')), /not a valid PDF/);
  await assert.rejects(inspectPDFDocument({numPages: 10001}), /10,000 pages/);
});
