import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrfListItem, Paginated, ResultReviewQueueItem } from '@trf/shared';
import { MESSAGES, isAdminDesignation } from '@trf/shared';
import { formatDate } from '../components/Badges';
import { useAuth } from '../lib/auth';
import { ReviewResultModal, ResultFileButton, type ReviewTarget } from '../components/ResultReview';

/** The administrator's queue: every TRF waiting on a decision. */
export function Approvals() {
  const { employee } = useAuth();
  const [items, setItems] = useState<TrfListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultReviewQueueItem[] | null>(null);
  const [reviewing, setReviewing] = useState<ReviewTarget | null>(null);
  const [search, setSearch] = useState('');
  const isAgm = employee?.role === 'Admin' && isAdminDesignation(employee?.designation);
  const query = search.trim().toLowerCase();
  const visibleResults = (results ?? []).filter((r) => !query
    || [r.trfNumber, r.arNumber, r.productName, r.testName, r.resultValue, r.resultText, r.submittedByName].filter(Boolean).join(' ').toLowerCase().includes(query));
  const visibleItems = (items ?? []).filter((t) => !query
    || [t.trfNumber, t.ardNumber, t.productName, t.batchNumber].filter(Boolean).join(' ').toLowerCase().includes(query));

  const loadQueue = useCallback(() => {
    void window.trf.request<Paginated<TrfListItem>>({ method: 'GET', path: '/api/trfs?approval=pending&pageSize=100&sortBy=trfDate&sortDir=desc' })
      .then((res) => {
        if (res.ok && res.data) setItems(res.data.items);
        else setError(res.status === 0 ? MESSAGES.SERVER_UNAVAILABLE : 'The approvals could not be loaded.');
      });
    if (isAgm) {
      void window.trf.request<{ items: ResultReviewQueueItem[] }>({ method: 'GET', path: '/api/ard-assignments/result-reviews' })
        .then((res) => { if (res.ok && res.data) setResults(res.data.items); });
    }
  }, [isAgm]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  return (
    <div className="page">
      <div className="page__head"><h1>Approvals</h1></div>
      <div className="filters">
        <input placeholder="Search TRF, product, batch or test" value={search}
          onChange={(e) => setSearch(e.target.value)} aria-label="Search approvals" />
      </div>
      {isAgm && results && results.length > 0 && (
        <section className="panel">
          <h2>Test results waiting for your review</h2>
          <p className="muted">Approve a result to complete its test; reject it with a reason and the employee corrects and resubmits it. When every result on a TRF is approved, the TRF comes back here to be completed.</p>
          {visibleResults.length === 0 && <p className="muted">No results match “{search}”.</p>}
          <table className="table">
            <thead><tr><th>TRF</th><th>A.R. No.</th><th>Product</th><th>Test</th><th>Result</th><th>Outcome</th><th>Submitted by</th><th /></tr></thead>
            <tbody>
              {visibleResults.map((r) => (
                <tr key={r.assignmentId}>
                  <td><Link to={`/trfs/${r.trfId}`}>{r.trfNumber}</Link></td>
                  <td>{r.arNumber ?? '—'}</td>
                  <td>{r.productName ?? '—'}</td>
                  <td>{r.testName}</td>
                  <td>{r.resultMode === 'pdf' && r.fileName ? <ResultFileButton assignmentId={r.assignmentId} fileName={r.fileName} /> : ([r.resultValue, r.unit].filter(Boolean).join(' ') || r.resultText || '—')}</td>
                  <td>{r.outcome ?? '—'}</td>
                  <td>{r.submittedByName ?? '—'}{r.submittedAt ? `, ${formatDate(r.submittedAt)}` : ''}</td>
                  <td><button className="btn btn--primary" onClick={() => setReviewing({
                    assignmentId: r.assignmentId, version: r.assignmentVersion, testName: r.testName, trfNumber: r.trfNumber,
                    resultValue: r.resultValue, resultText: r.resultText, unit: r.unit, outcome: r.outcome, submittedByName: r.submittedByName,
                  })}>Review</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <ReviewResultModal target={reviewing} onClose={() => setReviewing(null)} onDone={() => loadQueue()} />
      <p className="muted">Requests waiting for your decision, newest first. Open one to approve, reject or send it back.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items && items.length === 0 && <p className="muted">Nothing is waiting for approval.</p>}
      {items && items.length > 0 && visibleItems.length === 0 && <p className="muted">No requests match “{search}”.</p>}
      {visibleItems.length > 0 && (
        <table className="table">
          <thead><tr><th>TRF</th><th>A.R. No.</th><th>Product</th><th>Batch</th><th>Date of request</th><th>Waiting for</th><th /></tr></thead>
          <tbody>
            {visibleItems.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/trfs/${t.id}`}>{t.trfNumber}</Link></td>
                <td>{t.ardNumber ?? '—'}</td>
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
