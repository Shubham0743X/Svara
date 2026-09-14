const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

// Point the server at the packaged yt-dlp.exe (or the dev copy)
const candidates = [
  process.resourcesPath ? path.join(process.resourcesPath, 'yt-dlp.exe') : '',
  path.join(__dirname, '..', 'yt-dlp.exe')
].filter(Boolean);
process.env.YTDLP = candidates.find(p => fs.existsSync(p)) || candidates[candidates.length - 1];

const PORT = 3000;
const URL = 'http://localhost:' + PORT;

// Reuse an already-running Svara server instead of crashing (bug #29)
function portFree(port){
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

let win;
function createWindow(){
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#050507',
    autoHideMenuBar: true,
    show: false,
    title: 'Svara'
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(URL);
  // server may not be up yet — retry instead of showing a blank window
  win.webContents.on('did-fail-load', () => setTimeout(() => win.loadURL(URL), 600));
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 4000);
  // external links (e.g. your GitHub profile) open in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost')) { e.preventDefault(); shell.openExternal(url); }
  });
}

app.whenReady().then(async () => {
  if (await portFree(PORT)) {
    require('../server.js');                 // start Svara's own server
  } else {
    console.log('Port ' + PORT + ' already in use — connecting to the running server.');
  }
  setTimeout(createWindow, 400);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
