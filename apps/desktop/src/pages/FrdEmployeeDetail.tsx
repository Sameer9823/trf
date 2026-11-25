import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TRF_STATUSES } from '@trf/shared';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { EmptyState, SkeletonRows, StatStrip } from '../components/StatStrip';
import type { StatTile } from '../components/StatStrip';
import { Icons } from '../components/Icons';
import { PriorityBadge, StatusBadge, formatDate } from '../components/Badges';
import { cardLink } from '../lib/dashboard';

interface FrdSummary {
  employeeId: number; fullName: string; employeeCode: string; designation: string | null;
  trfsCreated: number; new: number; assigned: number; inProgress: number; analysisCompleted: number;
  coaPending: number; completed: number; cancelled: number; createdThisMonth: number; lastCreatedAt: string | null;
}
interface FrdTrfRow {
  trfId: number; trfNumber: string; trfDate: string | null; productName: string | null;
  customerName: string | null; batchNumber: string | null; status: string; priority: string;
  assignedAnalystNames: string | null; dueDate: string | null;
}
interface DetailResponse {
  summary: FrdSummary; items: FrdTrfRow[]; total: number; page: number; pageSize: number; pageCount: number;
}

/** One FRD employee's created TRFs: summary counts and a paginated list. */
export function FrdEmployeeDetail() {
  const { id } = useParams();
  const employeeId = Number(id);
  const { state } = useServerStatus();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    if (!Number.isInteger(employeeId) || employeeId <= 0) { setNotFound(true); setLoading(false); return; }
    setLoading(true);
    setError(null);
    setNotFound(false);
    const query = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (status) query.set('status', status);
    if (search.trim()) query.set('search', search.trim());
    const res = await window.trf.request<DetailResponse>({
      method: 'GET', path: `/api/frd/employees/${employeeId}?${query.toString()}`,
    });
    setLoading(false);
    if (res.status === 404) { setNotFound(true); setData(null); return; }
    if (!res.ok || !res.data) { setError(res.error || 'Could not load this employee.'); setData(null); return; }
    setData(res.data);
  }, [employeeId, page, status, search]);

  useEffect(() => {
    if (state === 'offline') return;
    void load();
  }, [state, load]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  if (notFound) {
    return (
      <div className="page page--wide">
        <Link className="link" to="/frd">← Back to FRD team</Link>
        <EmptyState icon={Icons.employees} title="Employee not found" text="This FRD employee does not exist or is no longer active." />
      </div>
    );
  }

  const summary = data?.summary;
  const tiles: StatTile[] = summary ? [
    { label: 'TRFs created', value: summary.trfsCreated },
    { label: 'New', value: summary.new },
    { label: 'Assigned', value: summary.assigned, tone: 'info' },
    { label: 'In progress', value: summary.inProgress, tone: 'info' },
    { label: 'Analysis completed', value: summary.analysisCompleted },
    { label: 'COA pending', value: summary.coaPending, tone: 'warn' },
    { label: 'Completed', value: summary.completed, tone: 'ok' },
    { label: 'Cancelled', value: summary.cancelled },
  ] : [];

  return (
    <div className="page page--wide">
      <Link className="link" to="/frd">← Back to FRD team</Link>
      <div className="page__head">
        <div>
          <h1>{summary ? summary.fullName : 'FRD employee'}</h1>
          <p className="muted">
            {summary ? `${summary.employeeCode}${summary.designation ? ` · ${summary.designation}` : ''}` : 'Loading…'}
          </p>
        </div>
        <div className="filters">
          <select value={status} aria-label="Filter by status"
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {TRF_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input placeholder="Search TRF, product, customer or batch" value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search TRFs" />
        </div>
      </div>

      {error && (
        <div className="notice notice--error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn--primary" onClick={() => void load()}>Try again</button>
        </div>
      )}

      {!loading && summary && <StatStrip tiles={tiles} />}

      <section className="card">
        {loading && (
          <div className="table-wrap">
            <table className="table table--striped">
              <thead><tr><th>TRF</th><th>Date</th><th>Product</th><th>Customer</th><th>Batch</th><th>Status</th><th>Priority</th><th>Analysts</th><th>Due</th></tr></thead>
              <tbody><SkeletonRows cols={9} rows={3} /></tbody>
            </table>
          </div>
        )}

        {!loading && data && data.items.length === 0 && (
          <EmptyState icon={Icons.trf} title="No TRFs" text="No TRFs match this view for this employee." />
        )}

        {!loading && data && data.items.length > 0 && (
          <div className="table-wrap">
            <table className="table table--striped">
              <thead>
                <tr><th>TRF</th><th>Date</th><th>Product</th><th>Customer</th><th>Batch</th><th>Status</th><th>Priority</th><th>Analysts</th><th>Due</th></tr>
              </thead>
              <tbody>
                {data.items.map((t) => (
                  <tr key={t.trfId}>
                    <td><a className="link nowrap" href={`#/trfs/${t.trfId}`}>{t.trfNumber}</a></td>
                    <td className="nowrap">{formatDate(t.trfDate)}</td>
                    <td className="muted-cell"><span className="truncate" title={t.productName ?? ''}>{t.productName ?? '—'}</span></td>
                    <td className="muted-cell"><span className="truncate" title={t.customerName ?? ''}>{t.customerName ?? '—'}</span></td>
                    <td className="muted-cell">{t.batchNumber ?? '—'}</td>
                    <td><StatusBadge status={t.status as never} /></td>
                    <td><PriorityBadge priority={t.priority as never} /></td>
                    <td className="muted-cell"><span className="truncate" title={t.assignedAnalystNames ?? ''}>{t.assignedAnalystNames ?? '—'}</span></td>
                    <td className="nowrap">{formatDate(t.dueDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > 0 && (
          <div className="pager">
            <span className="muted">{data.total} TRF(s) · page {data.page} of {data.pageCount}</span>
            <span className="row">
              <button className="btn" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
              <button className="btn" disabled={data.page >= data.pageCount} onClick={() => setPage(data.page + 1)}>Next</button>
            </span>
          </div>
        )}
      </section>

      {summary && (
        <p><a className="link" href={cardLink('trf', { createdBy: summary.employeeId })}>View all in TRF Management →</a></p>
      )}
    </div>
  );
}