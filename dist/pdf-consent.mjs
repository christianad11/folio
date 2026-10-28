import {inspectPDFDocument} from './pdf-safety.mjs';

export async function digestPDF(data, fallback) {
  const bytes = new Uint8Array(data);
  if (globalThis.crypto?.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  }
  if (fallback) return fallback(bytes);
  throw new Error('PDF checking is unavailable. Reopen Folio and try again.');
}

export async function inspectWithConsent(pdf, {digest, approval, confirmAttachments} = {}) {
  // Complete every hard safety check before offering the attachment exception.
  const report = await inspectPDFDocument(pdf, {allowEmbeddedFiles: true});
  if (!report.hasEmbeddedFiles) return null;
  const sha256 = await digest;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Unable to verify this PDF. Choose the file again.');
  if (approval?.policyVersion === report.policyVersion && approval?.embeddedFilesAllowed === true && approval?.sha256 === sha256) return approval;
  if (!await confirmAttachments?.()) {
    const error = new Error('This PDF was not added.');
    error.name = 'AbortException';
    throw error;
  }
  return {policyVersion: report.policyVersion, embeddedFilesAllowed: true, sha256, acceptedAt: Date.now()};
}
