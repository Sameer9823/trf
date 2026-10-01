import { FormEvent, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useNavigate } from 'react-router-dom';

interface ApiBody { error?: { code?: string; message?: string; fields?: Record<string, string> } }

/** Forced after an administrator resets a password or seeds the first administrator. */
export function ChangePassword() {
  const { employee, logout } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (newPassword !== confirmPassword) {
      setFields({ confirmPassword: 'The two passwords do not match.' });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    const res = await window.trf.request<{ ok: boolean }>({
      method: 'POST', path: '/api/auth/change-password', body: { currentPassword, newPassword },
    });
    setBusy(false);
    if (!res.ok) {
      const body = res.data as ApiBody | undefined;
      setFields(body?.error?.fields ?? {});
      setError(body?.error?.message ?? 'The password could not be changed.');
      return;
    }
    // Changing the password ends this session too, so sign in again with the new one.
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="page">
      <h1>Change your password</h1>
      <p className="muted">
        {employee?.fullName}, you must set a new password before using the system.
        Choose at least 10 characters with a letter and a number.
      </p>
      <form className="form" onSubmit={submit}>
        {error && <p className="error-text" role="alert">{error}</p>}

        <label htmlFor="cp-current">Current password</label>
        <input id="cp-current" type="password" autoComplete="current-password" value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)} />
        {fields.currentPassword && <p className="field-error">{fields.currentPassword}</p>}

        <label htmlFor="cp-new">New password</label>
        <input id="cp-new" type="password" autoComplete="new-password" value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)} />
        {fields.newPassword && <p className="field-error">{fields.newPassword}</p>}

        <label htmlFor="cp-confirm">Confirm new password</label>
        <input id="cp-confirm" type="password" autoComplete="new-password" value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)} />
        {fields.confirmPassword && <p className="field-error">{fields.confirmPassword}</p>}

        <div className="row">
          <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </div>
      </form>
    </div>
  );
}
