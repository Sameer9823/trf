import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/Logo';

interface TeamMember {
  id: number;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  hasPin: boolean;
  pinLocked: boolean;
}

const TEAM_NAME = { FRD: 'Formulation team (FRD)', ARD: 'Analytical team (ARD)' } as const;

/**
 * Shown after a team login. Several people share that login, so before anything
 * can be done each person picks their own name and enters their own PIN. From
 * then on every change is recorded under their name, not the team's.
 */
export function SelectMember() {
  const { employee, selectMember, logout, status, actingEmployeeId } = useAuth();
  const navigate = useNavigate();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [chosen, setChosen] = useState<TeamMember | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status !== 'signed-in' || employee?.accountType !== 'SHARED_TEAM' || actingEmployeeId !== null) return;
    let cancelled = false;
    void window.trf.request<{ items: TeamMember[] }>({ method: 'GET', path: '/api/employees/team-members' }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setMembers(res.data.items);
      else setError('The list of team members could not be loaded. Please try again.');
    });
    return () => { cancelled = true; };
  }, [status, employee?.accountType, actingEmployeeId]);

  useEffect(() => { if (chosen) pinRef.current?.focus(); }, [chosen]);

  if (status !== 'signed-in' || employee?.accountType !== 'SHARED_TEAM' || actingEmployeeId !== null) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    const result = await selectMember(chosen.id, pin);
    setBusy(false);
    if (result.ok) {
      navigate('/', { replace: true });
    } else {
      setError(result.message);
      setPin('');
      pinRef.current?.focus();
    }
  }

  const teamName = employee.team ? TEAM_NAME[employee.team] : 'Team';

  return (
    <div className="login">
      <div className="login__card login__card--wide">
        <Logo height={44} />
        <h1 className="login__title">{chosen ? `Welcome, ${chosen.fullName}` : 'Who is using this screen?'}</h1>
        <p className="muted">{teamName}. {chosen ? 'Enter your PIN to continue.' : 'Choose your name. Everything you do is recorded under it.'}</p>

        {error && <p className="error-text" role="alert">{error}</p>}

        {!chosen && (
          members === null && !error ? (
            <div className="member-grid" aria-busy="true">
              {[0, 1, 2, 3].map((i) => <div key={i} className="member member--skeleton" />)}
            </div>
          ) : members && members.length === 0 ? (
            <p className="muted">No one has been added to this team yet. Ask an administrator to add team members and set their PINs.</p>
          ) : (
            <ul className="member-grid" role="list">
              {members?.map((m, i) => (
                <li key={m.id} style={{ ['--i' as string]: i }}>
                  <button type="button" className="member" onClick={() => { setChosen(m); setError(null); }}
                    disabled={!m.hasPin || m.pinLocked}
                    title={!m.hasPin ? 'No PIN has been set for this person yet' : m.pinLocked ? 'Locked after too many wrong PINs' : undefined}>
                    <span className="member__initials" aria-hidden>{m.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
                    <span className="member__name">{m.fullName}</span>
                    <span className="member__role">{m.designation ?? m.employeeCode}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        )}

        {chosen && (
          <form onSubmit={submit}>
            <label htmlFor="member-pin">PIN</label>
            <input
              id="member-pin" ref={pinRef} type="password" inputMode="numeric" autoComplete="off"
              pattern="\d{4,6}" maxLength={6} value={pin} disabled={busy}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              aria-invalid={!!error}
            />
            <button className="btn btn--primary login__submit" type="submit" disabled={busy || pin.length < 4}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
            <button className="btn btn--ghost login__submit" type="button" disabled={busy}
              onClick={() => { setChosen(null); setPin(''); setError(null); }}>
              Not me
            </button>
          </form>
        )}

        <p className="muted login__server">
          <span>Signed in as <strong>{employee.fullName}</strong></span>
          <button type="button" className="link-button" onClick={() => void logout()}>Sign out</button>
        </p>
      </div>
    </div>
  );
}
