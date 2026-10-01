import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const REQUEST_TIMEOUT_MS = 8000;
/** Refresh this long before the access token expires, so a request never races the expiry. */
const REFRESH_LEEWAY_MS = 60_000;

interface DesktopConfig { serverUrl: string }

interface ApiResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

interface ExportOutcome {
  ok: boolean;
  cancelled?: boolean;
  message?: string;
  path?: string;
  meta?: unknown;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

/**
 * Tokens live only in this process's memory. Nothing is written to disk, so no
 * localStorage or file on the PC can leak a session.
 */
let tokens: StoredTokens | null = null;

type AuthListener = (state: 'signed-out') => void;
const authListeners = new Set<AuthListener>();
function notifySignedOut() {
  for (const listener of authListeners) listener('signed-out');
}

/** Order: user-saved setting -> installer-provided default-config.json -> TRF_API_URL env -> localhost. */
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }

function readConfig(): DesktopConfig {
  const fallback = process.env.TRF_API_URL || 'http://localhost:4000';
  const candidates = [configPath(), path.join(process.resourcesPath ?? '', 'default-config.json')];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof parsed.serverUrl === 'string' && parsed.serverUrl) return { serverUrl: parsed.serverUrl };
    } catch { /* try next */ }
  }
  return { serverUrl: fallback };
}

function normalizeServerUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Address must start with http:// or https://');
  return url.origin;
}

ipcMain.handle('config:get', () => readConfig());

ipcMain.handle('config:set', (_e, serverUrl: string) => {
  try {
    const normalized = normalizeServerUrl(serverUrl);
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ serverUrl: normalized }, null, 2));
    return { ok: true as const, serverUrl: normalized };
  } catch (err) {
    return { ok: false as const, message: (err as Error).message };
  }
});

async function send(req: { method: string; path: string; body?: unknown; accessToken?: string }): Promise<ApiResult> {
  if (!req.path.startsWith('/api/')) return { ok: false, status: 0, error: 'INVALID_PATH' };
  const base = readConfig().serverUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await net.fetch(base + req.path, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.accessToken ? { Authorization: `Bearer ${req.accessToken}` } : {}),
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    // Unreachable, timed out, or TLS failure: the renderer shows the offline message.
    return { ok: false, status: 0, error: 'UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/** Exchanges the stored refresh token for a new pair. Only ever in memory. */
async function refreshTokens(): Promise<boolean> {
  if (!tokens?.refreshToken) return false;
  const res = await send({
    method: 'POST',
    path: '/api/auth/refresh',
    body: { refreshToken: tokens.refreshToken },
  });
  const body = res.data as { accessToken?: string; refreshToken?: string; accessTokenExpiresAt?: string } | null;
  if (!res.ok || !body?.accessToken || !body.refreshToken) {
    tokens = null;
    notifySignedOut();
    return false;
  }
  tokens = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    accessTokenExpiresAt: body.accessTokenExpiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  return true;
}

/**
 * All API traffic goes through the main process: no CORS, one place for the auth
 * token. The renderer never sees a token; it only sees the signed-in profile.
 */
ipcMain.handle('api:request', async (_e, req: { method: string; path: string; body?: unknown; auth?: boolean }): Promise<ApiResult> => {
  const needsAuth = req.auth !== false;
  if (needsAuth && !tokens) return { ok: false, status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } };

  // Refresh before the token expires rather than after a request fails.
  if (needsAuth && tokens && new Date(tokens.accessTokenExpiresAt).getTime() - REFRESH_LEEWAY_MS < Date.now()) {
    const refreshed = await refreshTokens();
    if (!refreshed) return { ok: false, status: 401, data: { error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' } } };
  }

  let res = await send({ method: req.method, path: req.path, body: req.body, accessToken: needsAuth ? tokens!.accessToken : undefined });

  // A rejected token (expired, revoked, deactivated user) gets one retry.
  if (needsAuth && res.status === 401) {
    if (await refreshTokens()) {
      res = await send({ method: req.method, path: req.path, body: req.body, accessToken: tokens!.accessToken });
    } else {
      return { ok: false, status: 401, data: { error: { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' } } };
    }
  }
  return res;
});

ipcMain.handle('auth:login', async (_e, body: { username: string; password: string }) => {
  const res = await send({ method: 'POST', path: '/api/auth/login', body });
  const data = res.data as { accessToken?: string; refreshToken?: string; accessTokenExpiresAt?: string; employee?: unknown } | null;
  if (!res.ok || !data?.accessToken || !data.refreshToken) return res;
  tokens = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessTokenExpiresAt: data.accessTokenExpiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  return { ok: true as const, data };
});

ipcMain.handle('auth:logout', async () => {
  if (tokens?.refreshToken) {
    await send({ method: 'POST', path: '/api/auth/logout', body: { refreshToken: tokens.refreshToken } });
  }
  tokens = null;
  return { ok: true as const };
});

ipcMain.handle('auth:session', async () => ({ ok: true as const, signedIn: tokens !== null }));

/**
 * Printing happens in the main process so the printed copy carries the real
 * certificate layout: the print stylesheet hides everything else on the page.
 */
ipcMain.handle('coa:print', (event) => {
  event.sender.print({ silent: false, printBackground: true });
  return { ok: true as const };
});

ipcMain.handle('auth:on-signed-out', (event) => {
  const listener: AuthListener = () => event.sender.send('auth:signed-out');
  authListeners.add(listener);
  event.sender.once('destroyed', () => authListeners.delete(listener));
});

/**
 * Downloaded in the main process and written straight to disk. The renderer only
 * ever learns the path and the row counts, so a large workbook never has to cross
 * the IPC boundary as a string. Asking first is the point: an export overwrites
 * nothing without the employee choosing where it lands.
 */
ipcMain.handle('reports:export', async (event, query: string): Promise<ExportOutcome> => {
  if (!tokens) {
    return { ok: false, message: 'Sign in to export.' };
  }
  const suffix = /[?&]sheet=([^&]+)/.exec(query)?.[1];
  const stamp = new Date().toISOString().slice(0, 10);
  const suggested = `TRF-Report-${stamp}${suffix ? `-${suffix.replace(/\s+/g, '-')}` : ''}.xlsx`;

  let target: string | undefined;
  try {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: 'Save the Excel report',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    };
    const chosen = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true, message: 'Export cancelled.' };
    target = chosen.filePath;
  } catch {
    // A headless or locked-down session cannot show a dialog; fall back to Documents.
    target = path.join(app.getPath('documents'), suggested);
  }

  const base = readConfig().serverUrl;
  try {
    const res = await net.fetch(`${base}/api/reports/export.xlsx${query ? `?${query}` : ''}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      return { ok: false, message: body?.error?.message ?? 'The report could not be created.' };
    }
    const meta = res.headers.get('x-export-meta');
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(target, buffer);
    return { ok: true, path: target, meta: meta ? JSON.parse(meta) : null };
  } catch {
    return { ok: false, message: 'Company server is unavailable. Please connect to the company network.' };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1360, height: 840, minWidth: 1100, minHeight: 680,
    title: 'TRF Management System',
    backgroundColor: '#f4f6f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);

  // Nothing in this app should ever open a second window or navigate away to a
  // page. Both are refused rather than left to the renderer, which would not know
  // to refuse them.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // An external link may open in the employee's browser, but never in a window
    // that would appear to be part of the application.
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  // Nothing is downloaded or opened from the application's own origin.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (!DEV_URL) {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"],
          'X-Content-Type-Options': ['nosniff'],
        },
      });
      return;
    }
    cb({ responseHeaders: details.responseHeaders });
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  // Only one copy per PC.
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
