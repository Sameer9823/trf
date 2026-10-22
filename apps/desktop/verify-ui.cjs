/* eslint-disable */
/**
 * A one-off check of the built desktop app against the running API. It opens
 * the real renderer with the real preload, signs in, opens a TRF and reads the
 * field order and the dropdowns straight out of the rendered page.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const API = 'http://127.0.0.1:4000';
const USER = 'admin';
const PASSWORD = 'Sameer@98231234';

let tokens = null;

async function send(req) {
  const headers = { 'Content-Type': 'application/json' };
  if (req.accessToken) headers.Authorization = `Bearer ${req.accessToken}`;
  const res = await fetch(API + req.path, {
    method: req.method,
    headers,
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

  const target = await win.webContents.executeJavaScript(`(async () => {
    const login = await window.trf.login(${JSON.stringify(USER)}, ${JSON.stringify(PASSWORD)});
    if (!login.ok) return { error: 'login failed', detail: JSON.stringify(login) };
    const list = await window.trf.request({ method: 'GET', path: '/api/trfs?pageSize=5' });
    const item = list.data && list.data.items && list.data.items[0];
    if (!item) return { error: 'no TRF to open' };
    return { id: item.id, trfNumber: item.trfNumber };
  })()`);
  if (target.error) { console.log(JSON.stringify(target)); app.exit(1); return; }

  // --- 1. the TRF edit screen -------------------------------------------
  await win.webContents.executeJavaScript(
    `location.hash = '#/trfs/${target.id}/edit'; location.reload(); true;`);
  await sleep(5000);

  const form = await win.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const labels = (card) => Array.from(card.querySelectorAll('.field__head label'))
      .map((el) => (el.textContent || '').replace('*', '').trim());
    const partA = cards.find((c) => (c.querySelector('h2') || {}).textContent === 'Part A — Formulation');
    const ard = cards.find((c) => (c.querySelector('h2') || {}).textContent === 'ARD — Analysis Details');
    const stage = document.getElementById('trf-ard-stage');
    const reporting = document.getElementById('trf-reporting');
    const partAText = partA ? partA.innerText : '';
    const ardText = ard ? ard.innerText : '';
    return {
      cardOrder: cards.map((c) => (c.querySelector('h2') || {}).textContent),
      partA: partA ? labels(partA) : null,
      ard: ard ? labels(ard) : null,
      stageOptions: stage ? Array.from(stage.options).map((o) => o.textContent) : null,
      reportingOptions: reporting ? Array.from(reporting.options).map((o) => o.textContent) : null,
      partAHasRemarkStatusLabel: /Remark Status/i.test(partAText),
      ardHasRemarkStatusLabel: /Remark Status/i.test(ardText),
      carriedForwardNote: /Carried forward from the Formulation request/.test(ardText),
      testRequestedLocked: (() => {
        const el = document.getElementById('trf-ard-test-requested');
        return el ? { readOnly: el.readOnly, disabled: el.disabled } : null;
      })(),
      testDetailsLocked: (() => {
        const el = document.getElementById('trf-ard-test-details');
        return el ? { readOnly: el.readOnly, disabled: el.disabled } : null;
      })(),
      partATestRequested: (() => {
        const el = document.getElementById('trf-requested');
        return el ? { readOnly: el.readOnly, disabled: el.disabled } : null;
      })(),
    };
  })()`);

  // --- 2. the list screen -----------------------------------------------
  await win.webContents.executeJavaScript(`location.hash = '#/trf'; location.reload(); true;`);
  await sleep(4000);
  // Open the "Columns" toggle so the panel with the column names is rendered.
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.col-toggle button');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(800);
  const list = await win.webContents.executeJavaScript(`(() => {
    const heads = Array.from(document.querySelectorAll('thead th'))
      .map((th) => (th.textContent || '').trim());
    const toggle = Array.from(document.querySelectorAll('.col-toggle__panel .col-toggle__item'))
      .map((el) => (el.textContent || '').trim());
    const firstRow = Array.from(document.querySelectorAll('tbody tr')[0]?.querySelectorAll('td') || [])
      .map((td) => (td.textContent || '').trim());
    const tip = document.querySelector('tbody tr td[title]');
    return { heads, toggle, firstRow, sampleTitle: tip ? tip.getAttribute('title') : null };
  })()`);

  const out = { trfNumber: target.trfNumber, form, list };
  fs.writeFileSync(path.join(__dirname, 'verify-ui-result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  app.quit();
}).catch((e) => { console.error('ERR', e); app.exit(1); });
