import * as pdfjs from './vendor/pdf.mjs?v=6.4.299';
import {normalizeSearchText,indexPDFText,findPDFMatches} from './pdf-search.mjs';
import {encodeArchive,decodeArchive,fromBase64} from './library-backup.mjs';
import {checkPDFBytes,MAX_PDF_BYTES,PDF_DOCUMENT_OPTIONS} from './pdf-safety.mjs';
import {digestPDF,inspectWithConsent} from './pdf-consent.mjs';
const pdfAttachmentApprovals=new WeakMap();
const startupStarted=performance.now();

const desktop=window.folioDesktop;
const nativeWrites=new Set();
function trackWrite(promise){nativeWrites.add(promise);promise.finally(()=>nativeWrites.delete(promise)).catch(()=>{});return promise;}
if(desktop){document.documentElement.classList.add('desktop');const chrome=document.createElement('div');chrome.className='desktop-chrome';chrome.setAttribute('aria-hidden','true');document.body.prepend(chrome);}

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs?v=6.4.299', import.meta.url).href;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const uid = () => {
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const state = {books:[], shelves:[], shelf:'all', search:'', sort:'recent', book:null, pdf:null, page:1, scale:1, zoom:'fit-page', outline:[], panel:null, focus:false, color:'yellow', selection:null, renderId:0, view:'library'};
let db, toastTimer, dialogSubmit, dialogResult, contextMenu, openingId=0, importBusy=false, pinchTimer, gestureStartScale=1, pointerDrag=null, suppressBookClick=0;
const volatileFiles = new Map();
const pdfOptions = {...PDF_DOCUMENT_OPTIONS,cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/wasm/',import.meta.url).href};

function toast(message, persistent=false) {
  clearTimeout(toastTimer); $('toast-text').textContent=message; $('toast').hidden=false;
  if(!persistent) toastTimer=setTimeout(()=>$('toast').hidden=true,4500);
}
$('toast-close').onclick=()=>$('toast').hidden=true;

async function initStorage() {
  try {
    db = desktop?{native:true}:await new Promise((resolve,reject)=>{const req=indexedDB.open('folio-library',1);req.onupgradeneeded=()=>{for(const name of ['books','files','shelves','settings'])req.result.createObjectStore(name,{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('Storage is busy'));});
    if(!desktop)db.onversionchange=()=>db.close();
    state.books=await readAll('books'); state.shelves=await readAll('shelves');
    const seeded=await readOne('settings','initialized');
    if(!seeded){state.shelves=[{id:'quiet-reads',name:'Quiet reads'}];state.books=[{id:'sample-attention',title:'The art of paying attention',author:'Folio field notes',filename:'the-art-of-paying-attention.pdf',pageCount:6,page:1,progress:0,status:'reading',shelfId:'quiet-reads',sample:true,source:'sample',addedAt:Date.now(),lastOpened:0,marks:[],zoom:'fit-page'}];await Promise.all([...state.shelves.map(s=>writeOne('shelves',s)),...state.books.map(b=>writeOne('books',b))]);await writeOne('settings',{id:'initialized',value:true});}
    if(!desktop&&navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
  } catch(error){db=null;state.shelves=[{id:'quiet-reads',name:'Quiet reads'}];state.books=[{id:'sample-attention',title:'The art of paying attention',author:'Folio field notes',filename:'the-art-of-paying-attention.pdf',pageCount:6,page:1,progress:0,status:'reading',shelfId:'quiet-reads',sample:true,source:'sample',addedAt:Date.now(),lastOpened:0,marks:[],zoom:'fit-page'}];toast('Local storage is unavailable. You can read for this session; export passages before leaving.',true);}
}
function readAll(store){if(desktop)return desktop.readAll(store);return new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function readOne(store,id){if(desktop)return desktop.readOne(store,id);return new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function writeOne(store,value){if(desktop){if(store==='files'){if(value.handle?.nativeToken)return trackWrite(desktop.writeFile({id:value.id,token:value.handle.nativeToken}));if(value.blob)return trackWrite(desktop.writeFile({id:value.id,bytes:new Uint8Array(await value.blob.arrayBuffer())}));throw new Error('Choose the original PDF again.');}return trackWrite(desktop.writeOne(store,value));}return new Promise((resolve,reject)=>{if(!db)return reject(new Error('Storage unavailable'));const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function removeOne(store,id){if(desktop)return trackWrite(desktop.removeOne(store,id));return new Promise((resolve,reject)=>{if(!db)return resolve();const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function saveBook(book){try{await writeOne('books',book);return true;}catch{toast('Changes are kept for this session. Local storage is unavailable or full; export your passages before leaving.',true);return false;}}
function filteredBooks(){return state.books.filter(b=>(state.shelf==='all'||state.shelf==='reading'&&b.status==='reading'||state.shelf==='finished'&&b.status==='finished'||b.shelfId===state.shelf)&&(!state.search||`${b.title} ${b.author} ${b.filename}`.toLowerCase().includes(state.search.toLowerCase()))).sort((a,b)=>state.sort==='title'?a.title.localeCompare(b.title):state.sort==='progress'?b.progress-a.progress:(b.lastOpened||b.addedAt)-(a.lastOpened||a.addedAt));}
function shelfCount(id){return state.books.filter(b=>id==='all'||id==='reading'&&b.status==='reading'||id==='finished'&&b.status==='finished'||b.shelfId===id).length;}
function navItem(id,name,ico){return `<button class="nav-item ${state.shelf===id?'active':''}" data-shelf="${esc(id)}" ${state.shelf===id?'aria-current="page"':''}>${icon(ico)}<span class="nav-name">${esc(name)}</span><span class="nav-count">${shelfCount(id)}</span></button>`;}
function syncLibraryNav(){const closed=innerWidth<=750&&!$('library-sidebar').classList.contains('open');$('library-sidebar').toggleAttribute('inert',closed);$('library-sidebar').setAttribute('aria-hidden',String(closed));$('mobile-menu').setAttribute('aria-expanded',String(!closed&&innerWidth<=750));}
function renderLibrary(){syncLibraryNav();
  $('shelf-nav').innerHTML=navItem('all','All books','grid')+navItem('reading','Currently reading','book')+navItem('finished','Finished','check');
  $('custom-shelf-nav').innerHTML=state.shelves.map(s=>navItem(s.id,s.name,'shelf')).join('');
  document.querySelectorAll('[data-shelf]').forEach(btn=>{btn.onclick=()=>{state.shelf=btn.dataset.shelf;state.search='';$('book-search').value='';$('library-sidebar').classList.remove('open');$('mobile-menu').setAttribute('aria-expanded','false');renderLibrary();};btn.ondragover=e=>{if(e.dataTransfer.types.includes('application/x-folio-book')){e.preventDefault();e.dataTransfer.dropEffect='move';btn.classList.add('drag-over');}};btn.ondragleave=()=>btn.classList.remove('drag-over');btn.ondrop=async e=>{e.preventDefault();btn.classList.remove('drag-over');const id=e.dataTransfer.getData('application/x-folio-book');if(id)await moveBook(id,btn.dataset.shelf);};});
  const custom=state.shelves.find(s=>s.id===state.shelf);
  $('library-title').textContent=state.shelf==='all'?'Your library':state.shelf==='reading'?'Currently reading':state.shelf==='finished'?'Finished':custom?.name||'Your library';
  const books=filteredBooks(); $('book-count').textContent=`${books.length} ${books.length===1?'book':'books'}`;
  const reading=state.books.filter(b=>b.status==='reading').sort((a,b)=>b.lastOpened-a.lastOpened)[0];
  $('reading-spot').hidden=!(state.shelf==='all'&&!state.search&&reading);
  if(reading){$('reading-spot').innerHTML=`${icon('book').replace('<svg','<svg class="spot-book-icon"')}<div class="spot-copy"><h2>${esc(reading.title)}</h2></div><div class="spot-progress"><div class="spot-progress-top"><span>${reading.progress?`Page ${reading.page} of ${reading.pageCount}`:'Not started'}</span><span>${reading.progress}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${reading.progress}%"></div></div></div><button class="secondary-button spot-button" id="continue-reading">${reading.progress?'Continue reading':'Start reading'}${icon('arrow')}</button>`;$('continue-reading').onclick=()=>openBook(reading.id);}
  $('books-grid').innerHTML=books.map(bookCard).join('')+(state.search?'':`<button class="add-book-tile" id="add-book-tile"><span class="tile-icon">${icon('plus')}</span><span>Add PDFs</span></button>`);
  if(!books.length&&state.search){$('books-grid').innerHTML=`<div class="empty-library">${icon('search')}<h2>No books found</h2><p>No titles match “${esc(state.search)}”. Try another search.</p><button class="secondary-button" id="clear-search">Clear search</button></div>`;$('clear-search').onclick=()=>{state.search='';$('book-search').value='';renderLibrary();};}
  if(!books.length&&!state.search){$('books-grid').insertAdjacentHTML('afterbegin',`<div class="empty-library">${icon(state.shelf==='finished'?'check':'book')}<h2>${state.shelf==='finished'?'No finished books':'No books yet'}</h2></div>`);}
  $('add-book-tile')?.addEventListener('click',choosePDFs);
  document.querySelectorAll('.book-cover-button').forEach(b=>{b.onclick=()=>{if(Date.now()>suppressBookClick)openBook(b.dataset.book);};b.onpointerdown=startBookDrag;});
  document.querySelectorAll('.book-menu-button').forEach(b=>b.onclick=e=>{e.stopPropagation();showBookMenu(b.dataset.book,b);});
  document.querySelectorAll('.book-card').forEach(card=>{card.ondragstart=e=>e.preventDefault();});
  $('export-library').disabled=!state.books.some(b=>b.marks?.length);
}
function bookCard(b){return `<article class="book-card" draggable="false" data-book="${esc(b.id)}"><button class="book-cover-button" draggable="false" data-book="${esc(b.id)}" aria-label="Read ${esc(b.title)}"><div class="book-cover ${b.sample?'sample-cover':''}">${b.sample?'<div class="cover-series">Folio<br>Field notes · 01</div><div class="cover-rule"></div><div class="cover-title">The art of<br>paying<br>attention.</div><div class="cover-art"></div><div class="cover-author">A quieter way of being</div>':b.cover?`<img src="${esc(b.cover)}" alt="" loading="lazy" draggable="false">`:`<div class="sample-cover"><div class="cover-series">From your library</div><div class="cover-title">${esc(b.title)}</div></div>`}<div class="cover-read"><span>${b.progress?'Continue reading':'Start reading'}${icon('arrow')}</span></div></div></button><div class="book-detail-row"><div class="book-info"><h2 class="book-title">${esc(b.title)}</h2><div class="book-author">${esc(b.author||'Personal document')}</div></div><button class="icon-button small book-menu-button" data-book="${esc(b.id)}" aria-label="Options for ${esc(b.title)}">${icon('more')}</button></div><div class="book-progress-row"><span>${b.status==='finished'?'Finished':b.progress?`${b.progress}% · Page ${b.page} of ${b.pageCount}`:'Not started'}</span><span class="source-label">${b.source==='linked'?icon('link')+'Linked PDF':b.sample?'Sample PDF':`${b.pageCount} pages`}</span></div><div class="progress-track" role="progressbar" aria-label="Reading progress for ${esc(b.title)}" aria-valuenow="${b.progress}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${b.progress}%"></div></div></article>`;}
async function moveBook(id,shelfId){const book=state.books.find(b=>b.id===id);if(!book)return;if(shelfId==='reading'||shelfId==='finished'){book.status=shelfId;if(shelfId==='finished'){book.progress=100;book.page=book.pageCount;}}else if(shelfId==='all'){book.shelfId=null;}else{book.shelfId=shelfId;}const saved=await saveBook(book);renderLibrary();if(saved)toast(`Moved to ${shelfId==='all'?'All books':shelfId==='reading'?'Currently reading':shelfId==='finished'?'Finished':state.shelves.find(s=>s.id===shelfId)?.name||'shelf'}.`);}
function closeContext(){contextMenu?.remove();contextMenu=null;}
function startBookDrag(event){
  if(event.button!==0||event.pointerType==='touch')return;
  pointerDrag={id:event.currentTarget.dataset.book,button:event.currentTarget,card:event.currentTarget.closest('.book-card'),x:event.clientX,y:event.clientY,pointerId:event.pointerId,active:false};
}
function clearBookDrag(){
  if(!pointerDrag)return;
  pointerDrag.card.classList.remove('dragging');pointerDrag.ghost?.remove();
  document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));
  try{pointerDrag.button.releasePointerCapture(pointerDrag.pointerId);}catch{}
  pointerDrag=null;
}
document.addEventListener('pointermove',event=>{
  const drag=pointerDrag;if(!drag||event.pointerId!==drag.pointerId)return;
  if(!drag.active&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<8)return;
  if(!drag.active){drag.active=true;closeContext();drag.button.setPointerCapture(event.pointerId);drag.card.classList.add('dragging');window.getSelection()?.removeAllRanges();drag.ghost=document.createElement('div');drag.ghost.className='book-drag-ghost';drag.ghost.innerHTML=drag.button.querySelector('.book-cover').outerHTML;document.body.append(drag.ghost);}
  event.preventDefault();drag.ghost.style.left=event.clientX+16+'px';drag.ghost.style.top=event.clientY-35+'px';
  const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-shelf]');
  document.querySelectorAll('.drag-over').forEach(el=>el.classList.toggle('drag-over',el===target));target?.classList.add('drag-over');drag.shelf=target?.dataset.shelf;
},{passive:false});
document.addEventListener('pointerup',event=>{
  const drag=pointerDrag;if(!drag||event.pointerId!==drag.pointerId)return;
  const active=drag.active,id=drag.id,shelf=drag.shelf;clearBookDrag();
  if(active){event.preventDefault();suppressBookClick=Date.now()+500;if(shelf)moveBook(id,shelf);}
});
document.addEventListener('pointercancel',clearBookDrag);
function showBookMenu(id,anchor){closeContext();const book=state.books.find(b=>b.id===id);if(!book)return;const menu=document.createElement('div');menu.className='floating-menu book-context';menu.innerHTML=`<button data-action="read">${icon('book')}Open book</button><button data-action="move">${icon('shelf')}Move to a shelf</button><button data-action="status">${icon(book.status==='finished'?'book':'check')}${book.status==='finished'?'Mark as reading':'Mark as finished'}</button><button data-action="export" ${book.marks?.length?'':'disabled'}>${icon('download')}Export saved passages</button><button data-action="remove" class="danger">${icon('trash')}Remove from library</button>`;document.body.append(menu);contextMenu=menu;const r=anchor.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(r.right-200,innerWidth-208))+'px';menu.style.top=Math.max(8,Math.min(r.bottom+4,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button').focus();menu.onclick=async e=>{const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;closeContext();if(action==='read')openBook(id);if(action==='move')chooseShelf(book);if(action==='status')await moveBook(id,book.status==='finished'?'reading':'finished');if(action==='export')exportPassages([book],'md');if(action==='remove')removeBook(book);};}
async function chooseShelf(book){await showDialog({title:'Move book',body:`<p>Choose a shelf for “${esc(book.title)}”.</p><label for="dialog-shelf">Shelf</label><select id="dialog-shelf"><option value="all">All books only</option><option value="reading">Currently reading</option><option value="finished">Finished</option>${state.shelves.map(s=>`<option value="${esc(s.id)}" ${book.shelfId===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>`,submit:'Move book',onSubmit:async()=>{await moveBook(book.id,$('dialog-shelf').value);return true;}});}
async function createShelf(){await showDialog({title:'Create shelf',body:'<label for="shelf-name">Shelf name</label><input id="shelf-name" autocomplete="off" placeholder="e.g. Slow Sunday reads" maxlength="60" required><p id="shelf-error" class="form-error" hidden></p>',submit:'Create shelf',onSubmit:async()=>{const name=$('shelf-name').value.trim();if(!name||state.shelves.some(s=>s.name.toLowerCase()===name.toLowerCase())){$('shelf-error').hidden=false;$('shelf-error').textContent=name?'There is already a shelf with that name. Choose another name.':'Give this shelf a name.';$('shelf-name').setAttribute('aria-invalid','true');$('shelf-name').setAttribute('aria-describedby','shelf-error');return false;}const shelf={id:uid(),name};state.shelves.push(shelf);try{await writeOne('shelves',shelf);}catch{toast('This shelf is available for this session. Local storage is unavailable.',true);}state.shelf=shelf.id;renderLibrary();return true;}});}
async function removeBook(book){await showDialog({title:'Remove this book?',body:`<p>“${esc(book.title)}” and its saved passages will be removed from your library. Your original PDF file will stay on your computer.</p>`,submit:'Remove book',icon:'trash',onSubmit:async()=>{try{await removeOne('books',book.id);await removeOne('files',book.id);volatileFiles.delete(book.id);state.books=state.books.filter(b=>b.id!==book.id);renderLibrary();toast('Book removed from this library.');return true;}catch{toast('Unable to remove this book. Try again.',true);return false;}}});}
function showDialog({title,body,submit='Done',onSubmit=()=>true,icon:ico='shelf',cancel='Cancel',onlyClose=false}){return new Promise(resolve=>{dialogResult=resolve;dialogSubmit=onSubmit;$('dialog-title').textContent=title;$('dialog-body').innerHTML=body;$('dialog-submit').textContent=submit;$('dialog-submit').hidden=onlyClose;$('dialog-submit').disabled=false;$('dialog-cancel').textContent=onlyClose?'Done':cancel;$('dialog-icon').innerHTML=icon(ico);$('app-dialog').showModal();requestAnimationFrame(()=>$('dialog-body').querySelector('input,select,textarea')?.focus());});}
$('dialog-form').onsubmit=async e=>{e.preventDefault();$('dialog-submit').disabled=true;try{if(await dialogSubmit?.())$('app-dialog').close('submitted');}catch(error){toast(error.message||'Unable to complete that action. Try again.',true);}finally{$('dialog-submit').disabled=false;}};
$('dialog-close').onclick=$('dialog-cancel').onclick=()=>$('app-dialog').close();
$('app-dialog').onclose=()=>{dialogResult?.($('app-dialog').returnValue==='submitted');dialogResult=null;};
$('app-dialog').addEventListener('click',e=>{if(e.target===$('app-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});

async function loadPdf(data,{book=null,filename='This PDF',intent='add'}={}){
  checkPDFBytes(data);
  // Start hashing before PDF.js transfers the input buffer to its worker.
  const digest=digestPDF(data,desktop?.digestPDF);digest.catch(()=>{});
  const task=pdfjs.getDocument({...pdfOptions,data:new Uint8Array(data)});
  task.onPassword=async(update,reason)=>{
    let password='';
    const accepted=await showDialog({title:reason===pdfjs.PasswordResponses.INCORRECT_PASSWORD?'Try that password again':'This PDF is locked',icon:'book',body:'<p>Enter the document password to open it.</p><label for="pdf-password">PDF password</label><input id="pdf-password" type="password" autocomplete="off" required>',submit:'Open PDF',onSubmit:()=>{password=$('pdf-password').value;return true;}});
    if(accepted)update(password);else task.destroy();
  };
  try{
    const pdf=await task.promise;
    const existing=book||state.books.find(item=>item.fingerprint===pdf.fingerprints[0]);
    const approval=await inspectWithConsent(pdf,{
      digest,approval:existing?.attachmentConsent,
      confirmAttachments:()=>showDialog({
        title:intent==='open'?'Open this PDF anyway?':'Add this PDF anyway?',
        body:`<p>“${esc(filename)}” contains embedded files.</p><p>They will stay disabled while you read.</p>`,
        submit:intent==='open'?'Open anyway':'Add anyway',cancel:'Cancel',onSubmit:()=>true,icon:'book'
      })
    });
    pdfAttachmentApprovals.set(pdf,approval);
    return pdf;
  }catch(error){await task.destroy().catch(()=>{});throw error;}
}

async function importFiles(files,handles=[],{quiet=false}={}){
  const result={ids:[],added:0,existing:0,canceled:0,failed:0};
  if(importBusy){toast('Finishing the current import. Add more PDFs in a moment.');result.failed++;return result;}
  const entries=Array.from(files,(file,index)=>({file,handle:handles[index]})).filter(({file})=>file.type==='application/pdf'||/\.pdf$/i.test(file.name));
  if(!entries.length){toast('Choose a PDF file to add it to your library.',true);result.failed++;return result;}
  importBusy=true;$('add-pdfs').disabled=true;
  try{
    for(const {file,handle} of entries){
      toast(`Adding ${file.name}…`,true);let pdf;
      try{
        if(file.size>MAX_PDF_BYTES)throw new Error('Choose a PDF smaller than 256 MB.');
        const data=await file.arrayBuffer();
        pdf=await loadPdf(data.slice(0),{filename:file.name,intent:'add'});
        const fingerprint=pdf.fingerprints[0],attachmentConsent=pdfAttachmentApprovals.get(pdf);
        const duplicate=state.books.find(book=>book.fingerprint===fingerprint);
        if(duplicate){
          if(!duplicate.sample){
            const replacement={id:duplicate.id,...(handle?{handle}:{blob:file})};
            try{await writeOne('files',replacement);volatileFiles.delete(duplicate.id);duplicate.source=handle?'linked':'copy';}
            catch{volatileFiles.set(duplicate.id,{blob:file});toast('This PDF is connected for this session. Local storage is unavailable.',true);}
          }
          duplicate.attachmentConsent=attachmentConsent;await saveBook(duplicate);
          result.ids.push(duplicate.id);result.existing++;continue;
        }
        let info={};try{info=(await pdf.getMetadata()).info||{};}catch{}
        const title=String(info.Title||'').trim();
        const book={id:'pdf-'+fingerprint,fingerprint,title:title&&title!=='Untitled'?title:file.name.replace(/\.pdf$/i,'').replace(/[_]/g,' '),author:String(info.Author||'').trim(),filename:file.name,pageCount:pdf.numPages,page:1,progress:0,status:state.shelf==='reading'?'reading':state.shelf==='finished'?'finished':'to-read',shelfId:state.shelves.some(shelf=>shelf.id===state.shelf)?state.shelf:null,addedAt:Date.now(),lastOpened:0,marks:[],source:handle?'linked':'copy',zoom:'fit-page',attachmentConsent};
        if(book.status==='finished'){book.page=pdf.numPages;book.progress=100;}
        book.cover=await createBookCover(pdf);
        if(book.cover)book.coverVersion=1;
        try{await writeOne('files',{id:book.id,...(handle?{handle}:{blob:file})});}
        catch{
          if(handle&&db){await writeOne('files',{id:book.id,blob:file});book.source='copy';}
          else{volatileFiles.set(book.id,{blob:file});toast('This PDF is available for this session. Local storage is unavailable or full.',true);}
        }
        state.books.push(book);await saveBook(book);result.ids.push(book.id);result.added++;renderLibrary();
      }catch(error){
        if(error?.name==='AbortException')result.canceled++;
        else{result.failed++;toast(`${file.name}: ${error.message||'Unable to open this PDF.'}`,true);}
      }finally{await pdf?.loadingTask?.destroy();}
    }
  }finally{
    importBusy=false;$('add-pdfs').disabled=false;$('file-input').value='';
    if(!quiet)showImportResult(result);
  }
  return result;
}

async function createBookCover(pdf){
  const canvas=document.createElement('canvas');
  try{
    const page=await pdf.getPage(1),viewport=page.getViewport({scale:320/page.getViewport({scale:1}).width});
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    return canvas.toDataURL('image/jpeg',.8);
  }catch{return undefined;}
  finally{canvas.width=canvas.height=0;}
}

function showImportResult(result){
  const parts=[];
  if(result.added)parts.push(`${result.added} ${result.added===1?'PDF':'PDFs'} added`);
  if(result.existing)parts.push(`${result.existing} already in your library`);
  const skipped=result.canceled+result.failed;
  if(parts.length){if(skipped)parts.push(`${skipped} skipped`);toast(parts.join(' · ')+'.');}
  else if(result.canceled&&!result.failed)toast('No PDFs added.');
}

async function linkFiles(){if(desktop){$('add-menu').hidden=true;$('add-options-toggle').setAttribute('aria-expanded','false');return chooseNativePDFs({linked:true});} $('add-menu').hidden=true;$('add-options-toggle').setAttribute('aria-expanded','false');if(!window.showOpenFilePicker){toast('This browser can keep a local copy. Choose a PDF to add it.');$('file-input').click();return;}try{const handles=await window.showOpenFilePicker({multiple:true,types:[{description:'PDF documents',accept:{'application/pdf':['.pdf']}}]});const files=await Promise.all(handles.map(h=>h.getFile()));await importFiles(files,handles);}catch(error){if(error.name!=='AbortError')toast('Unable to link that file. Use Add PDFs to keep a browser copy.',true);}}
async function getBookData(book){if(book.sample){const r=await fetch('./assets/the-art-of-paying-attention.pdf');if(!r.ok)throw new Error('The sample PDF could not be loaded.');return r.arrayBuffer();}const temporary=volatileFiles.get(book.id);if(temporary)return temporary.blob.arrayBuffer();if(desktop){const bytes=new Uint8Array(await desktop.readPDF(book.id));return bytes.buffer;}const record=(db?await readOne('files',book.id):null);if(!record)throw new Error('This PDF is no longer stored here. Add the original PDF again to reconnect it.');if(record.handle){if(await record.handle.queryPermission({mode:'read'})!=='granted'&&await record.handle.requestPermission({mode:'read'})!=='granted')throw new Error('Allow access to the linked file to continue reading.');return(await record.handle.getFile()).arrayBuffer();}return record.blob.arrayBuffer();}

let pageSlots = [], pageObserver, readerGeneration = 0, renderQueue = [], activeRenders = 0;
let scrollFrame = 0, positionTimer, restoringLayout = false;
let referencePageSize = {width:580,height:760};
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let readerNavigation=0,readerTransition=null,navigationPage=null;
const pdfSearch={open:false,query:'',matches:[],byPage:new Map(),active:-1,busy:false,request:0,jump:0,timer:null,index:new Map()};

function cancelReaderNavigation() {
  readerNavigation++;navigationPage=null;
  if (readerTransition) {
    const main=$('reader-main');
    main.scrollTo({top:main.scrollTop,left:main.scrollLeft,behavior:'auto'});
    readerTransition.finish(false);
  }
}

function scheduleReaderLayout() {
  cancelReaderNavigation();
  const navigation=readerNavigation;
  requestAnimationFrame(()=>{if(navigation===readerNavigation && state.view==='reader' && state.pdf)renderPage(state.page,{preserveScroll:true});});
}

function moveReaderTo(top,left=$('reader-main').scrollLeft) {
  const main=$('reader-main'),content=$('pages-container');
  top=Math.max(0,Math.min(top,main.scrollHeight-main.clientHeight));
  left=Math.max(0,Math.min(left,main.scrollWidth-main.clientWidth));
  const distance=Math.hypot(top-main.scrollTop,left-main.scrollLeft);
  if (reducedMotion.matches || distance<12) {
    main.scrollTo({top,left,behavior:'auto'});return Promise.resolve(true);
  }
  return new Promise(resolve=>{
    const run={frame:0,animations:[],finish(arrived){
      if (readerTransition!==run) return;
      cancelAnimationFrame(run.frame);
      for (const animation of run.animations) animation.cancel();
      readerTransition=null;main.removeAttribute('data-navigating');resolve(arrived);
    }};
    readerTransition=run;main.dataset.navigating='true';
    if (distance<=main.clientHeight*1.6) {
      const started=performance.now();
      main.scrollTo({top,left,behavior:'smooth'});
      const settle=now=>{
        if (readerTransition!==run) return;
        if (Math.abs(main.scrollTop-top)<1 && Math.abs(main.scrollLeft-left)<1 || now-started>900) {
          main.scrollTo({top,left,behavior:'auto'});run.finish(true);
        } else run.frame=requestAnimationFrame(settle);
      };
      run.frame=requestAnimationFrame(settle);
    } else {
      // Distant jumps dissolve in place instead of racing past unread pages.
      (async()=>{
        const out=content.animate([{opacity:1},{opacity:0}],{duration:90,easing:'ease-out',fill:'forwards'});
        run.animations.push(out);
        await out.finished.catch(()=>{});
        if (readerTransition!==run) return;
        main.scrollTo({top,left,behavior:'auto'});
        const incoming=content.animate([{opacity:0},{opacity:1}],{duration:170,easing:'ease-out',fill:'forwards'});
        run.animations.push(incoming);out.cancel();
        await incoming.finished.catch(()=>{});
        run.finish(true);
      })();
    }
  });
}
reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches)cancelReaderNavigation();});

function updatePDFSearch() {
  $('pdf-search').hidden=!pdfSearch.open;
  $('search-toggle').setAttribute('aria-expanded',String(pdfSearch.open));
  const total=pdfSearch.matches.length,current=total?pdfSearch.active+1:0;
  $('search-count').textContent=pdfSearch.busy?'…':pdfSearch.query?`${current} / ${total}`:'';
  $('search-status').textContent=pdfSearch.busy?'Searching PDF':pdfSearch.query?(total?`Match ${current} of ${total}`:'No matches'):'';
  $('search-previous').disabled=$('search-next').disabled=pdfSearch.busy || !total;
  $('pdf-search').setAttribute('aria-busy',String(pdfSearch.busy));
}

function resetPDFSearch() {
  clearTimeout(pdfSearch.timer);pdfSearch.request++;pdfSearch.jump++;
  Object.assign(pdfSearch,{open:false,query:'',matches:[],active:-1,busy:false});
  pdfSearch.byPage.clear();pdfSearch.index.clear();$('pdf-query').value='';updatePDFSearch();
}

function setPDFSearch(open) {
  if (state.view!=='reader' || !state.pdf) return;
  pdfSearch.open=open;
  if (open) {
    updatePDFSearch();$('pdf-query').focus();$('pdf-query').select();
    if ($('pdf-query').value.trim()) searchPDF();
  } else {
    cancelReaderNavigation();
    clearTimeout(pdfSearch.timer);pdfSearch.request++;pdfSearch.jump++;pdfSearch.busy=false;
    updatePDFSearch();drawSearchMatches();
    (state.focus?$('reader-main'):$('search-toggle')).focus({preventScroll:true});
  }
}

function schedulePDFSearch() {
  cancelReaderNavigation();
  clearTimeout(pdfSearch.timer);pdfSearch.request++;pdfSearch.jump++;
  pdfSearch.query=normalizeSearchText($('pdf-query').value).text.trim();
  pdfSearch.matches=[];pdfSearch.byPage.clear();pdfSearch.active=-1;
  pdfSearch.busy=!!pdfSearch.query;updatePDFSearch();drawSearchMatches();
  if (pdfSearch.query) pdfSearch.timer=setTimeout(searchPDF,180);
}

async function searchPDF() {
  clearTimeout(pdfSearch.timer);
  const pdf=state.pdf,request=++pdfSearch.request;
  const query=normalizeSearchText($('pdf-query').value).text.trim();
  if (!pdf || !pdfSearch.open || !query) {schedulePDFSearch();return;}
  const current=()=>request===pdfSearch.request && pdf===state.pdf && pdfSearch.open;
  pdfSearch.query=query;pdfSearch.busy=true;updatePDFSearch();
  const matches=[],byPage=new Map();
  let failed=0;
  for (let page=1;page<=pdf.numPages;page++) {
    if (!current()) return;
    try {
      if (!pdfSearch.index.has(page)) pdfSearch.index.set(page,pdf.getPage(page).then(p=>p.getTextContent()).then(indexPDFText));
      const index=await pdfSearch.index.get(page);
      if (!current()) return;
      const found=findPDFMatches(index,query,page);
      if (found.length) {byPage.set(page,found);matches.push(...found);}
    } catch {
      if (!current()) return;
      pdfSearch.index.delete(page);failed++;
    }
    if (page%8===0) await new Promise(resolve=>setTimeout(resolve,0));
  }
  if (!current()) return;
  pdfSearch.matches=matches;pdfSearch.byPage=byPage;pdfSearch.busy=false;
  pdfSearch.active=matches.findIndex(match=>match.page>=state.page);
  if (matches.length && pdfSearch.active<0) pdfSearch.active=0;
  updatePDFSearch();drawSearchMatches();
  if (failed) toast(`Could not search ${failed===1?'one page':`${failed} pages`} in this PDF.`);
  if (matches.length) jumpToSearchMatch();
}

function moveSearchMatch(direction) {
  if (pdfSearch.busy || !pdfSearch.matches.length) return;
  pdfSearch.active=(pdfSearch.active+direction+pdfSearch.matches.length)%pdfSearch.matches.length;
  updatePDFSearch();drawSearchMatches();jumpToSearchMatch();
}

async function jumpToSearchMatch() {
  const match=pdfSearch.matches[pdfSearch.active];
  if (!match) return;
  await renderPage(match.page,{searchMatch:match});
}

function drawPageSearch(slot) {
  slot.searchLayer.replaceChildren();
  if (!pdfSearch.open || !slot.paintedScale || !slot.textDivs) return;
  const page=slot.element.getBoundingClientRect(),fragment=document.createDocumentFragment();
  const active=pdfSearch.matches[pdfSearch.active];
  for (const match of pdfSearch.byPage.get(slot.number)||[]) {
    for (const part of match.ranges) {
      const node=slot.textDivs[part.item]?.firstChild;
      if (!node || !node.parentElement.isConnected || part.end>node.length) continue;
      const range=document.createRange();range.setStart(node,part.start);range.setEnd(node,part.end);
      for (const rect of range.getClientRects()) {
        if (rect.width<.1 || rect.height<.1) continue;
        const mark=document.createElement('span');mark.className='search-match'+(match===active?' active':'');
        mark.style.cssText=`left:${(rect.left-page.left)/page.width*100}%;top:${(rect.top-page.top)/page.height*100}%;width:${rect.width/page.width*100}%;height:${rect.height/page.height*100}%`;
        fragment.append(mark);
      }
    }
  }
  slot.searchLayer.append(fragment);
}

function drawSearchMatches() {for (const slot of pageSlots) drawPageSearch(slot);}

function cancelPageRenders() {
  readerGeneration++;
  renderQueue = [];
  activeRenders = 0;
  for (const slot of pageSlots) {
    slot.reveal?.cancel();slot.reveal=null;
    slot.job?.renderTask?.cancel();
    slot.job?.textTask?.cancel();
    slot.job?.resolve(false);
    slot.job = null;
  }
}

function stopContinuousReader() {
  cancelReaderNavigation();
  resetPDFSearch();
  clearTimeout(pinchTimer);
  clearTimeout(positionTimer);
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  pageObserver?.disconnect();
  cancelPageRenders();
  pageSlots = [];
  $('pages-container').replaceChildren();
}

function currentScrollAnchor(clientX,clientY) {
  if (!pageSlots.length) return null;
  const mainRect = $('reader-main').getBoundingClientRect();
  const x = clientX ?? mainRect.left + mainRect.width/2;
  const y = clientY ?? mainRect.top + mainRect.height*.35;
  let low = 0, high = pageSlots.length-1;
  while (low < high) {
    const middle = Math.floor((low+high)/2);
    if (pageSlots[middle].element.getBoundingClientRect().bottom < y) low=middle+1;
    else high=middle;
  }
  const slot = pageSlots[low], rect = slot.element.getBoundingClientRect();
  return {page:slot.number,x:(x-rect.left)/rect.width,y:(y-rect.top)/rect.height,clientX:x,clientY:y};
}

function restoreScrollAnchor(anchor) {
  const slot = anchor && pageSlots[anchor.page-1];
  if (!slot) return;
  const main = $('reader-main'), rect = slot.element.getBoundingClientRect();
  main.scrollLeft += rect.left + anchor.x*rect.width - anchor.clientX;
  main.scrollTop += rect.top + anchor.y*rect.height - anchor.clientY;
}

function pageScale() {
  const main = $('reader-main');
  const style = getComputedStyle(main);
  const width = Math.max(150,main.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
  const height = Math.max(220,main.clientHeight-106);
  if (state.zoom==='fit-width') return Math.max(.15,Math.min(3,width/referencePageSize.width));
  if (state.zoom==='fit-page') return Math.max(.15,Math.min(1.35,width/referencePageSize.width,height/referencePageSize.height));
  return Math.max(.25,Math.min(3,Number(state.zoom)||1));
}

function sizePage(slot) {
  slot.element.style.setProperty('--pdf-width',slot.width+'px');
  slot.element.style.setProperty('--pdf-height',slot.height+'px');
}

function layoutPages(scale,anchor=currentScrollAnchor()) {
  restoringLayout=true;
  state.scale=scale;
  $('pages-container').style.setProperty('--page-scale',scale);
  restoreScrollAnchor(anchor);
  restoringLayout=false;
}

function jumpToPage(number,offset=0) {
  const slot=pageSlots[number-1];
  if (!slot) return;
  const main=$('reader-main'),mainRect=main.getBoundingClientRect(),rect=slot.element.getBoundingClientRect();
  const padding=parseFloat(getComputedStyle(main).paddingTop);
  main.scrollTop += rect.top-mainRect.top-padding+offset*rect.height;
}

function setCurrentPage(number,{persist=true}={}) {
  if (!state.pdf || !pageSlots.length) return;
  const page=Math.max(1,Math.min(state.pdf.numPages,number));
  const changed=page!==state.page;
  state.page=page;
  state.book.page=page;
  state.book.progress=state.book.status==='finished'?100:Math.round(page/state.pdf.numPages*100);
  updateReaderControls();
  if (changed) renderChapters();
  if (persist) {
    clearTimeout(positionTimer);
    positionTimer=setTimeout(persistReadingPosition,250);
  }
}

function persistReadingPosition() {
  clearTimeout(positionTimer);
  if (state.view!=='reader' || !state.book || !state.pdf || !pageSlots.length) return;
  const visible=currentScrollAnchor();
  if(visible){state.page=visible.page;state.book.progress=state.book.status==='finished'?100:Math.round(state.page/state.pdf.numPages*100);updateReaderControls();}
  const main=$('reader-main'),slot=pageSlots[state.page-1];
  const mainRect=main.getBoundingClientRect(),rect=slot.element.getBoundingClientRect();
  const padding=parseFloat(getComputedStyle(main).paddingTop);
  state.book.page=state.page;
  state.book.pageOffset=Math.max(-1,Math.min(1,(mainRect.top+padding-rect.top)/rect.height));
  state.book.zoom=state.zoom;
  return saveBook(state.book);
}

function queuePage(slot,priority=false) {
  if (!slot || slot.paintedScale===state.scale) return Promise.resolve(true);
  if (slot.job) {slot.job.priority||=priority;return slot.job.promise;}
  let resolve;
  const promise=new Promise(done=>resolve=done);
  const job={slot,pdf:state.pdf,generation:readerGeneration,scale:state.scale,promise,resolve,priority};
  slot.job=job;
  renderQueue.push(job);
  pumpPages();
  return promise;
}

function pumpPages() {
  renderQueue.sort((a,b)=>Number(b.priority)-Number(a.priority)||Math.abs(a.slot.number-state.page)-Math.abs(b.slot.number-state.page));
  while (activeRenders<2 && renderQueue.length) {
    const job=renderQueue.shift();
    if (job.generation!==readerGeneration) {job.resolve(false);continue;}
    activeRenders++;
    paintPage(job).finally(()=>{
      if (job.slot.job===job) job.slot.job=null;
      job.resolve(job.slot.paintedScale===job.scale);
      if (job.generation===readerGeneration) {activeRenders--;pumpPages();evictDistantPages();}
    });
  }
}

async function paintPage(job) {
  const {slot,pdf,generation,scale}=job;
  const current=()=>generation===readerGeneration && state.pdf===pdf && state.scale===scale;
  try {
    const page=await pdf.getPage(slot.number);
    if (!current()) return;
    const base=page.getViewport({scale:1});
    if (Math.abs(slot.width-base.width)>.1 || Math.abs(slot.height-base.height)>.1) {
      const anchor=currentScrollAnchor();
      slot.width=base.width;slot.height=base.height;
      state.book.pageSizes??={};state.book.pageSizes[slot.number]=[base.width,base.height];
      sizePage(slot);restoreScrollAnchor(anchor);
    }
    const viewport=page.getViewport({scale});
    const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(8000000/(viewport.width*viewport.height)));
    const canvas=document.createElement('canvas');canvas.setAttribute('aria-hidden','true');
    canvas.width=Math.ceil(viewport.width*ratio);
    canvas.height=Math.ceil(viewport.height*ratio);
    if (!slot.paintedScale) slot.loading.hidden=false;
    job.renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:ratio!==1?[ratio,0,0,ratio,0,0]:null});
    await job.renderTask.promise;
    if (!current()) return;
    const textContent=await page.getTextContent();
    if (!current()) return;
    slot.text.replaceChildren();
    job.textTask=new pdfjs.TextLayer({textContentSource:textContent,container:slot.text,viewport});
    await job.textTask.render();
    if (!current()) return;
    const firstPaint=!slot.paintedScale;
    slot.reveal?.cancel();slot.reveal=null;slot.canvas.replaceWith(canvas);slot.canvas=canvas;
    slot.paintedScale=scale;
    slot.textDivs=job.textTask.textDivs;
    slot.loading.hidden=true;
    drawPageHighlights(slot);
    drawPageSearch(slot);
    if (firstPaint && !reducedMotion.matches) slot.reveal=canvas.animate([{opacity:0},{opacity:1}],{duration:160,easing:'ease-out'});
    if (slot.number===state.page) $('page-loading').hidden=true;
  } catch(error) {
    if (!current() || error.name==='RenderingCancelledException' || error.name==='AbortException') return;
    slot.loading.innerHTML='<button class="secondary-button retry-page">Retry page</button>';
    slot.loading.hidden=false;
    slot.loading.querySelector('button').onclick=()=>queuePage(slot);
    if (slot.number===state.page) $('page-loading').hidden=true;
  }
}

function queueNearbyPages() {
  if (!state.pdf || !pageSlots.length) return;
  queuePage(pageSlots[state.page-1]);
  for (const slot of pageSlots) if (slot.near && slot.number!==state.page) queuePage(slot);
  for (const number of [state.page+1,state.page-1]) if (number>0 && number<=pageSlots.length) queuePage(pageSlots[number-1]);
}

function evictDistantPages() {
  const selection=window.getSelection();
  const rendered=pageSlots.filter(slot=>slot.paintedScale).sort((a,b)=>Math.abs(b.number-state.page)-Math.abs(a.number-state.page));
  let remaining=rendered.length;
  for (const slot of rendered) {
    if (remaining<=6) break;
    if (slot.near || slot.job || slot.number===navigationPage || Math.abs(slot.number-state.page)<=1) continue;
    if (selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(slot.text)) continue;
    slot.reveal?.cancel();slot.reveal=null;
    slot.canvas.width=slot.canvas.height=0;
    slot.text.replaceChildren();slot.paintedScale=0;slot.loading.hidden=false;remaining--;
    slot.textDivs=null;slot.searchLayer.replaceChildren();
  }
}

function updateScrolledPage() {
  scrollFrame=0;
  if (state.view!=='reader' || !state.pdf || restoringLayout || !pageSlots.length) return;
  const anchor=currentScrollAnchor();
  setCurrentPage(anchor.page);
  queueNearbyPages();
  evictDistantPages();
}

async function preparePages(number,offset=0) {
  const pdf=state.pdf,generation=readerGeneration;
  const first=await pdf.getPage(1);
  if (generation!==readerGeneration || state.pdf!==pdf) return;
  const base=first.getViewport({scale:1});
  referencePageSize={width:base.width,height:base.height};
  const fragment=document.createDocumentFragment();
  pageSlots=Array.from({length:pdf.numPages},(_,index)=>{
    const number=index+1,cached=state.book.pageSizes?.[number];
    const element=document.createElement('section');
    element.className='pdf-page';element.dataset.page=number;
    element.setAttribute('aria-label',`Page ${number} of ${pdf.numPages}`);
    element.innerHTML=`<div class="page-wrap"><canvas aria-hidden="true"></canvas><div class="highlight-layer" aria-hidden="true"></div><div class="textLayer" role="document" aria-label="Page ${number} of ${pdf.numPages}: ${esc(state.book.title)}"></div><div class="search-layer" aria-hidden="true"></div><div class="page-loading"><span class="spinner" aria-hidden="true"></span><span>Loading page ${number}…</span></div></div>`;
    const slot={number,element,width:cached?.[0]||base.width,height:cached?.[1]||base.height,canvas:element.querySelector('canvas'),text:element.querySelector('.textLayer'),highlights:element.querySelector('.highlight-layer'),searchLayer:element.querySelector('.search-layer'),textDivs:null,loading:element.querySelector('.page-loading'),paintedScale:0,near:false,job:null};
    slot.canvas.width=slot.canvas.height=0;sizePage(slot);fragment.append(element);return slot;
  });
  $('pages-container').replaceChildren(fragment);
  layoutPages(pageScale(),null);
  jumpToPage(number,offset);
  setCurrentPage(number,{persist:false});
  pageObserver=new IntersectionObserver(entries=>{
    for (const entry of entries) {
      const slot=pageSlots[Number(entry.target.dataset.page)-1];
      if (slot?.element===entry.target) slot.near=entry.isIntersecting;
    }
    if (state.view==='reader') queueNearbyPages();
  },{root:$('reader-main'),rootMargin:'100% 0px',threshold:0});
  for (const slot of pageSlots) pageObserver.observe(slot.element);
  await queuePage(pageSlots[number-1]);
  if (generation!==readerGeneration) return;
  $('page-loading').hidden=true;
  queueNearbyPages();persistReadingPosition();
}

async function openBook(id) {
  const book=state.books.find(b=>b.id===id);if (!book) return;
  if (state.view==='reader') persistReadingPosition();
  const op=++openingId;closeContext();stopContinuousReader();
  state.book=book;state.view='reader';state.focus=false;state.panel=null;state.selection=null;
  document.querySelector('.skip-link').href='#reader-main';
  $('selection-toolbar').hidden=true;$('library-view').hidden=true;$('reader-view').hidden=false;
  $('reader-view').classList.remove('focus-mode');$('exit-focus').hidden=true;$('focus-toggle').setAttribute('aria-pressed','false');
  setPanel(null,{rerender:false});$('page-loading').hidden=false;
  $('reader-title').textContent=book.title;$('reader-title').title=book.title;$('reader-author').textContent=book.author||book.filename;
  document.title=`${book.title} — Folio`;
  try {
    const data=await getBookData(book);if (op!==openingId) return;
    await state.pdf?.loadingTask?.destroy();state.pdf=null;
    $('page-loading').querySelector('span:last-child').textContent='Checking PDF…';
    const pdf=await loadPdf(data,{book,filename:book.filename||book.title,intent:'open'});
    $('page-loading').querySelector('span:last-child').textContent='Opening PDF…';
    if (op!==openingId) {await pdf.loadingTask.destroy();return;}
    state.pdf=pdf;book.attachmentConsent=pdfAttachmentApprovals.get(pdf);book.pageCount=pdf.numPages;book.fingerprint=pdf.fingerprints[0];
    if(!book.sample&&book.coverVersion!==1){
      const cover=await createBookCover(pdf);
      if(cover){book.cover=cover;book.coverVersion=1;}
    }
    if(op!==openingId)return;
    state.zoom=book.zoom||'fit-page';syncZoomSelect();state.page=Math.min(book.page||1,pdf.numPages);
    book.lastOpened=Date.now();if (book.status!=='finished') book.status='reading';
    state.outline=[];renderChapters();renderSaved();
    await preparePages(state.page,book.pageOffset||0);
    if (op!==openingId) return;
    $('reader-main').focus({preventScroll:true});loadOutline(pdf,op);location.hash='read';
  } catch(error) {
    if (op!==openingId) return;
    backToLibrary();if(error?.name!=='AbortException')toast(error.message||'Unable to open this PDF. Add it again and try once more.',true);
  }
}

function backToLibrary() {
  persistReadingPosition();++openingId;stopContinuousReader();
  state.view='library';state.selection=null;document.querySelector('.skip-link').href='#main';
  $('selection-toolbar').hidden=true;$('reader-view').hidden=true;$('library-view').hidden=false;
  state.focus=false;$('reader-view').classList.remove('focus-mode');document.title='Folio';
  renderLibrary();location.hash='library';$('main').focus({preventScroll:true});
}

async function renderPage(number,{preserveScroll=false,searchMatch=null}={}) {
  clearTimeout(pinchTimer);
  if (!state.pdf || !pageSlots.length) return;
  cancelReaderNavigation();
  const navigation=readerNavigation,pdf=state.pdf;
  const current=()=>navigation===readerNavigation && state.pdf===pdf && state.view==='reader';
  const target=Math.max(1,Math.min(state.pdf.numPages,Number(number)||1));
  const anchor=currentScrollAnchor(),scale=pageScale();
  state.selection=null;$('selection-toolbar').hidden=true;window.getSelection()?.removeAllRanges();
  if (Math.abs(scale-state.scale)>.0001) {cancelPageRenders();layoutPages(scale,anchor);}
  if (!preserveScroll) {
    const slot=pageSlots[target-1];navigationPage=target;
    await queuePage(slot,true);
    if (!current()) return;
    const main=$('reader-main'),bounds=main.getBoundingClientRect(),rect=slot.element.getBoundingClientRect();
    let top=main.scrollTop+rect.top-bounds.top-parseFloat(getComputedStyle(main).paddingTop),left=main.scrollLeft;
    if (searchMatch) {
      drawPageSearch(slot);
      const found=slot.searchLayer.querySelector('.search-match.active');
      if (found) {
        const result=found.getBoundingClientRect();
        top=main.scrollTop+result.top-bounds.top-main.clientHeight*.4;
        if (result.left<bounds.left+24 || result.right>bounds.right-24) left+=result.left-bounds.left-main.clientWidth*.4;
      }
    }
    if (!await moveReaderTo(top,left) || !current()) return;
    setCurrentPage(target);navigationPage=null;
  } else {
    updateScrolledPage();await queuePage(pageSlots[state.page-1]);
    if (!current()) return;
  }
  queueNearbyPages();updateReaderControls();persistReadingPosition();
}

function updateReaderControls() {
  if (!state.book || !state.pdf) return;
  const book=state.book;
  const pageInput=$('current-page');
  if (document.activeElement!==pageInput) pageInput.value=state.page;
  pageInput.style.width=`calc(${Math.max(2,String(state.pdf.numPages).length)}ch + 8px)`;
  $('total-pages').textContent=state.pdf.numPages;
  $('page-counter').setAttribute('aria-label',`Page navigation, ${state.pdf.numPages} pages`);
  $('zoom-out').disabled=state.scale<=.25;$('zoom-in').disabled=state.scale>=3;
  $('reading-progress-line').style.width=book.progress+'%';
  const bookmarked=book.marks?.some(mark=>mark.kind==='bookmark' && mark.page===state.page)||false;
  $('bookmark-page').setAttribute('aria-pressed',String(bookmarked));
  $('bookmark-page').setAttribute('aria-label',bookmarked?'Remove page bookmark':'Bookmark this page');
  const count=book.marks?.length||0;$('saved-badge').hidden=!count;$('saved-badge').textContent=count;
}

async function loadOutline(pdf,op){try{const outline=await pdf.getOutline();const list=[];async function visit(items,depth){for(const item of items||[]){let dest=item.dest;if(typeof dest==='string')dest=await pdf.getDestination(dest);let page=null;if(Array.isArray(dest)){if(typeof dest[0]==='number')page=dest[0]+1;else if(dest[0])page=await pdf.getPageIndex(dest[0])+1;}list.push({title:item.title||'Untitled chapter',page,depth});await visit(item.items,depth+1);}}await visit(outline,0);if(op!==openingId)return;state.outline=list;renderChapters();}catch{if(op===openingId){state.outline=[];renderChapters();}}}
function renderChapters(){let active=-1;state.outline.forEach((c,i)=>{if(c.page&&c.page<=state.page)active=i;});$('chapters-list').innerHTML=state.outline.length?state.outline.map((c,i)=>`<button class="chapter-item ${active===i?'active':''}" data-page="${c.page||''}" style="padding-inline-start:${12+Math.min(c.depth,5)*12}px" ${c.page?'':'disabled'} ${active===i?'aria-current="location"':''}><span>${esc(c.title)}</span><span>${c.page||''}</span></button>`).join(''):`<div class="panel-empty">${icon('chapters')}<h3>No chapters in this PDF</h3></div>`;$('chapters-list').querySelectorAll('[data-page]').forEach(btn=>btn.onclick=()=>{if(innerWidth<=750)setPanel(null,{rerender:false});renderPage(Number(btn.dataset.page));});}
function setPanel(panel,{rerender=true}={}){state.panel=panel;$('reader-view').classList.toggle('panel-open',!!panel);$('reader-view').classList.toggle('panel-saved',panel==='saved');$('reader-view').classList.toggle('panel-chapters',panel==='chapters');$('chapters-panel').hidden=panel!=='chapters';$('saved-panel').hidden=panel!=='saved';$('chapters-toggle').setAttribute('aria-expanded',String(panel==='chapters'));$('saved-toggle').setAttribute('aria-expanded',String(panel==='saved'));if(panel==='saved')renderSaved();if(rerender&&state.view==='reader'&&state.pdf&&(state.zoom==='fit-page'||state.zoom==='fit-width'))scheduleReaderLayout();}
function toggleFocus(value=!state.focus){state.focus=value;state.selection=null;$('selection-toolbar').hidden=true;$('reader-view').classList.toggle('focus-mode',value);$('focus-toggle').setAttribute('aria-pressed',String(value));$('exit-focus').hidden=!value;if(value)setPanel(null,{rerender:false});if(state.pdf)scheduleReaderLayout();}
function syncZoomSelect(){const select=$('zoom-select');if(!Array.from(select.options).some(o=>o.value===state.zoom)){const option=new Option(Math.round(Number(state.zoom)*100)+'%',state.zoom);option.dataset.pinch='true';select.add(option);}select.value=state.zoom;}
function changeZoom(direction){const steps=[.25,.5,.75,1,1.25,1.5,2,2.5,3];const next=direction>0?steps.find(n=>n>state.scale+.02):steps.slice().reverse().find(n=>n<state.scale-.02);if(next){state.zoom=String(next);if(!Array.from($('zoom-select').options).some(o=>o.value===state.zoom)){$('zoom-select').add(new Option(Math.round(next*100)+'%',state.zoom));}$('zoom-select').value=state.zoom;renderPage(state.page,{preserveScroll:true});}}
function pinchZoom(nextScale,clientX,clientY){
  if(!state.pdf||state.view!=='reader'||!pageSlots.length||!$('page-loading').hidden)return;
  cancelReaderNavigation();
  const scale=Math.round(Math.max(.25,Math.min(3,nextScale))*1000)/1000;
  const anchor=currentScrollAnchor(clientX,clientY);
  state.zoom=String(scale);layoutPages(scale,anchor);syncZoomSelect();
  $('selection-toolbar').hidden=true;state.selection=null;
  clearTimeout(pinchTimer);pinchTimer=setTimeout(()=>{if(state.view==='reader'){cancelPageRenders();renderPage(state.page,{preserveScroll:true});}},140);
}
$('reader-main').addEventListener('pointerdown',cancelReaderNavigation,{passive:true});
$('reader-main').addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End',' '].includes(event.key))cancelReaderNavigation();});
$('reader-main').addEventListener('wheel',event=>{
  cancelReaderNavigation();
  if(!(event.ctrlKey||event.metaKey)||!state.pdf)return;
  event.preventDefault();
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?innerHeight:1);
  pinchZoom(state.scale*Math.exp(-delta*.008),event.clientX,event.clientY);
},{passive:false});
$('reader-main').addEventListener('gesturestart',event=>{if(!state.pdf)return;event.preventDefault();gestureStartScale=state.scale;},{passive:false});
$('reader-main').addEventListener('gesturechange',event=>{if(!state.pdf)return;event.preventDefault();const r=$('reader-main').getBoundingClientRect();pinchZoom(gestureStartScale*event.scale,event.clientX||r.left+r.width/2,event.clientY||r.top+r.height/2);},{passive:false});
$('reader-main').addEventListener('gestureend',event=>{event.preventDefault();clearTimeout(pinchTimer);if(state.pdf&&state.view==='reader'){cancelPageRenders();renderPage(state.page,{preserveScroll:true});}},{passive:false});
async function toggleBookmark(){if(!state.book||!state.pdf)return;updateScrolledPage();state.book.marks??=[];const old=state.book.marks.find(m=>m.kind==='bookmark'&&m.page===state.page);if(old)state.book.marks=state.book.marks.filter(m=>m.id!==old.id);else state.book.marks.push({id:uid(),kind:'bookmark',page:state.page,note:'',createdAt:Date.now()});const saved=await saveBook(state.book);updateReaderControls();renderSaved();if(saved)toast(old?'Page bookmark removed.':'Page bookmarked.');}
function captureSelection() {
  if (state.view!=='reader' || !state.pdf) return;
  const selection=window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    if (!document.activeElement?.closest('#selection-toolbar')) {$('selection-toolbar').hidden=true;state.selection=null;}
    return;
  }
  const range=selection.getRangeAt(0);
  const layerFor=node=>(node.nodeType===Node.ELEMENT_NODE?node:node.parentElement)?.closest('.textLayer');
  const first=layerFor(range.startContainer)?.closest('.pdf-page');
  const last=layerFor(range.endContainer)?.closest('.pdf-page');
  if (!first || !last) return;
  const segments=[];
  for (let number=Number(first.dataset.page);number<=Number(last.dataset.page);number++) {
    const slot=pageSlots[number-1];if (!slot?.text.childNodes.length) continue;
    const part=document.createRange();part.selectNodeContents(slot.text);
    if (slot.element===first) part.setStart(range.startContainer,range.startOffset);
    if (slot.element===last) part.setEnd(range.endContainer,range.endOffset);
    const fragment=part.cloneContents();
    for(const lineBreak of fragment.querySelectorAll('br'))lineBreak.replaceWith(' ');
    const text=fragment.textContent.replace(/\s+/g,' ').trim();if (!text) continue;
    const page=slot.element.getBoundingClientRect(),rects=[];
    for (const rect of Array.from(part.getClientRects()).filter(r=>r.width>1 && r.height>3)) {
      const x=Math.max(0,(rect.left-page.left)/page.width),y=Math.max(0,(rect.top-page.top)/page.height);
      const normalized={x,y,width:Math.min(1-x,rect.width/page.width),height:Math.min(1-y,rect.height/page.height)};
      if (!rects.some(old=>Math.abs(old.x-x)<.001 && Math.abs(old.y-y)<.001 && Math.abs(old.width-normalized.width)<.001)) rects.push(normalized);
    }
    if (rects.length) segments.push({page:number,text,rects});
  }
  if (!segments.length) return;
  state.selection={segments};
  const rect=range.getBoundingClientRect(),toolbar=$('selection-toolbar');toolbar.hidden=false;
  toolbar.style.left=Math.max(8,Math.min(rect.left+rect.width/2-toolbar.offsetWidth/2,innerWidth-toolbar.offsetWidth-8))+'px';
  toolbar.style.top=Math.max(8,rect.top-toolbar.offsetHeight-11)+'px';
}

async function saveSelection() {
  if (!state.selection || !state.book) return;
  const segments=state.selection.segments;state.book.marks??=[];
  let added=0;
  for (const chosen of segments) {
    if (state.book.marks.some(mark=>mark.kind==='passage' && mark.page===chosen.page && mark.text===chosen.text)) continue;
    state.book.marks.push({id:uid(),kind:'passage',text:chosen.text,page:chosen.page,rects:chosen.rects,color:state.color,note:'',createdAt:Date.now()});
    added++;
  }
  state.selection=null;window.getSelection()?.removeAllRanges();$('selection-toolbar').hidden=true;
  if (!added) {toast('This passage is already saved.');return;}
  const saved=await saveBook(state.book);drawHighlights();renderSaved();updateReaderControls();
  if (saved) toast('Passage saved.');
}

function drawPageHighlights(slot) {
  slot.highlights.innerHTML=(state.book?.marks||[]).filter(mark=>mark.kind==='passage' && mark.page===slot.number).flatMap(mark=>mark.rects.map(rect=>`<span class="highlight-rect ${esc(mark.color)}" style="left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.width*100}%;height:${rect.height*100}%"></span>`)).join('');
}

function drawHighlights() {for (const slot of pageSlots) drawPageHighlights(slot);}

function renderSaved(){if(!state.book)return;const marks=(state.book.marks||[]).slice().sort((a,b)=>a.page-b.page||a.createdAt-b.createdAt);$('saved-list').innerHTML=marks.length?marks.map(m=>`<article class="saved-card" data-color="${esc(m.color||'yellow')}"><div class="saved-meta"><button class="saved-page-link" data-jump="${m.page}">${icon(m.kind==='bookmark'?'bookmark':'highlight')}${m.kind==='bookmark'?'Bookmark':'Passage'} · Page ${m.page}</button><button class="icon-button small" data-delete="${esc(m.id)}" aria-label="Remove ${m.kind==='bookmark'?'bookmark':'passage'} on page ${m.page}">${icon('trash')}</button></div>${m.kind==='passage'?`<blockquote>${esc(m.text)}</blockquote>`:''}<label class="note-label" for="note-${esc(m.id)}">Note</label><textarea id="note-${esc(m.id)}" data-note="${esc(m.id)}" placeholder="Add a note" rows="2">${esc(m.note||'')}</textarea></article>`).join(''):`<div class="panel-empty">${icon('highlight')}<h3>No saved passages</h3><button class="secondary-button" id="empty-bookmark" style="margin-top:20px;font-size:11px">${icon('bookmark')}Bookmark this page</button></div>`;$('empty-bookmark')?.addEventListener('click',toggleBookmark);$('saved-list').querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>{if(innerWidth<=750)setPanel(null,{rerender:false});renderPage(Number(b.dataset.jump));});$('saved-list').querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{state.book.marks=state.book.marks.filter(m=>m.id!==b.dataset.delete);await saveBook(state.book);renderSaved();drawHighlights();updateReaderControls();});$('saved-list').querySelectorAll('[data-note]').forEach(input=>input.oninput=()=>{const mark=state.book.marks.find(m=>m.id===input.dataset.note);if(mark){mark.note=input.value;saveBook(state.book);}});$('export-book').disabled=!marks.length;}
async function exportPassages(books,format='md'){const chosen=books.filter(b=>b.marks?.length);if(!chosen.length){toast('Save a passage or bookmark a page before exporting.');return;}let content,mime;if(format==='json'){content=JSON.stringify({format:'folio-passages',version:1,exportedAt:new Date().toISOString(),books:chosen.map(b=>({title:b.title,author:b.author,filename:b.filename,fingerprint:b.fingerprint,passages:b.marks.slice().sort((a,b)=>a.page-b.page)}))},null,2);mime='application/json';}else{content=chosen.map(b=>{const heading=format==='md'?`# ${b.title}\n\n`:`${b.title}\n${'='.repeat(Math.min(b.title.length,60))}\n\n`;return heading+`${b.author?b.author+'\n':''}Source: ${b.filename}\n\n`+b.marks.slice().sort((a,b)=>a.page-b.page||a.createdAt-b.createdAt).map(m=>(format==='md'?`## ${m.kind==='bookmark'?'Bookmark':'Passage'} · Page ${m.page}\n\n`:`${m.kind==='bookmark'?'Bookmark':'Passage'} — Page ${m.page}\n\n`)+(m.text?(format==='md'?'> '+m.text.replace(/\n/g,'\n> '):m.text)+'\n\n':'')+(m.note?`Note: ${m.note}\n\n`:'')).join('');}).join('\n---\n\n');mime='text/plain;charset=utf-8';}const filename=(chosen.length===1?chosen[0].title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'book':'folio-library')+'-passages.'+format;if(desktop){try{if(await desktop.saveText({filename,content}))toast('Saved passages exported.');}catch(error){toast(error.message,true);}return;}downloadFile(new Blob([content],{type:mime}),filename);toast('Saved passages exported.');}

async function finishStartup(){
  const splash=$('startup-screen');
  await Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,400))]);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,3000-(performance.now()-startupStarted))));
  if(!reducedMotion.matches){
    const fade=splash.animate([{opacity:1},{opacity:0}],{duration:350,easing:'ease-out',fill:'forwards'});
    await fade.finished.catch(()=>{});
  }
  splash.remove();
}

function downloadFile(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function choosePDFs(){if(desktop)return chooseNativePDFs({open:true});$('file-input').click();}
let nativeImports=Promise.resolve();
function chooseNativePDFs(options={}){
  nativeImports=nativeImports.catch(()=>{}).then(async()=>{
    const selected=options.files||await desktop.pickPDFs();if(!selected.length)return;
    if(state.view==='reader')backToLibrary();
    const total={ids:[],added:0,existing:0,canceled:0,failed:0};
    try{
      // Read and import one file at a time so a large selection stays bounded.
      for(const item of selected){
        try{
          if(item.error)throw new Error(item.error);
          const bytes=await desktop.readSelectedPDF(item.token);
          const file=new File([bytes],item.name,{type:'application/pdf',lastModified:item.lastModified});
          const result=await importFiles([file],options.linked?[{nativeToken:item.token}]:[],{quiet:true});
          total.ids.push(...result.ids);
          for(const key of ['added','existing','canceled','failed'])total[key]+=result[key];
        }catch(error){total.failed++;toast(`${item.name}: ${error.message||'Unable to open this PDF.'}`,true);}
        finally{if(item.token)await desktop.releaseSelectedPDFs([item.token]);}
      }
      showImportResult(total);
      // A multi-file import ends in the library so every added book is visible.
      if(selected.length===1&&options.open&&total.ids.length)await openBook(total.ids[0]);
    }catch(error){toast(error.message||'Unable to add these PDFs.',true);}
  });
  return nativeImports;
}
async function backupLibrary(){
  try{
    await persistReadingPosition();await Promise.all([...nativeWrites]);
    if(desktop){if(await desktop.backupLibrary())toast('Library backup saved.');return;}
    toast('Preparing library backup…',true);
    const books=structuredClone(state.books),shelves=structuredClone(state.shelves),files=[];
    for(const book of books)if(!book.sample)files.push({id:book.id,bytes:await getBookData(book)});
    const bytes=await encodeArchive({books,shelves,files});
    downloadFile(new Blob([bytes],{type:'application/gzip'}),'Folio library.folio');toast('Library backup saved.');
  }catch(error){toast(error.message||'Unable to back up the library. Check access to linked PDFs.',true);}
}
async function runDesktopCommand(command){
  try{
    if(command==='open')return chooseNativePDFs({open:true});
    if(command==='link')return chooseNativePDFs({linked:true});
    if(command==='library')return backToLibrary();
    if(command==='find'){if(state.view==='reader'&&state.pdf)setPDFSearch(true);else $('book-search').focus();}
    if(command==='focus'&&state.view==='reader')toggleFocus();
    if(command==='shortcuts')$('help-button').click();
    if(command==='safety')return showDialog({title:'PDF safety',icon:'book',onlyClose:true,body:'<p>Folio checks PDFs locally before reading and blocks detected scripts, active forms, and interactive media.</p><p>You can add a PDF with embedded files after confirming. Its attachments stay disabled. PDF actions and external network requests are disabled.</p><p>These checks reduce risk; they are not an antivirus guarantee.</p>'});
    if(command==='export')return exportPassages(state.view==='reader'?[state.book]:state.books,'md');
    if(command==='backup')return backupLibrary();
    if(command==='restore'){
      await persistReadingPosition();await Promise.all([...nativeWrites]);
      const selected=await desktop.restoreLibrary();if(!selected)return;
      toast('Checking library PDFs…',true);const archive=await decodeArchive(selected.bytes);
      for(const file of archive.files){const book=archive.books.find(item=>item.id===file.id);const pdf=await loadPdf(fromBase64(file.data),{filename:book?.filename||book?.title,intent:'add'});book.attachmentConsent=pdfAttachmentApprovals.get(pdf);await pdf.loadingTask.destroy();}
      const restored=await desktop.importLibrary(new TextEncoder().encode(JSON.stringify(archive)));
      backToLibrary();state.books=await readAll('books');state.shelves=await readAll('shelves');renderLibrary();toast(`${restored.books} ${restored.books===1?'book':'books'} restored.`);
    }
  }catch(error){toast(error.message||'Unable to complete this action.',true);}
}
window.folioPrepareClose=async()=>{await persistReadingPosition();await Promise.all([...nativeWrites]);};
$('backup-library').onclick=backupLibrary;$('backup-library').hidden=!!desktop;

$('add-pdfs').onclick=choosePDFs;$('file-input').onchange=e=>importFiles(e.target.files);
$('add-options-toggle').onclick=e=>{e.stopPropagation();const show=$('add-menu').hidden;$('add-menu').hidden=!show;$('add-options-toggle').setAttribute('aria-expanded',String(show));};$('link-file').onclick=linkFiles;
$('book-search').oninput=e=>{state.search=e.target.value;renderLibrary();};$('book-sort').onchange=e=>{state.sort=e.target.value;renderLibrary();};
$('new-shelf').onclick=$('new-shelf-icon').onclick=createShelf;$('export-library').onclick=()=>exportPassages(state.books,'md');
$('mobile-menu').onclick=()=>{const value=$('library-sidebar').classList.toggle('open');$('mobile-menu').setAttribute('aria-expanded',String(value));syncLibraryNav();};
$('back-library').onclick=backToLibrary;document.querySelector('.reader-brand').onclick=e=>{e.preventDefault();backToLibrary();};
$('chapters-toggle').onclick=()=>setPanel(state.panel==='chapters'?null:'chapters');$('saved-toggle').onclick=()=>setPanel(state.panel==='saved'?null:'saved');
$('close-chapters').onclick=()=>{setPanel(null);$('chapters-toggle').focus();};$('close-saved').onclick=()=>{setPanel(null);$('saved-toggle').focus();};
$('search-toggle').onclick=()=>setPDFSearch(!pdfSearch.open);
$('search-close').onclick=()=>setPDFSearch(false);
$('pdf-query').oninput=schedulePDFSearch;
$('pdf-search').onsubmit=e=>{e.preventDefault();if(pdfSearch.busy)searchPDF();else moveSearchMatch(1);};
$('pdf-query').onkeydown=e=>{if(e.key==='Enter' && e.shiftKey){e.preventDefault();if(pdfSearch.busy)searchPDF();else moveSearchMatch(-1);}};
$('search-previous').onclick=()=>moveSearchMatch(-1);$('search-next').onclick=()=>moveSearchMatch(1);
$('zoom-select').onchange=e=>{state.zoom=e.target.value;renderPage(state.page,{preserveScroll:true});};$('zoom-in').onclick=()=>changeZoom(1);$('zoom-out').onclick=()=>changeZoom(-1);
$('current-page').onfocus=e=>e.target.select();
$('current-page').onblur=e=>{e.target.value=state.page;};
$('current-page').onkeydown=e=>{
  if (e.key==='Escape') {
    e.preventDefault();e.stopPropagation();
    $('reader-main').focus({preventScroll:true});
  } else if (e.key==='Enter' && state.pdf) {
    e.preventDefault();
    const value=e.target.value.trim();
    if (!/^\d+$/.test(value)) {
      toast(`Enter a page number from 1 to ${state.pdf.numPages}.`);
      e.target.select();return;
    }
    const page=Math.max(1,Math.min(state.pdf.numPages,Number(value)));
    $('reader-main').focus({preventScroll:true});
    renderPage(page);
  }
};
$('bookmark-page').onclick=toggleBookmark;$('focus-toggle').onclick=()=>toggleFocus();$('exit-focus').onclick=()=>toggleFocus(false);
$('theme-toggle').onclick=()=>{const dark=$('reader-view').classList.toggle('dark-reader');$('theme-toggle').innerHTML=icon(dark?'sun':'moon');$('theme-toggle').setAttribute('aria-label',dark?'Use light reading background':'Use dark reading background');};
$('save-selection').onclick=saveSelection;$('selection-toolbar').onpointerdown=e=>e.preventDefault();
document.querySelectorAll('.color-choice').forEach(b=>b.onclick=()=>{state.color=b.dataset.color;document.querySelectorAll('.color-choice').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});});
$('export-book').onclick=()=>exportPassages([state.book],$('export-format').value);
let selectionTimer;document.addEventListener('selectionchange',()=>{clearTimeout(selectionTimer);selectionTimer=setTimeout(captureSelection,180);});$('reader-main').addEventListener('pointerup',event=>{if(event.target.closest('.textLayer'))setTimeout(captureSelection,0);});
$('reader-main').addEventListener('scroll',()=>{$('selection-toolbar').hidden=true;if(!scrollFrame)scrollFrame=requestAnimationFrame(updateScrolledPage);},{passive:true});
window.addEventListener('pagehide',persistReadingPosition);
document.addEventListener('click',e=>{if(!e.target.closest('.book-context,.book-menu-button'))closeContext();if(!e.target.closest('.add-actions')){$('add-menu').hidden=true;$('add-options-toggle').setAttribute('aria-expanded','false');}if(innerWidth<=750&&!e.target.closest('.library-sidebar,#mobile-menu')){$('library-sidebar').classList.remove('open');$('mobile-menu').setAttribute('aria-expanded','false');syncLibraryNav();}});
$('help-button').onclick=()=>showDialog({title:'Keyboard shortcuts',icon:'book',onlyClose:true,body:'<p>Available while you read.</p><div class="shortcuts"><span>Find in PDF</span><kbd>⌘ / Ctrl F</kbd><span>Next / previous match</span><kbd>Enter / ⇧ Enter</kbd><span>Scroll pages</span><kbd>↑ / ↓</kbd><span>Focus mode</span><kbd>F</kbd><span>Show chapters</span><kbd>C</kbd><span>Show saved passages</span><kbd>S</kbd><span>Bookmark page</span><kbd>B</kbd><span>Save selected passage</span><kbd>H</kbd><span>Zoom in / out</span><kbd>+ / −</kbd><span>Close panel / exit focus</span><kbd>Esc</kbd></div>'});
document.addEventListener('keydown',e=>{if($('app-dialog').open)return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='f'&&state.view==='reader'&&state.pdf){e.preventDefault();setPDFSearch(true);return;}if(e.key==='Escape'&&pdfSearch.open){e.preventDefault();setPDFSearch(false);return;}if(e.key==='Escape'){closeContext();$('add-menu').hidden=true;$('selection-toolbar').hidden=true;$('library-sidebar').classList.remove('open');$('mobile-menu').setAttribute('aria-expanded','false');syncLibraryNav();if(state.focus)toggleFocus(false);else if(state.panel)setPanel(null);return;}if(e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,textarea,select,[contenteditable=true]'))return;if(state.view!=='reader'||!state.pdf)return;const key=e.key.toLowerCase();if(['f','c','s','b','h','+','=','-'].includes(key))e.preventDefault();if(key==='f')toggleFocus();if(key==='c')setPanel(state.panel==='chapters'?null:'chapters');if(key==='s')setPanel(state.panel==='saved'?null:'saved');if(key==='b')toggleBookmark();if(key==='h')saveSelection();if(key==='+'||key==='=')changeZoom(1);if(key==='-')changeZoom(-1);});
let dragDepth=0;document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});document.addEventListener('dragleave',e=>{if(e.dataTransfer.types.includes('Files')){dragDepth--;if(dragDepth<=0){dragDepth=0;$('drop-overlay').hidden=true;}}});document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});document.addEventListener('drop',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;if(state.view==='reader')backToLibrary();importFiles(e.dataTransfer.files);}});
let resizeTimer;window.addEventListener('resize',()=>{syncLibraryNav();cancelReaderNavigation();const navigation=readerNavigation;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(navigation===readerNavigation&&state.view==='reader'&&state.pdf&&(state.zoom==='fit-page'||state.zoom==='fit-width'))renderPage(state.page,{preserveScroll:true});},200);});
window.addEventListener('hashchange',()=>{if(location.hash==='#library'&&state.view==='reader')backToLibrary();});
document.querySelectorAll('[data-tip]').forEach(b=>b.title=b.dataset.tip);
await initStorage();renderLibrary();
await finishStartup();
if(desktop){desktop.onOpenFiles(files=>chooseNativePDFs({files,open:true}));desktop.onCommand(runDesktopCommand);desktop.onFullscreen(value=>document.documentElement.classList.toggle('is-fullscreen',value));const launch=await desktop.ready();document.documentElement.classList.toggle('is-fullscreen',launch.fullscreen);if(launch.files.length)await chooseNativePDFs({files:launch.files,open:true});for(const command of launch.commands)await runDesktopCommand(command);}
