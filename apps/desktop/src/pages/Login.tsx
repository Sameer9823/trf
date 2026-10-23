import { FormEvent, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { useNavigate, useLocation } from 'react-router-dom';

export function Login() {
  const { login } = useAuth();
  const { state, serverUrl } = useServerStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Check for success message from password reset
  const successMessage = (location.state as { message?: string })?.message;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await login(username.trim(), password);
      // The server's message is shown as it is, including the locked-account case.
      if (!result.ok) setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1 className="login__title">TRF Management System</h1>
        <p className="muted">Sign in with your company account.</p>

        {successMessage && <p className="success-text" role="status">{successMessage}</p>}

        <label htmlFor="login-username">Username or email</label>
        <input id="login-username" autoFocus autoComplete="username" value={username}
          onChange={(e) => setUsername(e.target.value)} />

        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} />

        {error && <p className="error-text" role="alert">{error}</p>}

        <button className="btn btn--primary login__submit" type="submit" disabled={busy || state === 'offline'}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="muted login__forgot">
          <a href="#/forgot-password">Forgot password?</a>
        </p>

        {state === 'offline' && (
          <p className="error-text">Company server is unavailable. Please connect to the company network.</p>
        )}
        <p className="muted login__server">
          Server: {serverUrl || '…'}
          <a className="login__change" href="#/settings">Change</a>
        </p>
      </form>
    </div>
  );
}
