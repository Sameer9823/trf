import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { EmployeeProfile, Permission } from '@trf/shared';
import { MESSAGES, MODULE_ACCESS } from '@trf/shared';

export interface AuthSessionState {
  employee: EmployeeProfile | null;
  status: 'checking' | 'signed-in' | 'signed-out';
  login(username: string, password: string): Promise<{ ok: true } | { ok: false; message: string }>;
  logout(): Promise<void>;
  can(permission: Permission): boolean;
  canAccessModule(module: string): boolean;
}

const Ctx = createContext<AuthSessionState | null>(null);

/** Exported so a screen can be rendered with a known session, e.g. in a check. */
export const AuthContext = Ctx;

interface MeResponse extends EmployeeProfile { permissions: Permission[] }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<EmployeeProfile | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [status, setStatus] = useState<AuthSessionState['status']>('checking');

  const applyProfile = useCallback((profile: MeResponse | null) => {
    if (!profile) {
      setEmployee(null);
      setPermissions([]);
      setStatus('signed-out');
      return;
    }
    const { permissions: granted, ...rest } = profile;
    setEmployee(rest as EmployeeProfile);
    setPermissions(granted ?? []);
    setStatus('signed-in');
  }, []);

  // On start-up the main process may already hold a valid session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await window.trf.session();
      if (cancelled) return;
      if (!session.signedIn) return setStatus('signed-out');
      const res = await window.trf.request<MeResponse>({ method: 'GET', path: '/api/auth/me' });
      if (cancelled) return;
      if (res.ok && res.data) applyProfile(res.data);
      else setStatus('signed-out');
    })();
    return () => { cancelled = true; };
  }, [applyProfile]);

  // The main process drops the session when a refresh fails or the user is deactivated.
  useEffect(() => window.trf.onSignedOut(() => { setEmployee(null); setPermissions([]); setStatus('signed-out'); }), []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await window.trf.login(username, password);
    if (!res.ok || !res.data?.employee) {
      const body = res.data as { error?: { message?: string } } | undefined;
      return { ok: false as const, message: body?.error?.message ?? MESSAGES.INVALID_CREDENTIALS };
    }
    // The login response already carries the profile; /me confirms the granted permissions.
    const me = await window.trf.request<MeResponse>({ method: 'GET', path: '/api/auth/me' });
    if (me.ok && me.data) applyProfile(me.data);
    else applyProfile({ ...(res.data.employee as EmployeeProfile), permissions: [] } as MeResponse);
    return { ok: true as const };
  }, [applyProfile]);

  const logout = useCallback(async () => {
    await window.trf.logout();
    setEmployee(null);
    setPermissions([]);
    setStatus('signed-out');
  }, []);

  const value = useMemo<AuthSessionState>(() => ({
    employee,
    status,
    login,
    logout,
    can: (permission) => permissions.includes(permission),
    canAccessModule: (module) => MODULE_ACCESS[module]?.includes(employee?.role ?? 'Viewer') ?? false,
  }), [employee, permissions, status, login, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
