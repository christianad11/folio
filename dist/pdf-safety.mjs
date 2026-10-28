export const MAX_PDF_BYTES = 256 * 1024 * 1024;
export const MAX_PDF_PAGES = 10000;

export function checkPDFBytes(data) {
  const bytes = new Uint8Array(data);
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) throw new Error('Choose a PDF smaller than 256 MB.');
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('This file is not a valid PDF.');
}

const values = object => object instanceof Map ? [...object.values()] : Object.values(object || {});
const property = (object, key) => object instanceof Map ? object.get(key) : object?.[key];

function hasActions(actions) {
  if (!actions || typeof actions !== 'object') return false;
  return values(actions).some(value => Array.isArray(value) ? value.length > 0 : !!value);
}

const blockedAnnotationTypes = new Set([17, 18, 19, 21, 25, 27]);

export async function inspectPDFDocument(pdf) {
  if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PDF_PAGES) throw new Error('Choose a PDF with fewer than 10,000 pages.');
  const [metadata, actions, attachments, fields, openAction] = await Promise.all([
    pdf.getMetadata(), pdf.getJSActions(), pdf.getAttachments(), pdf.getFieldObjects(), pdf.getOpenAction()
  ]);
  if (metadata.info?.IsXFAPresent || pdf.isPureXfa) throw new Error('This PDF contains an XFA form. Folio blocks active forms.');
  if (hasActions(actions) || values(fields).some(items => items.some(field => hasActions(field.actions)))) throw new Error('This PDF contains JavaScript. Folio blocks PDF scripts.');
  if (values(attachments).length) throw new Error('This PDF contains embedded files. Use a copy without attachments.');
  const action = property(openAction, 'action');
  if (action && action !== 'GoTo') throw new Error('This PDF tries to run an action when opened. Folio blocks automatic actions.');

  // PDF.js parses in its worker, inside the isolated renderer. No annotation
  // action, document script, form script, link, or embedded file is executed.
  let next = 1;
  await Promise.all(Array.from({length: Math.min(4, pdf.numPages)}, async () => {
    while (next <= pdf.numPages) {
      const number = next++;
      const page = await pdf.getPage(number);
      const [pageActions, annotations] = await Promise.all([page.getJSActions(), page.getAnnotations({intent: 'any'})]);
      if (hasActions(pageActions) || annotations.some(item => hasActions(item.actions) || item.isJs)) throw new Error('This PDF contains a page script. Folio blocks PDF scripts.');
      if (annotations.some(item => blockedAnnotationTypes.has(item.annotationType) || item.file || item.attachment)) throw new Error('This PDF contains embedded files or interactive media. Folio blocks this content.');
      if (number % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }));
  return {policyVersion: 1, checkedAt: Date.now()};
}
