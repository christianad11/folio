import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {checkPDFBytes, inspectPDFDocument} from '../dist/pdf-safety.mjs';
import {digestPDF, inspectWithConsent} from '../dist/pdf-consent.mjs';

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

async function withPDF(bytes, action) {
  checkPDFBytes(bytes);
  const task = pdfjs.getDocument({data: bytes, isEvalSupported: false, enableXfa: false, stopAtErrors: true, useSystemFonts: true});
  try { return await action(await task.promise); }
  finally { await task.destroy(); }
}

const inspect = (bytes, options) => withPDF(bytes, pdf => inspectPDFDocument(pdf, options));
const attached = () => fixture({catalog: '/Names << /EmbeddedFiles << /Names [(note.txt) 5 0 R] >> >>', extra: ['<< /Type /Filespec /F (note.txt) /EF << /F 6 0 R >> >>', '<< /Type /EmbeddedFile /Length 4 >>\nstream\ntest\nendstream']});

test('ordinary PDFs and the Folio sample pass local preflight', async () => {
  assert.equal((await inspect(fixture())).policyVersion, 2);
  assert.equal((await inspect(new Uint8Array(await fs.readFile(new URL('../dist/assets/the-art-of-paying-attention.pdf', import.meta.url))))).policyVersion, 2);
});

test('document JavaScript is rejected without running it', async () => {
  await assert.rejects(inspect(fixture({catalog: '/OpenAction 5 0 R', extra: ['<< /S /JavaScript /JS (app.alert\(test\)) >>']})), /contains JavaScript/);
});

test('page JavaScript is rejected without running it', async () => {
  await assert.rejects(inspect(fixture({page: '/AA << /O 5 0 R >>', extra: ['<< /S /JavaScript /JS (app.alert\(test\)) >>']})), /page script/);
});

test('embedded attachments are rejected', async () => {
  await assert.rejects(inspect(attached()), /embedded files/);
});

test('attachment consent is remembered for the same bytes and renewed for a changed PDF', async () => {
  const bytes = attached(), digest = await digestPDF(bytes);
  assert.equal(digest.length, 64);
  await withPDF(bytes, async pdf => {
    let prompts = 0;
    const confirmAttachments = async () => { prompts++; return true; };
    const approval = await inspectWithConsent(pdf, {digest, confirmAttachments});
    assert.equal(approval.embeddedFilesAllowed, true);
    assert.equal(approval.sha256, digest);
    assert.equal(prompts, 1);
    assert.deepEqual(await inspectWithConsent(pdf, {digest, approval, confirmAttachments}), approval);
    assert.equal(prompts, 1);
    const changedDigest = await digestPDF(new TextEncoder().encode('changed PDF contents'));
    const changedApproval = await inspectWithConsent(pdf, {digest: changedDigest, approval, confirmAttachments});
    assert.equal(prompts, 2);
    assert.equal(changedApproval.sha256, changedDigest);
  });
});

test('canceling an attachment exception aborts that PDF', async () => {
  const bytes = attached(), digest = await digestPDF(bytes);
  await withPDF(bytes, async pdf => {
    await assert.rejects(inspectWithConsent(pdf, {digest, confirmAttachments: async () => false}), {name: 'AbortException'});
  });
});

test('an attachment exception never bypasses a page script or triggers its confirmation', async () => {
  const bytes = fixture({catalog: '/Names << /EmbeddedFiles << /Names [(note.txt) 5 0 R] >> >>', page: '/AA << /O 7 0 R >>', extra: ['<< /Type /Filespec /F (note.txt) /EF << /F 6 0 R >> >>', '<< /Type /EmbeddedFile /Length 4 >>\nstream\ntest\nendstream', '<< /S /JavaScript /JS (app.alert\(test\)) >>']});
  const digest = await digestPDF(bytes); let prompts = 0;
  await withPDF(bytes, async pdf => {
    await assert.rejects(inspectWithConsent(pdf, {digest, confirmAttachments: async () => { prompts++; return true; }}), /page script/);
  });
  assert.equal(prompts, 0);
});

test('page attachment annotations receive the same exception as catalog attachments', async () => {
  const bytes = fixture({page: '/Annots [5 0 R]', extra: ['<< /Type /Annot /Subtype /FileAttachment /Rect [10 10 30 30] /FS 6 0 R >>', '<< /Type /Filespec /F (note.txt) /EF << /F 7 0 R >> >>', '<< /Type /EmbeddedFile /Length 4 >>\nstream\ntest\nendstream']});
  const digest = await digestPDF(bytes);
  await withPDF(bytes, async pdf => {
    const approval = await inspectWithConsent(pdf, {digest, confirmAttachments: async () => true});
    assert.equal(approval.sha256, digest);
  });
});

test('automatic print actions are rejected', async () => {
  await assert.rejects(inspect(fixture({catalog: '/OpenAction 5 0 R', extra: ['<< /S /Named /N /Print >>']})), /automatic actions/);
});

test('XFA forms and invalid file types are rejected', async () => {
  await assert.rejects(inspect(fixture({catalog: '/AcroForm 5 0 R', extra: ['<< /XFA 6 0 R /Fields [] >>', '<< /Length 7 >>\nstream\n<xdp />\nendstream']})), /XFA/);
  assert.throws(() => checkPDFBytes(new TextEncoder().encode('not a PDF')), /not a valid PDF/);
  await assert.rejects(inspectPDFDocument({numPages: 10001}), /10,000 pages/);
});
