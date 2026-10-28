import { FormEvent, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

interface ApiBody { error?: { code?: string; message?: string; fields?: Record<string, string> } }

export function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [tokenValid, setTokenValid] = useState(true);

  useEffect(() => {
    if (!token) {
      setTokenValid(false);
      setError('Invalid or missing reset token.');
    }
  }, [token]);

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
    const res = await window.trf.request<{ ok: boolean; message: string }>({
      method: 'POST', path: '/api/auth/reset-password', body: { token, newPassword },
    });
    setBusy(false);
    if (!res.ok) {
      const body = res.data as ApiBody | undefined;
      setFields(body?.error?.fields ?? {});
      setError(body?.error?.message ?? 'The password could not be reset.');
      return;
    }
    // Success - redirect to login
    navigate('/login', { replace: true, state: { message: res.data?.message } });
  }

  if (!tokenValid) {
    return (
      <div className="login">
        <div className="login__card">
          <h1 className="login__title">Invalid Reset Link</h1>
          <p className="error-text" role="alert">{error}</p>
          <p className="muted">This link may have expired or already been used.</p>
          <button className="btn btn--primary" onClick={() => navigate('/login', { replace: true })}>Back to Sign In</button>
          <p className="muted login__server">
            <a className="login__change" href="#/forgot-password">Request a new reset link</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1 className="login__title">Reset Password</h1>
        <p className="muted">Enter your new password. It must be at least 10 characters with a letter and a number.</p>

        {error && <p className="error-text" role="alert">{error}</p>}

        <label htmlFor="rp-new">New password</label>
        <input id="rp-new" type="password" autoComplete="new-password" value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)} />
        {fields.newPassword && <p className="field-error">{fields.newPassword}</p>}

        <label htmlFor="rp-confirm">Confirm new password</label>
        <input id="rp-confirm" type="password" autoComplete="new-password" value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)} />
        {fields.confirmPassword && <p className="field-error">{fields.confirmPassword}</p>}

        <button className="btn btn--primary login__submit" type="submit" disabled={busy}>
          {busy ? 'Resetting…' : 'Reset Password'}
        </button>

        <p className="muted login__server">
          <a className="login__change" href="#/login">Back to Sign In</a>
        </p>
      </form>
    </div>
  );
}