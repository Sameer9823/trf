import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { EmployeeProfile, Permission } from '@trf/shared';
import { MESSAGES, MODULE_ACCESS } from '@trf/shared';

/** Extended MeResponse with actingEmployeeId and accountId for shared team accounts. */
interface MeResponse extends EmployeeProfile {
  permissions: Permission[];
  actingEmployeeId: number | null;
  accountId: number | null;
}

export interface AuthSessionState {
  employee: EmployeeProfile | null;
  status: 'checking' | 'signed-in' | 'signed-out';
  /** For shared team accounts: the selected acting employee ID (null if no member selected yet). */
  actingEmployeeId: number | null;
  /** For shared team accounts: the team account ID. */
  accountId: number | null;
  login(username: string, password: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** A team login: the member who is about to act chooses their name and enters their PIN. */
  selectMember(memberId: number, pin: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** "Not me" and the idle lock: hand the screen back to the name picker. */
  switchUser(reason?: 'idle'): Promise<void>;
  logout(): Promise<void>;
  can(permission: Permission): boolean;
  canAccessModule(module: string): boolean;
}

/** Minutes of no activity after which a team login returns to the name picker. */
const IDLE_LOCK_MS = 10 * 60_000;

const Ctx = createContext<AuthSessionState | null>(null);

/** Exported so a screen can be rendered with a known session, e.g. in a check. */
export const AuthContext = Ctx;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<EmployeeProfile | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [status, setStatus] = useState<AuthSessionState['status']>('checking');
  const [actingEmployeeId, setActingEmployeeId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);

  const applyProfile = useCallback((profile: MeResponse | null) => {
    if (!profile) {
      setEmployee(null);
      setPermissions([]);
      setActingEmployeeId(null);
      setAccountId(null);
      setStatus('signed-out');
      return;
    }
    const { permissions: granted, actingEmployeeId: actingId, accountId: accId, ...rest } = profile;
    setEmployee(rest as EmployeeProfile);
    setPermissions(granted ?? []);
    setActingEmployeeId(actingId ?? null);
    setAccountId(accId ?? null);
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
  useEffect(() => window.trf.onSignedOut(() => { setEmployee(null); setPermissions([]); setActingEmployeeId(null); setAccountId(null); setStatus('signed-out'); }), []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await window.trf.login(username, password) as { ok: boolean; data?: { employee: EmployeeProfile; tokens?: unknown }; error?: string };
    if (!res.ok || !res.data?.employee) {
      const body = res.data as { error?: { message?: string } } | undefined;
      return { ok: false as const, message: body?.error?.message ?? MESSAGES.INVALID_CREDENTIALS };
    }
    // The login response already carries the profile; /me confirms the granted permissions.
    const me = await window.trf.request<MeResponse>({ method: 'GET', path: '/api/auth/me' });
    if (me.ok && me.data) applyProfile(me.data);
    else applyProfile({ ...(res.data?.employee as EmployeeProfile), permissions: [], actingEmployeeId: null, accountId: null } as MeResponse);
    return { ok: true as const };
  }, [applyProfile]);

  const logout = useCallback(async () => {
    await window.trf.logout();
    setEmployee(null);
    setPermissions([]);
    setActingEmployeeId(null);
    setAccountId(null);
    setStatus('signed-out');
  }, []);

  const loadMe = useCallback(async () => {
    const me = await window.trf.request<MeResponse>({ method: 'GET', path: '/api/auth/me' });
    if (me.ok && me.data) applyProfile(me.data);
    else applyProfile(null);
  }, [applyProfile]);

  const selectMember = useCallback(async (memberId: number, pin: string) => {
    const res = await window.trf.request<{ ok: boolean }>({
      method: 'POST',
      path: '/api/auth/select-member',
      body: { employeeId: memberId, pin },
    });
    if (res.ok) {
      await loadMe();
      return { ok: true as const };
    }
    const body = res.data as { error?: { message?: string } } | undefined;
    return { ok: false as const, message: body?.error?.message ?? 'Could not confirm your name and PIN.' };
  }, [loadMe]);

  const switchUser = useCallback(async (reason?: 'idle') => {
    const res = await window.trf.request({ method: 'POST', path: '/api/auth/switch-user', body: { reason } });
    if (res.ok) await loadMe();
  }, [loadMe]);

  // A shared PC left alone goes back to the name picker, so nobody can act as the last person.
  useEffect(() => {
    if (employee?.accountType !== 'SHARED_TEAM' || actingEmployeeId === null) return;
    let timer = window.setTimeout(lock, IDLE_LOCK_MS);
    function lock() { void switchUser('idle'); }
    const reset = () => { window.clearTimeout(timer); timer = window.setTimeout(lock, IDLE_LOCK_MS); };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    events.forEach((name) => window.addEventListener(name, reset, { passive: true }));
    return () => { window.clearTimeout(timer); events.forEach((name) => window.removeEventListener(name, reset)); };
  }, [employee?.accountType, actingEmployeeId, switchUser]);

  const value = useMemo<AuthSessionState>(() => ({
    employee,
    status,
    actingEmployeeId,
    accountId,
    login,
    selectMember,
    switchUser,
    logout,
    can: (permission) => permissions.includes(permission),
    canAccessModule: (module) => MODULE_ACCESS[module]?.includes(employee?.role ?? 'Viewer') ?? false,
  }), [employee, permissions, status, actingEmployeeId, accountId, login, selectMember, switchUser, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
