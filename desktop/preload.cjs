const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('folioDesktop', {
  readAll: store => ipcRenderer.invoke('folio:read-all', store),
  readOne: (store, id) => ipcRenderer.invoke('folio:read-one', store, id),
  writeOne: (store, value) => ipcRenderer.invoke('folio:write-one', store, value),
  writeFile: value => ipcRenderer.invoke('folio:write-file', value),
  removeOne: (store, id) => ipcRenderer.invoke('folio:remove-one', store, id),
  pickPDFs: () => ipcRenderer.invoke('folio:pick-pdfs'),
  readSelectedPDF: token => ipcRenderer.invoke('folio:read-selected-pdf', token),
  releaseSelectedPDFs: tokens => ipcRenderer.invoke('folio:release-selected-pdfs', tokens),
  readPDF: id => ipcRenderer.invoke('folio:read-pdf', id),
  saveText: data => ipcRenderer.invoke('folio:save-text', data),
  backupLibrary: () => ipcRenderer.invoke('folio:backup-library'),
  restoreLibrary: () => ipcRenderer.invoke('folio:restore-library'),
  importLibrary: bytes => ipcRenderer.invoke('folio:import-library', bytes),
  ready: () => ipcRenderer.invoke('folio:ready'),
  onOpenFiles(callback) {
    const listener = (_event, files) => callback(files);
    ipcRenderer.on('folio:open-files', listener);
    return () => ipcRenderer.removeListener('folio:open-files', listener);
  },
  onCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('folio:command', listener);
    return () => ipcRenderer.removeListener('folio:command', listener);
  },
  onFullscreen(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('folio:fullscreen', listener);
    return () => ipcRenderer.removeListener('folio:fullscreen', listener);
  }
});
