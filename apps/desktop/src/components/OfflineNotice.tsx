import { Link } from 'react-router-dom';
import { useServerStatus } from '../lib/server-status';

export function OfflineNotice() {
  const { recheck, serverUrl, lastChecked } = useServerStatus();
  return (
    <div className="notice notice--error">
      <h1>Company server is unavailable</h1>
      <p>Please connect to the company network.</p>
      <p className="muted">
        Trying: {serverUrl || '…'}{lastChecked ? ` · last attempt ${lastChecked.toLocaleTimeString()}` : ''}
      </p>
      <div className="row">
        <button className="btn btn--primary" onClick={() => recheck()}>Try again</button>
        <Link className="btn" to="/settings">Server settings</Link>
      </div>
    </div>
  );
}
