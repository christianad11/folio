const {app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {FolioStore} = require('./store.cjs');
const {resolveAsset, trustedSender} = require('./security.cjs');

app.setName('Folio');
app.setPath('userData', !app.isPackaged && process.env.FOLIO_TEST_DATA_DIR || path.join(app.getPath('appData'), 'Folio'));
protocol.registerSchemesAsPrivileged([{scheme: 'folio', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}}]);

let window, store, rendererReady = false, pendingFiles = [], pendingCommands = [], closeReady = false, quitting = false;
const selections = new Map();
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'";

function grantPDF(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || !/\.pdf$/i.test(filename) || stat.size > 256 * 1024 * 1024) throw new Error('Choose a PDF smaller than 256 MB.');
  const token = crypto.randomUUID();
  selections.set(token, fs.realpathSync(filename));
  return {token, name: path.basename(filename), lastModified: stat.mtimeMs};
}

function showWindow() {
  if (quitting) return;
  if (!window || window.isDestroyed()) createWindow();
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}

function sendCommand(command) {
  showWindow();
  if (rendererReady) window.webContents.send('folio:command', command);
  else pendingCommands.push(command);
}

function queueFiles(filenames) {
  const files = [];
  for (const filename of filenames) {
    try { files.push(grantPDF(filename)); }
    catch (error) { dialog.showErrorBox('Unable to open PDF', error.message); }
  }
  if (!files.length) return;
  if (app.isReady()) showWindow();
  if (rendererReady) window.webContents.send('folio:open-files', files);
  else pendingFiles.push(...files);
}

function installIPC() {
  function handle(channel, action) {
    ipcMain.handle('folio:' + channel, async (event, ...args) => {
      if (!trustedSender(event, window)) throw new Error('This request did not come from Folio.');
      return action(...args);
    });
  }
  handle('read-all', name => store.readAll(name));
  handle('read-one', (name, id) => store.readOne(name, id));
  handle('write-one', (name, value) => store.writeOne(name, value));
  handle('write-library', changes => store.writeLibrary(changes));
  handle('remove-one', (name, id) => store.removeOne(name, id));
  handle('read-pdf', id => store.readPDF(id));
  handle('pdf-digest', bytes => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 256 * 1024 * 1024) throw new Error('Choose a PDF smaller than 256 MB.');
    return crypto.createHash('sha256').update(bytes).digest('hex');
  });
  handle('write-file', value => {
    if (value?.token) {
      const filename = selections.get(value.token);
      if (!filename) throw new Error('Choose the linked PDF again.');
      store.writeFile(value.id, {linkedPath: filename});
    } else store.writeFile(value?.id, {bytes: value?.bytes});
  });
  handle('pick-pdfs', async () => {
    const result = await dialog.showOpenDialog(window, {title: 'Add PDFs', filters: [{name: 'PDF documents', extensions: ['pdf']}], properties: ['openFile', 'multiSelections']});
    return result.canceled ? [] : result.filePaths.map(filename => {
      try { return grantPDF(filename); }
      catch (error) { return {name: path.basename(filename), error: error.message}; }
    });
  });
  handle('read-selected-pdf', token => {
    const filename = selections.get(token);
    if (!filename) throw new Error('Choose this PDF again.');
    if (fs.statSync(filename).size > 256 * 1024 * 1024) throw new Error('Choose a PDF smaller than 256 MB.');
    return new Uint8Array(fs.readFileSync(filename));
  });
  handle('release-selected-pdfs', tokens => { if (Array.isArray(tokens)) for (const token of tokens) selections.delete(token); });
  handle('save-text', async value => {
    if (typeof value?.content !== 'string' || value.content.length > 128 * 1024 * 1024 || typeof value.filename !== 'string') throw new Error('Unable to export these passages.');
    const filename = path.basename(value.filename), extension = path.extname(filename).slice(1);
    if (!['md', 'txt', 'json'].includes(extension)) throw new Error('Choose Markdown, text, or JSON.');
    const result = await dialog.showSaveDialog(window, {title: 'Export saved passages', defaultPath: filename, filters: [{name: 'Saved passages', extensions: [extension]}]});
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, value.content, {mode: 0o600}); return true;
  });
  handle('backup-library', async () => {
    const result = await dialog.showSaveDialog(window, {title: 'Back up library', defaultPath: 'Folio library.folio', filters: [{name: 'Folio library', extensions: ['folio']}]});
    if (result.canceled || !result.filePath) return false;
    const {encodeArchive} = await import('../dist/library-backup.mjs');
    const bytes = await encodeArchive(store.snapshot());
    fs.writeFileSync(result.filePath, bytes, {mode: 0o600}); return true;
  });
  handle('restore-library', async () => {
    const result = await dialog.showOpenDialog(window, {title: 'Restore library', filters: [{name: 'Folio library', extensions: ['folio']}], properties: ['openFile']});
    if (result.canceled || !result.filePaths[0]) return null;
    if (fs.statSync(result.filePaths[0]).size > 512 * 1024 * 1024) throw new Error('This backup is too large.');
    return {bytes: new Uint8Array(fs.readFileSync(result.filePaths[0]))};
  });
  handle('import-library', async bytes => {
    const {decodeArchive} = await import('../dist/library-backup.mjs');
    const archive = await decodeArchive(bytes);
    return {books: store.importArchive(archive)};
  });
  handle('ready', () => {
    rendererReady = true;
    const files = pendingFiles; pendingFiles = [];
    const commands = pendingCommands; pendingCommands = [];
    return {files, commands, fullscreen: window.isFullScreen()};
  });
}

function createWindow() {
  rendererReady = false; closeReady = false;
  const saved = store.readOne('settings', 'window');
  const bounds = saved?.bounds;
  window = new BrowserWindow({
    width: bounds?.width || 1240, height: bounds?.height || 840, minWidth: 780, minHeight: 560,
    title: 'Folio', backgroundColor: '#faf8f5', show: false, acceptFirstMouse: true,
    titleBarStyle: 'hiddenInset', trafficLightPosition: {x: 18, y: 13},
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:folio', spellcheck: false, backgroundThrottling: false}
  });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('console-message', details => {
    if (details.level === 'error') fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `${new Date().toISOString()} ${String(details.message).slice(0, 2000)}\n`, {mode: 0o600});
  });
  window.on('enter-full-screen', () => window.webContents.send('folio:fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('folio:fullscreen', false));
  window.on('close', event => {
    if (closeReady) return;
    event.preventDefault();
    store.writeOne('settings', {id: 'window', bounds: window.getNormalBounds()});
    // Let pending position and note writes finish before the web view closes.
    Promise.race([
      window.webContents.executeJavaScript('typeof window.folioPrepareClose === "function" ? window.folioPrepareClose() : null').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]).finally(() => {
      closeReady = true; if (window && !window.isDestroyed()) window.close();
    });
  });
  window.on('closed', () => { window = null; rendererReady = false; });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-fail-load', (_event, code, description) => { if (code !== -3) dialog.showErrorBox('Folio could not open', description); });
  window.loadURL('folio://app/index.html');
}

function installMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label: 'Folio', submenu: [{role: 'about'}, {type: 'separator'}, {role: 'hide'}, {role: 'hideOthers'}, {role: 'unhide'}, {type: 'separator'}, {role: 'quit'}]},
    {label: 'File', submenu: [
      {label: 'Open PDFs…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open')},
      {label: 'Link PDFs…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('link')},
      {type: 'separator'},
      {label: 'Back Up Library…', click: () => sendCommand('backup')},
      {label: 'Restore Library…', click: () => sendCommand('restore')},
      {label: 'Export Saved Passages…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendCommand('export')},
      {type: 'separator'}, {role: 'close'}
    ]},
    {label: 'Edit', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
    {label: 'View', submenu: [{label: 'Library', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('library')}, {label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find')}, {label: 'Focus Mode', click: () => sendCommand('focus')}, {type: 'separator'}, {role: 'togglefullscreen'}]},
    {label: 'Window', submenu: [{role: 'minimize'}, {role: 'zoom'}, {type: 'separator'}, {role: 'front'}]},
    {label: 'Help', submenu: [{label: 'Keyboard Shortcuts', click: () => sendCommand('shortcuts')}, {label: 'PDF Safety', click: () => sendCommand('safety')}]}
  ]));
  app.dock?.setMenu(Menu.buildFromTemplate([{label: 'Open PDFs…', click: () => sendCommand('open')}, {label: 'Library', click: () => sendCommand('library')}]));
}

app.on('open-file', (event, filename) => { event.preventDefault(); queueFiles([filename]); });
app.on('before-quit', () => { quitting = true; });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    store = new FolioStore(app.getPath('userData'));
    const folioSession = session.fromPartition('persist:folio');
    folioSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    folioSession.setPermissionCheckHandler(() => false);
    folioSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_details, callback) => callback({cancel: true}));
    const root = path.join(app.getAppPath(), 'dist');
    folioSession.protocol.handle('folio', async request => {
      const filename = resolveAsset(root, request.url);
      if (!filename || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', {status: 404});
      try {
        const response = await net.fetch(pathToFileURL(filename).href);
        const headers = new Headers(response.headers);
        if (filename.endsWith('.html')) headers.set('Content-Security-Policy', csp);
        return new Response(request.method === 'HEAD' ? null : response.body, {status: response.status, headers});
      } catch { return new Response('Not found', {status: 404}); }
    });
    installIPC(); installMenus(); createWindow();
    app.on('activate', showWindow);
  }).catch(error => { dialog.showErrorBox('Folio could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => store?.close());
}
