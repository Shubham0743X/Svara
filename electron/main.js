const { app, BrowserWindow, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

/* ---------- settings you may want to change ---------- */
const PORT = 3000;                       // keep it: localStorage (favourites, playlists, settings) is tied to this origin
const ORIGIN = 'http://localhost:' + PORT;
const CSP_ENFORCE = false;               // false = report-only (violations show in DevTools, nothing breaks). Flip to true after a clean run.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",   // the app is one file with inline scripts
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://i.ytimg.com https://*.googleusercontent.com https://*.ggpht.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

/* ---------- never let a stray error in the in-process server kill the whole app ---------- */
process.on('uncaughtException', err => { console.error('[svara] uncaughtException:', err); app.quit(); });
process.on('unhandledRejection', err => { console.error('[svara] unhandledRejection:', err); app.quit(); });

/* ---------- yt-dlp location ----------
   1) a copy the user dropped into the app's data folder (writable, so `yt-dlp -U` can update it)
   2) a copy bundled with the app (extraResources)
   3) the dev copy next to the project */
const candidates = [
  path.join(app.getPath('userData'), 'yt-dlp.exe'),
  process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp.exe') : '',
  path.join(__dirname, '..', 'yt-dlp.exe')
].filter(Boolean);
process.env.YTDLP = candidates.find(p => fs.existsSync(p)) || candidates[0];

/* ---------- URL helpers (exact origin match; startsWith('http://localhost') also matches localhost.evil.com) ---------- */
function isAppUrl(u){
  try { return new URL(u).origin === ORIGIN; } catch (e) { return false; }
}
function openExternal(u){
  try {
    const p = new URL(u);
    if (p.protocol === 'https:' || p.protocol === 'http:') shell.openExternal(p.href);
  } catch (e) { /* ignore malformed urls */ }
}

/* ---------- port / server checks ---------- */
function portFree(port){
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
// Svara's own /api/system answers with { version, ytdlp, ytdlpFound }
function pingSvara(){
  return new Promise(resolve => {
    const req = http.get(ORIGIN + '/api/system', { timeout: 1500 }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(!!j && typeof j === 'object' && 'ytdlpFound' in j); }
        catch (e) { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function waitForServer(maxMs){
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (await pingSvara()) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/* ---------- one-time cache clear after an update (stale lyrics / album data), user data is kept ---------- */
async function clearCacheIfUpdated(){
  const f = path.join(app.getPath('userData'), 'last-version.txt');
  let last = '';
  try { last = fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* first run */ }
  if (last !== app.getVersion()) {
    try { await session.defaultSession.clearCache(); } catch (e) { /* ignore */ }
    try { fs.writeFileSync(f, app.getVersion()); } catch (e) { /* ignore */ }
  }
}

/* ---------- session hardening ---------- */
function hardenSession(){
  const ses = session.defaultSession;
  // Electron grants every permission request by default. Svara needs only fullscreen and clipboard-copy.
  const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED.has(permission) && isAppUrl(wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission) => ALLOWED.has(permission));
  // Content-Security-Policy for pages served by Svara's own server
  ses.webRequest.onHeadersReceived((details, cb) => {
    const headers = Object.assign({}, details.responseHeaders);
    if (details.url.startsWith(ORIGIN + '/')) {
      headers[CSP_ENFORCE ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'] = [CSP];
    }
    cb({ responseHeaders: headers });
  });
}

/* ---------- window ---------- */
let win = null;
function createWindow(){
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#050507',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    show: false,
    title: 'Svara',
    webPreferences: {                    // these are Electron's defaults today; stated so they can never silently change
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadURL(ORIGIN);

  // the server may not be up yet: retry a few times instead of an endless loop or a blank window
  let retries = 0;
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;            // ignore sub-frames and aborted loads
    if (++retries <= 10) {
      setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(ORIGIN); }, 600);
    } else {
      dialog.showErrorBox('Svara', 'Could not start the Svara server (' + desc + '). Please restart the app.');
    }
  });
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 4000);

  // external links open in the default browser; the app window never navigates away from Svara
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  const guard = (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); openExternal(url); } };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
}

/* ---------- start-up ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();                                            // a second copy would share (and outlive) the first one's server
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.shubham0743x.svara');
    hardenSession();
    await clearCacheIfUpdated();

    if (await portFree(PORT)) {
      require('../server.js');                           // start Svara's own server
      if (!(await waitForServer(15000))) {
        dialog.showErrorBox('Svara', 'The Svara server did not start. Please restart the app.');
        app.quit();
        return;
      }
    } else if (!(await pingSvara())) {
      dialog.showErrorBox('Svara', 'Port ' + PORT + ' is being used by another program. Close it and start Svara again.');
      app.quit();
      return;
    } else {
      console.log('Port ' + PORT + ' already has a Svara server — connecting to it.');
    }
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
