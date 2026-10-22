import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import type { HealthResponse } from '@trf/shared';

export type ConnectionState = 'checking' | 'connected' | 'offline';

interface ServerStatus {
  state: ConnectionState;
  health: HealthResponse | null;
  serverUrl: string;
  lastChecked: Date | null;
  recheck: () => Promise<void>;
}

const Ctx = createContext<ServerStatus | null>(null);

/** Exported so a screen can be rendered with a known state, e.g. in a check. */
export const ServerStatusContext = Ctx;
const POLL_MS = 10_000;

export function ServerStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>('checking');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const inFlight = useRef(false);

  const recheck = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const cfg = await window.trf.getConfig();
      setServerUrl(cfg.serverUrl);
      const res = await window.trf.request<HealthResponse>({ method: 'GET', path: '/api/health' });
      // The server must answer AND its database must be up before data screens are usable.
      const up = res.ok && res.data?.database === 'connected';
      setHealth(res.data ?? null);
      setState(up ? 'connected' : 'offline');
    } finally {
      setLastChecked(new Date());
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    recheck();
    const id = setInterval(recheck, POLL_MS);
    return () => clearInterval(id);
  }, [recheck]);

  return <Ctx.Provider value={{ state, health, serverUrl, lastChecked, recheck }}>{children}</Ctx.Provider>;
}

export function useServerStatus() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useServerStatus must be used inside ServerStatusProvider');
  return v;
}
