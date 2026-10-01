import { FormEvent, useEffect, useState } from 'react';
import { useServerStatus } from '../lib/server-status';
import { useAuth } from '../lib/auth';
import { Navigate } from 'react-router-dom';

export function Settings() {
  const { recheck, state } = useServerStatus();
  const { status, can } = useAuth();
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => { window.trf.getConfig().then((c) => setUrl(c.serverUrl)); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    const res = await window.trf.setServerUrl(url);
    if (!res.ok) return setMsg({ kind: 'error', text: res.message });
    setUrl(res.serverUrl);
    setMsg({ kind: 'ok', text: 'Server address saved.' });
    await recheck();
  }

  // Signed out, only the server address is settable: everything else needs Admin rights.
  if (status === 'signed-out') {
    return (
      <div className="login">
        <form className="login__card" onSubmit={save}>
          <h1 className="login__title">Server address</h1>
          <p className="muted">Set the address of the TRF API on the company network before signing in.</p>
          <label htmlFor="server-url">Server address</label>
          <input id="server-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://trf-server:4000" />
          {msg && <p className={msg.kind === 'ok' ? 'ok-text' : 'error-text'}>{msg.text}</p>}
          <div className="row modal__actions">
            <button className="btn btn--primary" type="submit">Save</button>
            <a className="btn" href="#/login">Back to sign-in</a>
            <span className={state === 'connected' ? 'ok-text' : 'error-text'}>
              {state === 'connected' ? 'Connected' : state === 'offline' ? 'Cannot reach the server at this address' : 'Checking…'}
            </span>
          </div>
        </form>
      </div>
    );
  }

  if (!can('settings.manage')) return <Navigate to="/" replace />;

  return (
    <div className="page">
      <h1>Settings</h1>
      <h2>Company server</h2>
      <form className="form" onSubmit={save}>
        <label htmlFor="server-url">Server address</label>
        <input id="server-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://trf-server:4000" />
        <p className="muted">The address of the TRF API on the company network. The database itself is never contacted from this PC.</p>
        <div className="row">
          <button className="btn btn--primary" type="submit">Save and test</button>
          <span className={state === 'connected' ? 'ok-text' : 'error-text'}>
            {state === 'connected' ? 'Connected' : state === 'offline' ? 'Cannot reach the server at this address' : 'Checking…'}
          </span>
        </div>
        {msg && <p className={msg.kind === 'ok' ? 'ok-text' : 'error-text'}>{msg.text}</p>}
      </form>
    </div>
  );
}
