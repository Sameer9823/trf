import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { EmptyState, SkeletonRows, StatStrip } from '../components/StatStrip';
import type { StatTile } from '../components/StatStrip';
import { Icons } from '../components/Icons';
import { StatusBadge, formatDate } from '../components/Badges';
import { cardLink } from '../lib/dashboard';
import { ARD_TEST_ASSIGNMENT_STATUSES } from '@trf/shared';

interface ArdSummary {
  employeeId: number; fullName: string; employeeCode: string; designation: string | null;
  assignedTrfs: number; testsAssigned: number; assigned: number; inProgress: number;
  submitted: number; approved: number; rejected: number; overdue: number; completedTests: number;
}
interface ArdTestRow {
  assignmentId: number; assignmentVersion: number;
  trfId: number; trfNumber: string; arNumber: string | null; productName: string | null;
  testName: string; testStatus: string; reviewStatus: string | null;
  assignedDate: string | null; dueDate: string | null; isDelayed: boolean;
}
interface DetailResponse {
  summary: ArdSummary; items: ArdTestRow[]; total: number; page: number; pageSize: number; pageCount: number;
}

const REASSIGN_REASONS = ['Absent', 'On leave', 'Overloaded', 'Other'] as const;
interface EmployeeOption { id: number; fullName: string }

/** One ARD employee's workload: summary counts and a paginated test list. */
export function ArdEmployeeDetail() {
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
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(employeeId) || employeeId <= 0) { setNotFound(true); setLoading(false); return; }
    setLoading(true);
    setError(null);
    setNotFound(false);
    const query = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (status) query.set('status', status);
    if (search.trim()) query.set('search', search.trim());
    const res = await window.trf.request<DetailResponse>({
      method: 'GET', path: `/api/ard-assignments/employees/${employeeId}?${query.toString()}`,
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
        <Link className="link" to="/ard">← Back to ARD team</Link>
        <EmptyState icon={Icons.employees} title="Employee not found" text="This ARD employee does not exist or is no longer active." />
      </div>
    );
  }

  const summary = data?.summary;
  const tiles: StatTile[] = summary ? [
    { label: 'TRFs', value: summary.assignedTrfs },
    { label: 'Tests assigned', value: summary.testsAssigned },
    { label: 'In progress', value: summary.inProgress, tone: 'info' },
    { label: 'Submitted', value: summary.submitted, tone: 'warn' },
    { label: 'Approved', value: summary.approved, tone: 'ok' },
    { label: 'Rejected', value: summary.rejected, tone: 'danger' },
    { label: 'Completed', value: summary.completedTests, tone: 'ok' },
    { label: 'Overdue', value: summary.overdue, tone: 'danger' },
  ] : [];

  return (
    <div className="page page--wide">
      <Link className="link" to="/ard">← Back to ARD team</Link>
      <div className="page__head">
        <div>
          <h1>{summary ? summary.fullName : 'ARD employee'}</h1>
          <p className="muted">
            {summary ? `${summary.employeeCode}${summary.designation ? ` · ${summary.designation}` : ''}` : 'Loading…'}
          </p>
        </div>
        <div className="filters">
          <select value={status} aria-label="Filter by status"
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {ARD_TEST_ASSIGNMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="Overdue">Overdue</option>
          </select>
          <input placeholder="Search TRF, A.R. no., product or test" value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search tests" />
          {summary && summary.testsAssigned > 0 && (
            <button type="button" className="btn btn--primary" onClick={() => setBulkOpen(true)}>
              Reassign all open tests
            </button>
          )}
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
              <thead><tr><th>TRF</th><th>A.R. no.</th><th>Product</th><th>Test</th><th>Status</th><th>Review</th><th>Assigned</th><th>Due</th><th>Delayed</th></tr></thead>
              <tbody><SkeletonRows cols={9} rows={3} /></tbody>
            </table>
          </div>
        )}

        {!loading && data && data.items.length === 0 && (
          <EmptyState icon={Icons.trf} title="No tests" text="No test assignments match this view for this employee." />
        )}

        {!loading && data && data.items.length > 0 && (
          <div className="table-wrap">
            <table className="table table--striped">
              <thead>
                <tr><th>TRF</th><th>A.R. no.</th><th>Product</th><th>Test</th><th>Status</th><th>Review</th><th>Assigned</th><th>Due</th><th>Delayed</th></tr>
              </thead>
              <tbody>
                {data.items.map((t, i) => (
                  <tr key={`${t.trfId}-${t.testName}-${i}`}>
                    <td><a className="link nowrap" href={`#/trfs/${t.trfId}`}>{t.trfNumber}</a></td>
                    <td className="muted-cell">{t.arNumber ?? '—'}</td>
                    <td className="muted-cell"><span className="truncate" title={t.productName ?? ''}>{t.productName ?? '—'}</span></td>
                    <td>{t.testName}</td>
                    <td><StatusBadge status={t.testStatus as never} /></td>
                    <td>{t.reviewStatus ?? '—'}</td>
                    <td className="nowrap">{formatDate(t.assignedDate)}</td>
                    <td className="nowrap">{formatDate(t.dueDate)}</td>
                    <td>{t.isDelayed && t.testStatus !== 'Completed' && t.testStatus !== 'Cancelled'
                      ? <span className="badge badge--danger">Delayed</span> : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > 0 && (
          <div className="pager">
            <span className="muted">{data.total} test(s) · page {data.page} of {data.pageCount}</span>
            <span className="row">
              <button className="btn" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
              <button className="btn" disabled={data.page >= data.pageCount} onClick={() => setPage(data.page + 1)}>Next</button>
            </span>
          </div>
        )}
      </section>

      {summary && (
        <p><a className="link" href={cardLink('assignments', { employeeId: summary.employeeId })}>Open in Assignments →</a></p>
      )}

      {bulkOpen && summary && (
        <BulkReassignDialog
          employeeId={summary.employeeId}
          employeeName={summary.fullName}
          onClose={() => setBulkOpen(false)}
          onSaved={async () => { setBulkOpen(false); await load(); }}
        />
      )}
    </div>
  );
}

/** Move every open test of an absent analyst to one replacement, in one call. */
export function BulkReassignDialog({ employeeId, employeeName, onClose, onSaved }: {
  employeeId: number; employeeName: string; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [items, setItems] = useState<ArdTestRow[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [toId, setToId] = useState('');
  const [reasonKind, setReasonKind] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.trf.request<DetailResponse>({
      method: 'GET', path: `/api/ard-assignments/employees/${employeeId}?pageSize=200`,
    }).then((r) => {
      if (cancelled || !r.ok || !r.data) return;
      setItems(r.data.items.filter((t) => t.testStatus !== 'Completed' && t.testStatus !== 'Cancelled'));
    });
    void window.trf.request<{ items: EmployeeOption[] }>({ method: 'GET', path: '/api/lookups/ard-analysts' }).then((r) => {
      if (!cancelled && r.ok && r.data) setEmployees(r.data.items.filter((e) => e.id !== employeeId));
    });
    return () => { cancelled = true; };
  }, [employeeId]);

  const reason = reasonKind === 'Other' ? reasonText.trim() : reasonKind;
  const canSubmit = !!toId && !!reason && !busy && items !== null && items.length > 0;

  const submit = async () => {
    if (!canSubmit || !items) return;
    setBusy(true);
    setError(null);
    const res = await window.trf.request({
      method: 'POST', path: '/api/ard-assignments/reassign-bulk',
      body: { reason, items: items.map((t) => ({ assignmentId: t.assignmentId, version: t.assignmentVersion, analystIds: [Number(toId)] })) },
    });
    setBusy(false);
    if (!res.ok) { setError(res.error || 'The tests could not be reassigned.'); return; }
    await onSaved();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Reassign all open tests">
      <div className="modal">
        <div className="modal__head">
          <h3>Reassign all open tests from {employeeName}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          <p className="muted">{items === null ? 'Loading open tests…' : `${items.length} open test(s) will move to the replacement below.`}</p>
          <label htmlFor="bulk-to">Replacement analyst</label>
          <select id="bulk-to" value={toId} disabled={busy} onChange={(e) => setToId(e.target.value)}>
            <option value="">Select an analyst…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
          </select>
          <label htmlFor="bulk-reason">Reason (required)</label>
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
            {REASSIGN_REASONS.map((r) => (
              <button key={r} type="button" className={`btn btn--sm ${reasonKind === r ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setReasonKind(r)}>{r}</button>
            ))}
          </div>
          {reasonKind === 'Other'
            ? <textarea id="bulk-reason" rows={2} value={reasonText} disabled={busy} onChange={(e) => setReasonText(e.target.value)} placeholder="Tell the team why." />
            : <input id="bulk-reason" value={reasonKind} disabled readOnly placeholder="Choose a reason above." />}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <div className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
            {busy ? 'Reassigning…' : 'Reassign all'}
          </button>
        </div>
      </div>
    </div>
  );
}