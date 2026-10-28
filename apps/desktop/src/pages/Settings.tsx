import { FormEvent, useEffect, useState } from 'react';
import { useServerStatus } from '../lib/server-status';
import { useAuth } from '../lib/auth';
import { Navigate } from 'react-router-dom';

interface FormSettings {
  sopNo: string;
  revision: string;
  effectiveDate: string;
  issuedBy: string;
  department: string;
}

export function Settings() {
  const { recheck, state } = useServerStatus();
  const { status, can } = useAuth();
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [formSettings, setFormSettings] = useState<FormSettings | null>(null);
  const [formMsg, setFormMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [formSaving, setFormSaving] = useState(false);

  useEffect(() => { window.trf.getConfig().then((c) => setUrl(c.serverUrl)); }, []);

  useEffect(() => {
    if (can('trf.view')) {
      void window.trf.request<FormSettings>({ method: 'GET', path: '/api/settings/form' })
        .then((res) => { if (res.ok && res.data) setFormSettings(res.data); });
    }
  }, [can]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const res = await window.trf.setServerUrl(url);
    if (!res.ok) return setMsg({ kind: 'error', text: res.message ?? 'Failed to save.' });
    if (res.serverUrl) setUrl(res.serverUrl);
    setMsg({ kind: 'ok', text: 'Server address saved.' });
    await recheck();
  }

  async function saveForm(e: FormEvent) {
    e.preventDefault();
    if (!formSettings) return;
    setFormSaving(true);
    setFormMsg(null);
    try {
      const keys = ['FORM_SOP_NO', 'FORM_REVISION', 'FORM_EFFECTIVE_DATE', 'FORM_ISSUED_BY', 'FORM_DEPARTMENT'] as const;
      const values = [formSettings.sopNo, formSettings.revision, formSettings.effectiveDate, formSettings.issuedBy, formSettings.department];
      for (let i = 0; i < keys.length; i++) {
        const res = await window.trf.request({ method: 'PATCH', path: `/api/settings/${keys[i]}`, body: { value: values[i] } });
        if (!res.ok) {
          const msg = (res as { error?: string | { message?: string } }).error;
          throw new Error(typeof msg === 'string' ? msg : msg?.message ?? 'Failed to save form setting.');
        }
      }
      setFormMsg({ kind: 'ok', text: 'Form settings saved.' });
    } catch (err) {
      setFormMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setFormSaving(false);
    }
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

      {formSettings && (
        <section style={{ marginTop: 24 }}>
          <h2>Test Request Form (Print Header)</h2>
          <p className="muted">These values appear in the header of the printed Test Request Form (QAGN:003:F1).</p>
          <form className="form" onSubmit={saveForm}>
            <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div className="field">
                <label htmlFor="form-sop-no">SOP No.</label>
                <input id="form-sop-no" value={formSettings.sopNo} onChange={(e) => setFormSettings(s => s ? { ...s, sopNo: e.target.value } : null)} />
              </div>
              <div className="field">
                <label htmlFor="form-revision">Revision No.</label>
                <input id="form-revision" value={formSettings.revision} onChange={(e) => setFormSettings(s => s ? { ...s, revision: e.target.value } : null)} />
              </div>
              <div className="field">
                <label htmlFor="form-effective-date">Effective Date</label>
                <input id="form-effective-date" type="date" value={formSettings.effectiveDate} onChange={(e) => setFormSettings(s => s ? { ...s, effectiveDate: e.target.value } : null)} />
              </div>
              <div className="field">
                <label htmlFor="form-issued-by">Issued By / Sign/Date</label>
                <input id="form-issued-by" value={formSettings.issuedBy} onChange={(e) => setFormSettings(s => s ? { ...s, issuedBy: e.target.value } : null)} />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="form-department">Department</label>
                <input id="form-department" value={formSettings.department} onChange={(e) => setFormSettings(s => s ? { ...s, department: e.target.value } : null)} />
              </div>
            </div>
            <div className="row">
              <button className="btn btn--primary" type="submit" disabled={formSaving}>{formSaving ? 'Saving…' : 'Save form settings'}</button>
            </div>
            {formMsg && <p className={formMsg.kind === 'ok' ? 'ok-text' : 'error-text'}>{formMsg.text}</p>}
          </form>
        </section>
      )}
    </div>
  );
}