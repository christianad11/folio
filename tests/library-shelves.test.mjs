import test from 'node:test';
import assert from 'node:assert/strict';
import {sortShelfBooks,reorderShelfBooks,detachShelf,validateShelfName} from '../dist/library-shelves.mjs';

const book=(id,extra={})=>({id,title:id,addedAt:1,status:'reading',page:3,progress:50,marks:[{id:'passage-one',text:'Keep this'}],...extra});
const ids=books=>books.map(item=>item.id);

test('shelf names can be edited without accepting empty or duplicate names',()=>{
  const shelves=[{id:'one',name:'Essays'},{id:'two',name:'History'}];
  assert.equal(validateShelfName('  Essays  ',shelves,'one'),'Essays');
  assert.equal(validateShelfName('Fiction',shelves,'one'),'Fiction');
  assert.throws(()=>validateShelfName(' history ',shelves,'one'),/already exists/);
  assert.throws(()=>validateShelfName(' ',shelves),/name/);
  assert.throws(()=>validateShelfName('a'.repeat(61),shelves),/60/);
});

test('books move before or after another book and retain independent orders for other shelves',()=>{
  const original=[book('a',{shelfOrder:{reading:4}}),book('b'),book('c')];
  const before=reorderShelfBooks(original,'one','c','a');
  assert.deepEqual(ids(before),['c','a','b']);
  assert.deepEqual(ids(sortShelfBooks([...before].reverse(),'one')),['c','a','b']);
  assert.equal(before[1].shelfOrder.reading,4);
  assert.deepEqual(original[0].shelfOrder,{reading:4});
  assert.deepEqual(ids(reorderShelfBooks(original,'one','a','c',true)),['b','c','a']);
  assert.deepEqual(reorderShelfBooks(original,'one','a','a'),[]);
  assert.deepEqual(reorderShelfBooks(original,'one','missing','a'),[]);
});

test('reordering keeps books outside the current search and leaves reading data intact',()=>{
  const original=[book('a'),book('hidden'),book('b'),book('c')];
  const moved=reorderShelfBooks(original,'one','c','b');
  assert.deepEqual(ids(moved),['a','hidden','c','b']);
  assert.deepEqual(moved[2].marks,original[3].marks);
  assert.equal(moved[2].progress,50);
  assert.equal(moved[2].page,3);
});

test('new books follow the saved shelf order while other sort choices remain available',()=>{
  const books=[book('b',{shelfOrder:{one:1}}),book('new',{addedAt:50}),book('a',{shelfOrder:{one:0}})];
  assert.deepEqual(ids(sortShelfBooks(books,'one')),['a','b','new']);
  assert.deepEqual(ids(sortShelfBooks(books,'one','recent')),['new','b','a']);
  assert.deepEqual(ids(sortShelfBooks(books,'one','title')),['a','b','new']);
});

test('deleting a shelf detaches its books without changing PDFs, progress, or passages',()=>{
  const original=[book('a',{shelfId:'one',shelfOrder:{one:0,all:2}}),book('b',{shelfId:'two',shelfOrder:{one:1,two:0}}),book('c',{shelfId:'two'})];
  const detached=detachShelf(original,'one');
  assert.deepEqual(ids(detached),['a','b']);
  assert.equal(detached[0].shelfId,null);
  assert.deepEqual(detached[0].shelfOrder,{all:2});
  assert.equal(detached[1].shelfId,'two');
  assert.deepEqual(detached[1].shelfOrder,{two:0});
  assert.equal(detached[0].status,'reading');
  assert.deepEqual(detached[0].marks,original[0].marks);
  assert.equal(original[0].shelfId,'one');
});
