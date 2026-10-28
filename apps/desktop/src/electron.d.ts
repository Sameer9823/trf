interface ElectronAPI {
  printToPDF: (fileName: string) => Promise<{ ok: boolean; cancelled?: boolean; path?: string; message?: string }>;
}

interface Window {
  electronAPI: ElectronAPI;
  trf: {
    getConfig: () => Promise<{ serverUrl: string }>;
    setServerUrl: (url: string) => Promise<{ ok: boolean; serverUrl?: string; message?: string }>;
    request: <T = unknown>(req: { method: string; path: string; body?: unknown; auth?: boolean }) => Promise<{ ok: boolean; status: number; data?: T; error?: string }>;
    login: (username: string, password: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
    logout: () => Promise<{ ok: boolean }>;
    session: () => Promise<{ ok: boolean; signedIn: boolean }>;
    printCoa: () => Promise<{ ok: boolean }>;
    printTrf: (trfId: number) => Promise<{ ok: boolean; message?: string }>;
    printToPDF: (trfId: number, fileName: string) => Promise<{ ok: boolean; cancelled?: boolean; path?: string; message?: string }>;
    generatePdf: (trfId: number) => Promise<{ ok: boolean; path?: string; fileName?: string; message?: string }>;
    exportReport: (query: string) => Promise<{ ok: boolean; cancelled?: boolean; message?: string; path?: string; meta?: unknown }>;
    onSignedOut: (handler: () => void) => () => void;
  };
}