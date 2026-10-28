import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrfListItem, Paginated } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { formatDate } from '../components/Badges';

/** The administrator's queue: every TRF waiting on a decision. */
export function Approvals() {
  const [items, setItems] = useState<TrfListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.trf.request<Paginated<TrfListItem>>({ method: 'GET', path: '/api/trfs?approval=pending&pageSize=100&sortBy=trfDate&sortDir=asc' })
      .then((res) => {
        if (res.ok && res.data) setItems(res.data.items);
        else setError(res.status === 0 ? MESSAGES.SERVER_UNAVAILABLE : 'The approvals could not be loaded.');
      });
  }, []);

  return (
    <div className="page">
      <div className="page__head"><h1>Approvals</h1></div>
      <p className="muted">Requests waiting for your decision, oldest first. Open one to approve, reject or send it back.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items && items.length === 0 && <p className="muted">Nothing is waiting for approval.</p>}
      {items && items.length > 0 && (
        <table className="table">
          <thead><tr><th>TRF</th><th>Product</th><th>Batch</th><th>Date of request</th><th>Waiting for</th><th /></tr></thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/trfs/${t.id}`}>{t.trfNumber}</Link></td>
                <td>{t.productName ?? '—'}</td>
                <td>{t.batchNumber ?? '—'}</td>
                <td>{formatDate(t.trfDate)}</td>
                <td>{t.remarksStatus === 'Pending' ? 'Request approval' : 'Final approval'}</td>
                <td><Link className="btn" to={`/trfs/${t.id}`}>Review</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
