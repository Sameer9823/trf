import { FormEvent, useCallback, useEffect, useState } from 'react';
import { messageOf } from '../lib/api';
import { Modal } from '../components/Modal';

interface TeamLogin {
  id: number; team: 'FRD' | 'ARD'; label: string; username: string; email: string;
  isActive: boolean; hasPassword: boolean; lockedUntil: string | null;
}

/**
 * The two shared logins, one for each team, and the mailbox each team uses. An administrator
 * sets their passwords here. People never use the password to act: they choose their name and
 * enter their own PIN, so the team password alone identifies nobody.
 */
export function TeamLogins() {
  const [items, setItems] = useState<TeamLogin[]>([]);
  const [editing, setEditing] = useState<TeamLogin | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await window.trf.request<{ items: TeamLogin[] }>({ method: 'GET', path: '/api/team-accounts' });
    if (res.ok && res.data) setItems(res.data.items);
  }, []);
  useEffect(() => { void load(); }, [load]);

  function open(item: TeamLogin) { setEditing(item); setEmail(item.email); setPassword(''); setError(null); }

  async function patch(item: TeamLogin, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    const res = await window.trf.request({ method: 'PATCH', path: `/api/team-accounts/${item.id}`, body });
    setBusy(false);
    if (!res.ok) { setError(messageOf(res.data, 'That could not be saved.')); return false; }
    await load();
    return true;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    const body: Record<string, unknown> = {};
    if (email.trim() !== editing.email) body.email = email.trim();
    if (password) body.password = password;
    if (!Object.keys(body).length) { setEditing(null); return; }
    if (await patch(editing, body)) setEditing(null);
  }

  return (
    <section className="panel" aria-labelledby="team-logins-title">
      <h2 id="team-logins-title">Team logins</h2>
      <p className="muted">FRD and ARD each share one login and one mailbox. Every action is still recorded under the person who chose their name and entered their PIN.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Team</th><th>Username</th><th>Mailbox</th><th>Status</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>{t.username}</td>
                <td>{t.email}</td>
                <td>{t.lockedUntil ? 'Locked' : t.isActive ? 'Active' : t.hasPassword ? 'Switched off' : 'No password yet'}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button type="button" className="btn" onClick={() => open(t)}>Edit</button>
                  {t.hasPassword && (
                    <button type="button" className="btn" disabled={busy} onClick={() => void patch(t, { isActive: !t.isActive })}>
                      {t.isActive ? 'Switch off' : 'Switch on'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={editing !== null}
        onClose={() => !busy && setEditing(null)}
        title={editing ? `${editing.label} login` : ''}
        busy={busy}
      >
        <form onSubmit={save}>
          {error && <p className="error-text" role="alert">{error}</p>}
          <label htmlFor="team-email">Team mailbox</label>
          <input id="team-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label htmlFor="team-password">{editing?.hasPassword ? 'New password (leave empty to keep it)' : 'Password'}</label>
          <input id="team-password" type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="muted">At least 10 characters, with a letter and a number. Changing it signs the team out everywhere.</p>
          <div className="row modal__actions">
            <button className="btn btn--primary" type="submit" disabled={busy}>Save</button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
