const LIMIT = 512 * 1024 * 1024;
const validID = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,179}$/.test(value);
const fail = () => { throw new Error('Choose a valid Folio library backup.'); };

export function toBase64(bytes) {
  bytes = new Uint8Array(bytes);
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(value);
}

export function fromBase64(value) {
  if (typeof value !== 'string' || value.length > LIMIT || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail();
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { fail(); }
}

export function validateArchive(value) {
  if (!value || value.format !== 'folio-library' || value.version !== 1 || !Array.isArray(value.books) || !Array.isArray(value.shelves) || !Array.isArray(value.files)) fail();
  if (value.books.length > 10000 || value.shelves.length > 1000 || value.files.length > 10000) fail();
  const books = new Set(), shelves = new Set(), files = new Set();
  for (const shelf of value.shelves) {
    if (!validID(shelf.id) || shelves.has(shelf.id) || typeof shelf.name !== 'string' || !shelf.name.trim() || shelf.name.length > 60) fail();
    shelves.add(shelf.id);
  }
  for (const book of value.books) {
    if (!validID(book.id) || books.has(book.id) || typeof book.title !== 'string' || book.title.length > 10000 || !Number.isInteger(book.pageCount) || book.pageCount < 1 || book.pageCount > 1000000) fail();
    if (!Array.isArray(book.marks) || book.marks.length > 100000 || !Number.isInteger(book.page) || book.page < 1 || book.page > book.pageCount) fail();
    if (book.sample && book.id !== 'sample-attention') fail();
    for (const mark of book.marks) {
      if (!validID(mark.id) || !['bookmark', 'passage'].includes(mark.kind) || !Number.isInteger(mark.page) || mark.page < 1 || mark.page > book.pageCount) fail();
      if (mark.text !== undefined && (typeof mark.text !== 'string' || mark.text.length > 1000000)) fail();
      if (mark.note !== undefined && (typeof mark.note !== 'string' || mark.note.length > 1000000)) fail();
      if (mark.kind === 'passage') {
        if (!['yellow', 'sage', 'rose'].includes(mark.color) || !Array.isArray(mark.rects) || mark.rects.length > 10000) fail();
        for (const rect of mark.rects) if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]) && rect[key] >= 0 && rect[key] <= 1)) fail();
      }
    }
    books.add(book.id);
  }
  let total = 0;
  for (const file of value.files) {
    if (!validID(file.id) || !books.has(file.id) || files.has(file.id)) fail();
    const data = fromBase64(file.data);
    total += data.length;
    if (total > LIMIT || !new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-')) fail();
    files.add(file.id);
  }
  if (value.books.some(book => !book.sample && !files.has(book.id))) throw new Error('This backup is missing a PDF. Export the library again with access to all linked files.');
  return value;
}

async function transform(bytes, stream) {
  const writer = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await writer.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT) throw new Error('This library backup is too large. Export smaller libraries separately.');
      chunks.push(value);
    }
  } finally { await writer.cancel().catch(() => {}); }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

export async function encodeArchive(snapshot) {
  const archive = {format: 'folio-library', version: 1, exportedAt: new Date().toISOString(), books: snapshot.books, shelves: snapshot.shelves, files: snapshot.files.map(file => ({id: file.id, data: toBase64(file.bytes)}))};
  validateArchive(archive);
  const bytes = new TextEncoder().encode(JSON.stringify(archive));
  if (bytes.length > LIMIT) throw new Error('This library backup is too large. Export smaller libraries separately.');
  return transform(bytes, new CompressionStream('gzip'));
}

export async function decodeArchive(bytes) {
  bytes = new Uint8Array(bytes);
  if (bytes.length > LIMIT) fail();
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await transform(bytes, new DecompressionStream('gzip'));
    return validateArchive(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error.message.includes('backup') || error.message.includes('large')) throw error;
    fail();
  }
}
