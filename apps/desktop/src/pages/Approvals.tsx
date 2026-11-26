import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { TrfListItem, Paginated, ResultReviewQueueItem } from '@trf/shared';
import { MESSAGES, canReviewArdResults } from '@trf/shared';
import { formatDate } from '../components/Badges';
import { Icons } from '../components/Icons';
import { EmptyState } from '../components/StatStrip';
import { useAuth } from '../lib/auth';
import { ReviewResultModal, ResultFileButton, type ReviewTarget } from '../components/ResultReview';

/** One card on the approvals page: a titled head with a live count, and a body. */
function ListCard({ title, description, count, children }: {
  title: string;
  description?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="list-card">
      <div className="list-card__head">
        <div className="list-card__titles">
          <h2>{title}</h2>
          {description && <p className="list-card__desc muted">{description}</p>}
        </div>
        {count != null && <span className="list-card__count" aria-label={`${count} items`}>{count}</span>}
      </div>
      <div className="list-card__body">{children}</div>
    </section>
  );
}

/** The administrator's queue: every TRF waiting on a decision. */
export function Approvals() {
  const { employee } = useAuth();
  const [items, setItems] = useState<TrfListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultReviewQueueItem[] | null>(null);
  const [reviewing, setReviewing] = useState<ReviewTarget | null>(null);
  const [search, setSearch] = useState('');
  const isAgm = canReviewArdResults(employee);
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
    <div className="approvals">
      <div className="page__head"><h1>Approvals</h1></div>
      <div className="filters">
        <input placeholder="Search TRF, product, batch or test" value={search}
          onChange={(e) => setSearch(e.target.value)} aria-label="Search approvals" />
      </div>

      {isAgm && (
        <ListCard
          title="Test results waiting for your review"
          description="Approve a result to complete its test; reject it with a reason and the employee corrects and resubmits it. When every result on a TRF is approved, the TRF comes back here to be completed."
          count={results == null ? undefined : visibleResults.length}
        >
          {results == null && !error && <p className="muted">Loading…</p>}
          {results != null && visibleResults.length === 0 && (
            <EmptyState
              icon={Icons.approvals}
              title={query ? 'No results match' : 'No results waiting'}
              text={query ? `No results match “${search}”.` : 'There are no test results waiting for your review.'}
            />
          )}
          {visibleResults.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>TRF</th><th>A.R. No.</th><th className="col-wrap">Product</th><th className="col-wrap">Test</th><th>Result</th><th>Outcome</th><th className="col-wrap">Submitted by</th><th className="col-actions" /></tr>
                </thead>
                <tbody>
                  {visibleResults.map((r) => (
                    <tr key={r.assignmentId}>
                      <td><Link to={`/trfs/${r.trfId}`}>{r.trfNumber}</Link></td>
                      <td>{r.arNumber ?? '—'}</td>
                      <td className="col-wrap">{r.productName ?? '—'}</td>
                      <td className="col-wrap">{r.testName}</td>
                      <td>{r.resultMode === 'pdf' && r.fileName ? <ResultFileButton assignmentId={r.assignmentId} fileName={r.fileName} /> : ([r.resultValue, r.unit].filter(Boolean).join(' ') || r.resultText || '—')}</td>
                      <td>{r.outcome ?? '—'}</td>
                      <td className="col-wrap">{r.submittedByName ?? '—'}{r.submittedAt ? `, ${formatDate(r.submittedAt)}` : ''}</td>
                      <td className="col-actions"><button className="btn btn--primary" onClick={() => setReviewing({
                        assignmentId: r.assignmentId, version: r.assignmentVersion, testName: r.testName, trfNumber: r.trfNumber,
                        resultValue: r.resultValue, resultText: r.resultText, unit: r.unit, outcome: r.outcome, submittedByName: r.submittedByName,
                        fileName: r.fileName ?? null, resultMode: r.resultMode ?? null,
                        methodUsed: r.methodUsed ?? null, specification: r.specification ?? null, remarks: r.remarks ?? null,
                        analysisStartDate: r.analysisStartDate ?? null, completionDate: r.completionDate ?? null,
                      })}>Review</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ListCard>
      )}

      <ReviewResultModal target={reviewing} onClose={() => setReviewing(null)} onDone={() => loadQueue()} />

      <ListCard
        title="Requests waiting for your decision"
        description="Newest first. Open one to approve, reject or send it back."
        count={items == null ? undefined : visibleItems.length}
      >
        {error && <p className="error-text" role="alert">{error}</p>}
        {items == null && !error && <p className="muted">Loading…</p>}
        {items != null && visibleItems.length === 0 && (
          <EmptyState
            icon={Icons.approvals}
            title={query ? 'No requests match' : 'Nothing is waiting'}
            text={query ? `No requests match “${search}”.` : 'There are no TRFs waiting for your approval.'}
          />
        )}
        {visibleItems.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>TRF</th><th>A.R. No.</th><th className="col-wrap">Product</th><th>Batch</th><th>Date of request</th><th>Waiting for</th><th className="col-actions" /></tr>
              </thead>
              <tbody>
                {visibleItems.map((t) => (
                  <tr key={t.id}>
                    <td><Link to={`/trfs/${t.id}`}>{t.trfNumber}</Link></td>
                    <td>{t.ardNumber ?? '—'}</td>
                    <td className="col-wrap">{t.productName ?? '—'}</td>
                    <td>{t.batchNumber ?? '—'}</td>
                    <td>{formatDate(t.trfDate)}</td>
                    <td>{t.remarksStatus === 'Pending' ? 'Request approval' : 'Final approval'}</td>
                    <td className="col-actions"><Link className="btn" to={`/trfs/${t.id}`}>Review</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ListCard>
    </div>
  );
}