import type { EmployeeProfile } from '@trf/shared';

export interface ApiResult<T = unknown> { ok: boolean; status: number; data?: T; error?: string }
export interface TrfBridge {
  getConfig(): Promise<{ serverUrl: string }>;
  setServerUrl(url: string): Promise<{ ok: true; serverUrl: string } | { ok: false; message: string }>;
  request<T = unknown>(req: { method: string; path: string; body?: unknown; auth?: boolean }): Promise<ApiResult<T>>;
  login(username: string, password: string): Promise<ApiResult<{ employee: EmployeeProfile }>>;
  logout(): Promise<{ ok: true }>;
  session(): Promise<{ ok: true; signedIn: boolean }>;
  printCoa(): Promise<{ ok: boolean }>;
  printTrf(): Promise<{ ok: boolean }>;
  exportReport(query: string): Promise<{
    ok: boolean; cancelled?: boolean; message?: string; path?: string; meta?: unknown;
  }>;
  onSignedOut(handler: () => void): () => void;
}
declare global { interface Window { trf: TrfBridge } }
