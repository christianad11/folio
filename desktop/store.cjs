const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

const stores = new Set(['books', 'shelves', 'settings']);
const validID = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,179}$/.test(id);

class FolioStore {
  constructor(directory) {
    this.directory = directory;
    this.pdfDirectory = path.join(directory, 'PDFs');
    fs.mkdirSync(this.pdfDirectory, {recursive: true, mode: 0o700});
    const database = path.join(directory, 'library.sqlite');
    this.db = new DatabaseSync(database);
    fs.chmodSync(database, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store,id)); CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, path TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0);');
  }
  check(store, id) {
    if (!stores.has(store) || id !== undefined && !validID(id)) throw new Error('Invalid library record.');
  }
  readAll(store) {
    this.check(store);
    return this.db.prepare('SELECT value FROM records WHERE store=? ORDER BY rowid').all(store).map(row => JSON.parse(row.value));
  }
  readOne(store, id) {
    if (store === 'files') {
      if (!validID(id)) throw new Error('Invalid PDF record.');
      return this.db.prepare('SELECT id FROM files WHERE id=?').get(id) ? {id, native: true} : undefined;
    }
    this.check(store, id);
    const row = this.db.prepare('SELECT value FROM records WHERE store=? AND id=?').get(store, id);
    return row ? JSON.parse(row.value) : undefined;
  }
  writeOne(store, value) {
    this.check(store, value?.id);
    if (!validID(value?.id)) throw new Error('Invalid library record.');
    const json = JSON.stringify(value);
    if (json.length > 16 * 1024 * 1024) throw new Error('This library record is too large.');
    this.db.prepare('INSERT INTO records (store,id,value) VALUES (?,?,?) ON CONFLICT(store,id) DO UPDATE SET value=excluded.value').run(store, value.id, json);
  }
  managedPDF(bytes) {
    bytes = Buffer.from(bytes);
    if (bytes.length > 256 * 1024 * 1024 || !bytes.subarray(0, 1024).toString().includes('%PDF-')) throw new Error('Choose a valid PDF smaller than 256 MB.');
    const filename = path.join(this.pdfDirectory, crypto.createHash('sha256').update(bytes).digest('hex') + '.pdf');
    try { fs.writeFileSync(filename, bytes, {flag: 'wx', mode: 0o600}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return filename;
  }
  writeFile(id, {bytes, linkedPath}) {
    if (!validID(id)) throw new Error('Invalid PDF record.');
    const filename = linkedPath || this.managedPDF(bytes);
    this.db.prepare('INSERT INTO files (id,path,linked) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,linked=excluded.linked').run(id, filename, linkedPath ? 1 : 0);
  }
  readPDF(id) {
    if (!validID(id)) throw new Error('Invalid PDF record.');
    const file = this.db.prepare('SELECT path FROM files WHERE id=?').get(id);
    if (!file) throw new Error('Add the original PDF again to reconnect it.');
    try {
      if (fs.statSync(file.path).size > 256 * 1024 * 1024) throw new Error('PDF too large');
      return new Uint8Array(fs.readFileSync(file.path));
    }
    catch { throw new Error('This PDF could not be found. Add or link the original again to reconnect it.'); }
  }
  removeOne(store, id) {
    if (!validID(id)) throw new Error('Invalid library record.');
    if (store === 'files') this.db.prepare('DELETE FROM files WHERE id=?').run(id);
    else { this.check(store, id); this.db.prepare('DELETE FROM records WHERE store=? AND id=?').run(store, id); }
    this.collectUnusedPDFs();
  }
  collectUnusedPDFs() {
    const used = new Set(this.db.prepare('SELECT path FROM files').all().map(row => row.path));
    for (const name of fs.readdirSync(this.pdfDirectory)) {
      const filename = path.join(this.pdfDirectory, name);
      if (/^[a-f0-9]{64}\.pdf$/.test(name) && !used.has(filename)) fs.rmSync(filename, {force: true});
    }
  }
  snapshot() {
    const books = this.readAll('books');
    return {books, shelves: this.readAll('shelves'), files: books.filter(book => !book.sample).map(book => ({id: book.id, bytes: this.readPDF(book.id)}))};
  }
  importArchive(archive) {
    // Decode and validate the whole archive before calling this method. PDF files
    // are immutable, so a failed transaction cannot replace an existing PDF.
    const staged = archive.files.map(file => ({id: file.id, path: this.managedPDF(Buffer.from(file.data, 'base64'))}));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const shelf of archive.shelves) if (!this.readOne('shelves', shelf.id)) this.writeOne('shelves', shelf);
      for (const incoming of archive.books) {
        const current = this.readOne('books', incoming.id);
        const marks = new Map((current?.marks || []).map(mark => [mark.id, mark]));
        for (const mark of incoming.marks) if (!marks.has(mark.id)) marks.set(mark.id, mark);
        const book = current && (current.lastOpened || 0) > (incoming.lastOpened || 0) ? {...current} : {...incoming};
        book.marks = [...marks.values()];
        book.source = book.sample ? 'sample' : 'copy';
        this.writeOne('books', book);
      }
      for (const file of staged) this.db.prepare('INSERT INTO files (id,path,linked) VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET path=excluded.path,linked=0').run(file.id, file.path);
      this.writeOne('settings', {id: 'initialized', value: true});
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.collectUnusedPDFs(); }
    return archive.books.length;
  }
  close() { this.db.close(); }
}

module.exports = {FolioStore};
