import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {encodeArchive, decodeArchive, toBase64, validateArchive} from '../dist/library-backup.mjs';
import {reorderShelfBooks,detachShelf} from '../dist/library-shelves.mjs';

const require = createRequire(import.meta.url);
const {FolioStore} = require('../desktop/store.cjs');
const {resolveAsset, trustedSender} = require('../desktop/security.cjs');
const pdf = new Uint8Array(fs.readFileSync(new URL('../dist/assets/the-art-of-paying-attention.pdf', import.meta.url)));
const book = overrides => ({id: 'pdf-test', title: 'A book', author: '', filename: 'book.pdf', pageCount: 6, page: 3, progress: 50, status: 'reading', shelfId: 'shelf-one', marks: [{id: 'mark-one', kind: 'bookmark', page: 3, note: 'Keep this', createdAt: 1}], lastOpened: 10, zoom: 'fit-width', ...overrides});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('PDF copies, linked originals, shelves, notes, and progress survive reopening', t => {
  const directory = fixture(t), original = path.join(directory, 'original.pdf');
  fs.writeFileSync(original, pdf);
  let store = new FolioStore(path.join(directory, 'data'));
  store.writeOne('books', book());
  store.writeOne('shelves', {id: 'shelf-one', name: 'Reading'});
  store.writeFile('pdf-test', {bytes: pdf});
  store.writeFile('linked-book', {linkedPath: original});
  store.close();
  store = new FolioStore(path.join(directory, 'data'));
  assert.deepEqual(store.readOne('books', 'pdf-test'), book());
  assert.deepEqual(store.readAll('shelves'), [{id: 'shelf-one', name: 'Reading'}]);
  assert.deepEqual(store.readPDF('pdf-test'), pdf);
  assert.deepEqual(store.readPDF('linked-book'), pdf);
  store.removeOne('files', 'linked-book');
  assert.ok(fs.existsSync(original), 'removing a link must preserve the original');
  store.removeOne('files', 'pdf-test');
  assert.deepEqual(fs.readdirSync(store.pdfDirectory), []);
  store.close();
});

test('a portable compressed backup restores PDFs and merges annotations without losing newer progress', async t => {
  const directory = fixture(t);
  const bytes = await encodeArchive({books: [book()], shelves: [{id: 'shelf-one', name: 'Reading'}], files: [{id: 'pdf-test', bytes: pdf}]});
  assert.equal(bytes[0], 0x1f);
  const archive = await decodeArchive(bytes);
  const store = new FolioStore(directory);
  store.writeOne('books', book({page: 5, progress: 83, lastOpened: 20, marks: [{id: 'mark-two', kind: 'bookmark', page: 5, note: 'Newer', createdAt: 2}]}));
  store.importArchive(archive);
  store.importArchive(archive);
  const restored = store.readOne('books', 'pdf-test');
  assert.equal(restored.page, 5);
  assert.equal(restored.marks.length, 2);
  assert.equal(restored.source, 'copy');
  assert.deepEqual(store.readPDF('pdf-test'), pdf);
  assert.equal(store.readAll('books').length, 1);
  const second = await decodeArchive(await encodeArchive(store.snapshot()));
  assert.equal(second.books[0].marks.length, 2);
  store.close();
});

test('a failed restore rolls back all database changes and preserves existing PDFs', t => {
  const directory = fixture(t), store = new FolioStore(directory);
  store.writeOne('books', book()); store.writeFile('pdf-test', {bytes: pdf});
  assert.throws(() => store.importArchive({shelves: [{id: 'new-shelf', name: 'New'}], books: [book({id: 'new-book'}), book({id: '../invalid'})], files: [{id: 'new-book', data: toBase64(pdf)}]}));
  assert.equal(store.readOne('shelves', 'new-shelf'), undefined);
  assert.equal(store.readOne('books', 'new-book'), undefined);
  assert.deepEqual(store.readPDF('pdf-test'), pdf);
  store.close();
});

test('invalid archives and missing PDFs are rejected before restore', async () => {
  await assert.rejects(decodeArchive(new TextEncoder().encode('not a backup')));
  await assert.rejects(decodeArchive(new Uint8Array([0x1f, 0x8b, 0, 1])));
  const base = {format: 'folio-library', version: 1, books: [book()], shelves: [], files: []};
  assert.throws(() => validateArchive(base), /missing a PDF/);
  assert.throws(() => validateArchive({...base, files: [{id: 'pdf-test', data: toBase64(new TextEncoder().encode('not a PDF'))}]}));
  assert.throws(() => validateArchive({...base, books: [book({id: '../escape'})]}));
  assert.throws(() => validateArchive({...base, books: [book({marks: [{id: 'bad', kind: 'passage', page: 1, color: 'yellow', rects: [{x: -1, y: 0, width: 1, height: 1}]}]})]}));
});

test('desktop storage refuses unknown tables, invalid IDs, and non-PDF data', t => {
  const store = new FolioStore(fixture(t));
  assert.throws(() => store.readAll('secrets'));
  assert.throws(() => store.writeOne('books', book({id: '../../escape'})));
  assert.throws(() => store.writeFile('pdf-test', {bytes: new Uint8Array([1, 2, 3])}));
  store.close();
});

test('shelf names and book order persist through reopening and portable backup',async t=>{
  const directory=fixture(t);let store=new FolioStore(directory);
  const books=reorderShelfBooks([book({id:'first'}),book({id:'second'})],'shelf-one','second','first');
  store.writeLibrary([{store:'shelves',value:{id:'shelf-one',name:'Renamed'}},...books.map(value=>({store:'books',value})),{store:'settings',value:{id:'library-sort',value:'manual'}}]);
  for(const item of books)store.writeFile(item.id,{bytes:pdf});
  store.close();store=new FolioStore(directory);
  assert.equal(store.readOne('shelves','shelf-one').name,'Renamed');
  assert.equal(store.readOne('books','second').shelfOrder['shelf-one'],0);
  assert.equal(store.readOne('settings','library-sort').value,'manual');
  const archive=await decodeArchive(await encodeArchive(store.snapshot()));
  const restored=new FolioStore(path.join(directory,'restored'));restored.importArchive(archive);
  assert.equal(restored.readOne('books','first').shelfOrder['shelf-one'],1);
  const detached=detachShelf(store.readAll('books'),'shelf-one');
  store.writeLibrary([...detached.map(value=>({store:'books',value})),{store:'shelves',id:'shelf-one',remove:true}]);
  assert.equal(store.readOne('shelves','shelf-one'),undefined);
  assert.equal(store.readOne('books','first').shelfId,null);
  assert.equal(store.readOne('books','first').progress,50);
  assert.deepEqual(store.readPDF('first'),pdf);
  assert.deepEqual(store.readPDF('second'),pdf);
  store.close();restored.close();
});

test('a failed shelf change rolls back all metadata and keeps its PDFs',t=>{
  const store=new FolioStore(fixture(t));store.writeOne('books',book());store.writeFile('pdf-test',{bytes:pdf});
  store.writeOne('shelves',{id:'shelf-one',name:'Keep this'});
  assert.throws(()=>store.writeLibrary([{store:'shelves',id:'shelf-one',remove:true},{store:'books',value:book({id:'../invalid'})}]));
  assert.equal(store.readOne('shelves','shelf-one').name,'Keep this');
  assert.equal(store.readOne('books','pdf-test').shelfId,'shelf-one');
  assert.deepEqual(store.readPDF('pdf-test'),pdf);store.close();
});

test('the asset protocol and IPC accept only the Folio app and its main frame', () => {
  const root = '/tmp/folio/dist';
  assert.equal(resolveAsset(root, 'folio://app/'), '/tmp/folio/dist/index.html');
  assert.equal(resolveAsset(root, 'folio://app/vendor/pdf.mjs?v=1'), '/tmp/folio/dist/vendor/pdf.mjs');
  for (const address of ['https://app/index.html', 'folio://other/index.html', 'folio://user@app/index.html', 'folio://app/%00', 'folio://app/..%2F..%2Fetc/passwd', 'folio://app/%5Cetc', 'folio://app/%ZZ']) assert.equal(resolveAsset(root, address), null);
  const frame = {url: 'folio://app/index.html'}, contents = {mainFrame: frame};
  const window = {webContents: contents, isDestroyed: () => false};
  assert.equal(trustedSender({sender: contents, senderFrame: frame}, window), true);
  assert.equal(trustedSender({sender: contents, senderFrame: {url: frame.url}}, window), false);
  frame.url = 'https://example.com';
  assert.equal(trustedSender({sender: contents, senderFrame: frame}, window), false);
});
