/* eslint-disable */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const API = 'http://127.0.0.1:4000';
let tokens = null;

async function send(req) {
  const headers = { 'Content-Type': 'application/json' };
  if (req.accessToken) headers.Authorization = `Bearer ${req.accessToken}`;
  const res = await fetch(API + req.path, {
    method: req.method, headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

ipcMain.handle('config:get', () => ({ serverUrl: API }));
ipcMain.handle('config:set', () => ({ ok: true, serverUrl: API }));
ipcMain.handle('api:request', async (_e, req) => {
  if (!tokens) return { ok: false, status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } };
  return send({ ...req, accessToken: tokens.accessToken });
});
ipcMain.handle('auth:login', async (_e, body) => {
  const res = await send({ method: 'POST', path: '/api/auth/login', body });
  const data = res.data;
  if (!res.ok || !data || !data.accessToken) return res;
  tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken };
  return { ok: true, data };
});
ipcMain.handle('auth:logout', async () => { tokens = null; return { ok: true }; });
ipcMain.handle('auth:session', async () => ({ ok: true, signedIn: tokens !== null }));
ipcMain.handle('coa:print', () => ({ ok: true }));
ipcMain.handle('trf:print', () => ({ ok: true }));
ipcMain.handle('reports:export', () => ({ ok: true, cancelled: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 1100, show: false,
    webPreferences: { preload: path.join(__dirname, 'dist-electron', 'preload.js') },
  });
  await win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  await sleep(1500);
  await win.webContents.executeJavaScript(
    `(async () => { await window.trf.login('admin','Sameer@98231234'); return true; })()`);
  await win.webContents.executeJavaScript(`location.hash = '#/trf'; location.reload(); true;`);
  await sleep(6000);
  const out = await win.webContents.executeJavaScript(`(() => ({
    hash: location.hash,
    text: (document.body.innerText || '').slice(0, 700),
    tables: document.querySelectorAll('table').length,
    ths: document.querySelectorAll('th').length,
    colToggle: document.querySelectorAll('.col-toggle').length,
  }))()`);
  console.log(JSON.stringify(out, null, 1));
  app.quit();
}).catch((e) => { console.error('ERR', e); app.exit(1); });
