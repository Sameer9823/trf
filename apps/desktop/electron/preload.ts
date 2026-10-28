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
  login: (username: string, password: string) => ipcRenderer.invoke('auth:login', { username, password }) as Promise<{ ok: boolean; data?: { employee: import('@trf/shared').EmployeeProfile; tokens?: unknown }; error?: string }>,
  logout: () => ipcRenderer.invoke('auth:logout'),
  session: () => ipcRenderer.invoke('auth:session'),
  printCoa: () => ipcRenderer.invoke('coa:print') as Promise<{ ok: boolean }>,
  printTrf: (trfId: number) => ipcRenderer.invoke('trf:print', trfId) as Promise<{ ok: boolean; message?: string }>,
  printToPDF: (trfId: number, fileName: string) => ipcRenderer.invoke('trf:printToPDF', trfId, fileName) as Promise<{ ok: boolean; cancelled?: boolean; path?: string; message?: string }>,
  generatePdf: (trfId: number) => ipcRenderer.invoke('trf:generate-pdf', trfId) as Promise<{ ok: boolean; path?: string; fileName?: string; message?: string }>,
  // Download a file (blob) from the API
  downloadBlob: (path: string, fileName: string) => ipcRenderer.invoke('api:downloadBlob', path, fileName) as Promise<{ ok: boolean; cancelled?: boolean; path?: string; message?: string }>,
  // Asks the main process to save the report; the renderer never handles the file.
  exportReport: (query: string) => ipcRenderer.invoke('reports:export', query) as Promise<{
    ok: boolean; cancelled?: boolean; message?: string; path?: string; meta?: unknown;
  }>,
  onSignedOut: (handler: () => void) => {
    ipcRenderer.on('auth:signed-out', handler);
    return () => ipcRenderer.removeListener('auth:signed-out', handler);
  },
});
