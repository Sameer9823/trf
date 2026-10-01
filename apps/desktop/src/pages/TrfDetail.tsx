import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Assignment, EmployeeProfile, TrfDetail, TrfStatus, TrfStatusHistoryEntry } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { messageOf } from '../lib/api';
import { assignmentApi, assignmentStatusLabel, assignmentStatusTone } from '../lib/assignments';
import { useAuth } from '../lib/auth';
import { BulkAssign } from '../components/BulkAssign';
import { OverdueBadge, PriorityBadge, StatusBadge, allowedNextStatuses, formatDate } from '../components/Badges';
import { OfflineNotice } from '../components/OfflineNotice';
import { useServerStatus } from '../lib/server-status';

type Tab = 'details' | 'history';

export function TrfDetailPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { state } = useServerStatus();
  const { can, employee } = useAuth();

  const [trf, setTrf] = useState<TrfDetail | null>(null);
  const [history, setHistory] = useState<TrfStatusHistoryEntry[]>([]);
  const [tab, setTab] = useState<Tab>('details');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assignTo, setAssignTo] = useState<string>('');
  const [assignables, setAssignables] = useState<EmployeeProfile[]>([]);
  const [tests, setTests] = useState<Assignment[]>([]);
  const [assigning, setAssigning] = useState(searchParams.get('assign') === '1');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await window.trf.request<TrfDetail>({ method: 'GET', path: `/api/trfs/${id}` });
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.status === 0 ? MESSAGES.SERVER_UNAVAILABLE : messageOf(res.data, 'This TRF could not be loaded.'));
      return;
    }
    setError(null);
    setTrf(res.data);
    setAssignTo(res.data.assignedEmployeeId ? String(res.data.assignedEmployeeId) : '');
  }, [id]);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    void load();
  }, [load, state]);

  useEffect(() => {
    void window.trf.request<{ items: EmployeeProfile[] }>({ method: 'GET', path: '/api/employees/assignable' })
      .then((r) => { if (r.ok && r.data) setAssignables(r.data.items); });
  }, []);

  useEffect(() => {
    if (state === 'offline') return;
    void window.trf.request<{ items: TrfStatusHistoryEntry[] }>({ method: 'GET', path: `/api/trfs/${id}/history` })
      .then((r) => { if (r.ok && r.data) setHistory(r.data.items); });
  }, [id, state, trf?.version, trf?.status]);

  useEffect(() => {
    if (state === 'offline') return;
    void assignmentApi.byTrf(Number(id)).then(setTests);
  }, [id, state, trf?.status, trf?.version]);

  const closeAssign = () => {
    setAssigning(false);
    if (searchParams.get('assign')) {
      const next = new URLSearchParams(searchParams);
      next.delete('assign');
      setSearchParams(next, { replace: true });
    }
  };

  async function changeStatus(next: TrfStatus) {
    if (!trf) return;
    setBusy(true);
    setActionError(null);
    setConflict(false);
    const res = await window.trf.request<TrfDetail>({
      method: 'POST', path: `/api/trfs/${trf.id}/status`,
      body: { status: next, version: trf.version },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      const message = messageOf(res.data, 'The status could not be changed.');
      setActionError(message);
      setConflict(message === MESSAGES.CONFLICT);
      return;
    }
    setTrf(res.data);
  }

  async function assign() {
    if (!trf) return;
    setBusy(true);
    setActionError(null);
    setConflict(false);
    const res = await window.trf.request<TrfDetail>({
      method: 'POST', path: `/api/trfs/${trf.id}/assign`,
      body: { assignedEmployeeId: assignTo ? Number(assignTo) : null, version: trf.version },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      const message = messageOf(res.data, 'The employee could not be assigned.');
      setActionError(message);
      setConflict(message === MESSAGES.CONFLICT);
      return;
    }
    setTrf(res.data);
  }

  if (state === 'offline') return <div className="page"><OfflineNotice /></div>;
  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !trf) return <div className="page"><p className="error-text">{error ?? MESSAGES.NOT_FOUND}</p></div>;

  const nextStatuses = allowedNextStatuses(trf.status);
  const editable = can('trf.edit') && trf.status !== 'Completed' && trf.status !== 'Cancelled';

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>
          {trf.trfNumber}
          <StatusBadge status={trf.status} />
          {trf.isOverdue && <OverdueBadge />}
        </h1>
        <div className="row">
          {editable && <a className="btn" href={`#/trfs/${trf.id}/edit`}>Edit</a>}
          <a className="btn" href="#/trf">Back to list</a>
        </div>
      </div>

      {actionError && (
        <div className="notice notice--error" role="alert">
          <p className="error-text">{actionError}</p>
          {conflict && (
            <div className="row">
              <button className="btn btn--primary" onClick={() => load()}>Reload this TRF</button>
              <span className="muted">Your change was not saved, so nothing was overwritten.</span>
            </div>
          )}
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${tab === 'details' ? 'tab--active' : ''}`} onClick={() => setTab('details')}>Details</button>
        <button className={`tab ${tab === 'history' ? 'tab--active' : ''}`} onClick={() => setTab('history')}>
          History{history.length > 0 ? ` (${history.length})` : ''}
        </button>
      </div>

      {tab === 'details' && (
        <>
          <dl className="facts facts--wide">
            <dt>TRF date</dt><dd>{formatDate(trf.trfDate)}</dd>
            <dt>Customer</dt><dd>{trf.customerName ?? '—'}</dd>
            <dt>Product</dt><dd>{trf.productName ?? '—'}</dd>
            <dt>Batch number</dt><dd>{trf.batchNumber ?? '—'}</dd>
            <dt>Sample quantity</dt><dd>{trf.sampleQuantity ?? '—'}</dd>
            <dt>Sample received</dt><dd>{formatDate(trf.sampleReceivedDate)}</dd>
            <dt>Required completion</dt><dd>{formatDate(trf.requiredCompletionDate)}</dd>
            <dt>Priority</dt><dd><PriorityBadge priority={trf.priority} /></dd>
            <dt>Assigned employee</dt><dd>{trf.assignedEmployeeName ?? 'Not assigned'}</dd>
            <dt>Department</dt><dd>{trf.departmentName ?? '—'}</dd>
            <dt>Created by</dt><dd>{trf.createdByName ?? '—'}</dd>
            <dt>Created</dt><dd>{new Date(trf.createdAt).toLocaleString()}</dd>
            <dt>Requested analysis</dt><dd className="pre">{trf.requestedAnalysis ?? '—'}</dd>
            <dt>Special instructions</dt><dd className="pre">{trf.specialInstructions ?? '—'}</dd>
            <dt>Remarks</dt><dd className="pre">{trf.remarks ?? '—'}</dd>
          </dl>

          <section className="panel">
            <div className="group__head">
              <h2>Assigned tests ({tests.length})</h2>
              {can('assignments.manage') && trf.status !== 'Completed' && trf.status !== 'Cancelled' && (
                <button className="btn btn--primary" onClick={() => setAssigning(true)}>Assign tests</button>
              )}
            </div>
            {tests.length === 0 ? (
              <p className="muted">
                No tests are assigned yet.
                {can('assignments.manage') ? ' Use “Assign tests” to give work to your analysts.' : ''}
              </p>
            ) : (
              <table className="table table--nested">
                <thead>
                  <tr><th>Test</th><th>Method</th><th>Specification</th><th>Employee</th><th>Due Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {tests.map((t) => (
                    <tr key={t.id}>
                      <td><strong>{t.testName}</strong></td>
                      <td>{t.testMethod ?? '—'}</td>
                      <td>{t.specification ?? '—'}</td>
                      <td>{t.assignedEmployeeName ?? '—'}</td>
                      <td>{formatDate(t.dueDate)}</td>
                      <td><span className={`badge ${assignmentStatusTone(t)}`}>{assignmentStatusLabel(t)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {can('trf.changeStatus') && (
            <section className="panel">
              <h2>Change status</h2>
              {nextStatuses.length === 0 ? (
                <p className="muted">This TRF is {trf.status}. Its status cannot change further.</p>
              ) : (
                <div className="row">
                  {nextStatuses.map((next) => (
                    <button key={next} className="btn" disabled={busy} onClick={() => changeStatus(next)}>
                      Move to {next}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {can('trf.assign') && (
            <section className="panel">
              <h2>Assign employee</h2>
              {trf.status === 'Completed' || trf.status === 'Cancelled' ? (
                <p className="muted">This TRF is {trf.status} and can no longer be assigned.</p>
              ) : (
                <div className="row">
                  <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Employee to assign">
                    <option value="">Not assigned</option>
                    {assignables.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.fullName}{a.role !== 'Analyst' ? ` (${a.role})` : ''}
                        {a.departmentName ? ` — ${a.departmentName}` : ''}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn--primary" disabled={busy} onClick={assign}>Assign</button>
                  {employee && <span className="muted">Changes are recorded in the audit log.</span>}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {tab === 'history' && (
        <table className="table">
          <thead>
            <tr><th>When</th><th>From</th><th>To</th><th>Changed by</th><th>Note</th></tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr><td colSpan={5} className="muted">No status changes recorded yet.</td></tr>
            )}
            {history.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.changedAt).toLocaleString()}</td>
                <td>{entry.oldStatus ?? '—'}</td>
                <td><StatusBadge status={entry.newStatus} /></td>
                <td>{entry.changedByName ?? '—'}</td>
                <td>{entry.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {assigning && (
        <BulkAssign trfId={trf.id} existing={tests} onClose={closeAssign}
          onAssigned={() => { closeAssign(); void load(); }} />
      )}
    </div>
  );
}
