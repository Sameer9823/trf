import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer never receives a token. Sign-in, refresh and sign-out all happen
 * in the main process; the renderer only asks for the signed-in profile.
 */
contextBridge.exposeInMainWorld('trf', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setServerUrl: (url: string) => ipcRenderer.invoke('config:set', url),
  request: <T = unknown>(req: { method: string; path: string; body?: unknown; auth?: boolean }) =>
    ipcRenderer.invoke('api:request', req) as Promise<{ ok: boolean; status: number; data?: T; error?: string }>,
  login: (username: string, password: string) => ipcRenderer.invoke('auth:login', { username, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  session: () => ipcRenderer.invoke('auth:session'),
  printCoa: () => ipcRenderer.invoke('coa:print') as Promise<{ ok: boolean }>,
  printTrf: () => ipcRenderer.invoke('trf:print') as Promise<{ ok: boolean }>,
  // Asks the main process to save the report; the renderer never handles the file.
  exportReport: (query: string) => ipcRenderer.invoke('reports:export', query) as Promise<{
    ok: boolean; cancelled?: boolean; message?: string; path?: string; meta?: unknown;
  }>,
  onSignedOut: (handler: () => void) => {
    ipcRenderer.on('auth:signed-out', handler);
    return () => ipcRenderer.removeListener('auth:signed-out', handler);
  },
});
