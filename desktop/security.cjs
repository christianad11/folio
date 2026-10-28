const path = require('node:path');

function resolveAsset(root, address) {
  try {
    const url = new URL(address);
    if (url.protocol !== 'folio:' || url.hostname !== 'app' || url.username || url.password || url.port) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0') || pathname.includes('\\')) return null;
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : null;
  } catch { return null; }
}

function trustedSender(event, window) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.protocol === 'folio:' && url.host === 'app'; }
  catch { return false; }
}

module.exports = {resolveAsset, trustedSender};
