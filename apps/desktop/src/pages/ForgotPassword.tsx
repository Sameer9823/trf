import { FormEvent, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useNavigate, useSearchParams } from 'react-router-dom';

interface ApiBody { error?: { code?: string; message?: string; fields?: Record<string, string> } }

export function ForgotPassword() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await window.trf.request<{ ok: boolean; message: string }>({
      method: 'POST', path: '/api/auth/forgot-password', body: { email: email.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      const body = res.data as ApiBody | undefined;
      setError(body?.error?.message ?? 'Could not send reset email.');
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="login">
        <div className="login__card">
          <h1 className="login__title">Check Your Email</h1>
          <p className="muted">If an account with that email exists, a password reset link has been sent.</p>
          <p className="muted">The link will expire in 2 hours.</p>
          <button className="btn btn--primary" onClick={() => navigate('/login', { replace: true })}>Back to Sign In</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1 className="login__title">Forgot Password</h1>
        <p className="muted">Enter your email address and we'll send you a link to reset your password.</p>

        <label htmlFor="fp-email">Email</label>
        <input id="fp-email" type="email" autoComplete="email" value={email}
          onChange={(e) => setEmail(e.target.value)} />

        {error && <p className="error-text" role="alert">{error}</p>}

        <button className="btn btn--primary login__submit" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send Reset Link'}
        </button>

        <p className="muted login__server">
          <a className="login__change" href="#/login">Back to Sign In</a>
        </p>
      </form>
    </div>
  );
}