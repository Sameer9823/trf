import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Assignment, ArdWorkflowStatus, EmployeeProfile, TrfDetail, TrfStatus, TrfStatusHistoryEntry, ArdStatusHistoryEntry } from '@trf/shared';
import { MESSAGES, canEditTrfPartA, canEditTrfPartB, canDeleteTrf } from '@trf/shared';
import { messageOf } from '../lib/api';
import { assignmentApi, assignmentStatusLabel, assignmentStatusTone } from '../lib/assignments';
import { useAuth } from '../lib/auth';
import { BulkAssign } from '../components/BulkAssign';
import { OverdueBadge, PriorityBadge, StatusBadge, ArdWorkflowBadge, ArdCoaBadge, allowedNextStatuses, allowedNextArdStatuses, formatDate } from '../components/Badges';
import { OfflineNotice } from '../components/OfflineNotice';
import { useServerStatus } from '../lib/server-status';
import { RemarksStatusBadge, ArdRemarksStatusBadge } from '../components/Badges';

type Tab = 'details' | 'history' | 'ard-history';

export function TrfDetailPage() {
   const { id } = useParams();
   const navigate = useNavigate();
   const [searchParams, setSearchParams] = useSearchParams();
  const { state } = useServerStatus();
  const { can, employee } = useAuth();

  const [trf, setTrf] = useState<TrfDetail | null>(null);
  const [history, setHistory] = useState<TrfStatusHistoryEntry[]>([]);
  const [ardHistory, setArdHistory] = useState<ArdStatusHistoryEntry[]>([]);
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
    void window.trf.request<{ items: ArdStatusHistoryEntry[] }>({ method: 'GET', path: `/api/trfs/${id}/ard-history` })
      .then((r) => { if (r.ok && r.data) setArdHistory(r.data.items); });
  }, [id, state, trf?.version, trf?.workflowStatus]);

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

  async function changeArdStatus(next: ArdWorkflowStatus) {
    if (!trf) return;
    setBusy(true);
    setActionError(null);
    setConflict(false);
    const res = await window.trf.request<TrfDetail>({
      method: 'POST', path: `/api/trfs/${trf.id}/ard-status`,
      body: { status: next, version: trf.version },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      const message = messageOf(res.data, 'The ARD status could not be changed.');
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
  const nextArdStatuses = allowedNextArdStatuses(trf.workflowStatus);
  const canEditA = employee ? canEditTrfPartA(employee) : false;
  const canEditB = employee ? canEditTrfPartB(employee) : false;
  const editable = (canEditA || canEditB) && trf.status !== 'Completed' && trf.status !== 'Cancelled';
  const canDelete = employee && canDeleteTrf(employee) && trf.status === 'New';

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
          {editable && <a className="btn" href={`#/trfs/${trf.id}/print`} onClick={() => navigate(`/trfs/${trf.id}/print`)}>Print</a>}
          {canDelete && (
            <button className="btn btn--danger" onClick={() => {
              if (confirm(`Delete TRF ${trf.trfNumber}? This cannot be undone.`)) {
                void window.trf.request<TrfDetail>({ method: 'DELETE', path: `/api/trfs/${trf.id}` })
                  .then((res) => {
                    if (res.ok) navigate('/trf');
                    else setActionError(messageOf(res.data, 'This TRF could not be deleted.'));
                  });
              }
            }}>Delete</button>
          )}
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
        <button className={`tab ${tab === 'ard-history' ? 'tab--active' : ''}`} onClick={() => setTab('ard-history')}>
          ARD History{ardHistory.length > 0 ? ` (${ardHistory.length})` : ''}
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
            <dt>Remarks status</dt><dd><RemarksStatusBadge status={trf.remarksStatus} /></dd>
            <dt>Batch size</dt><dd>{trf.batchSize ?? '—'}</dd>
            <dt>Dosage form</dt><dd>{trf.dosageForm ?? '—'}</dd>
            <dt>Manufacturing location</dt><dd>{trf.manufacturingLocation ?? '—'}</dd>
            <dt>Label claim</dt><dd>{trf.labelClaim ?? '—'}</dd>
            <dt>Pack size</dt><dd>{trf.packSize ?? '—'}</dd>
            <dt>Pack type</dt><dd>{trf.packType ?? '—'}</dd>
            <dt>Storage condition</dt><dd>{trf.storageCondition ?? '—'}</dd>
            <dt>Storage period</dt><dd>{trf.storagePeriod ?? '—'}</dd>
            <dt>Manufacturing date</dt><dd>{formatDate(trf.manufacturingDate)}</dd>
            <dt>Expiry date</dt><dd>{formatDate(trf.expiryDate)}</dd>
            <dt>Analysis purpose</dt><dd>{trf.analysisPurpose ?? '—'}</dd>
            <dt>Sample submitted by</dt><dd>{trf.sampleGivenBy ?? '—'}</dd>
             <dt>Sample received by</dt><dd>{trf.sampleReceivedByName ?? '—'}</dd>
             <dt>Signature date</dt><dd>{formatDate(trf.signatureDate)}</dd>
          </dl>

          <section className="panel panel--ard">
            <h2>ARD Analysis Details</h2>
            <dl className="facts facts--wide">
              <dt>A.R. No.</dt><dd>{trf.ardNumber ?? '—'}</dd>
              <dt>Stage</dt><dd><ArdWorkflowBadge status={trf.workflowStatus} /></dd>
              <dt>Test requested</dt><dd className="pre">{trf.requestedAnalysis ?? '—'}</dd>
              <dt>Analyst</dt><dd>{trf.analystName ?? 'Not assigned'}</dd>
              <dt>Date of analysis</dt><dd>{formatDate(trf.analysisStartDate)}</dd>
              <dt>Reporting</dt><dd>{trf.reportingStatus}</dd>
              <dt>COA</dt><dd><ArdCoaBadge status={trf.coaStatus} /></dd>
              <dt>Remark</dt><dd className="pre">{trf.ardRemarks ?? '—'}</dd>
              <dt>ARD remarks status</dt><dd><ArdRemarksStatusBadge status={trf.ardRemarksStatus} /></dd>
              <dt>TAT (days)</dt><dd>{trf.tat?.toString() ?? '—'}</dd>
            </dl>

            {canEditB && nextArdStatuses.length > 0 && (
              <div className="row">
                {nextArdStatuses.map((next) => (
                  <button key={next} className="btn" disabled={busy} onClick={() => changeArdStatus(next)}>
                    {next}
                  </button>
                ))}
              </div>
            )}
          </section>

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

      {tab === 'ard-history' && (
        <table className="table">
          <thead>
            <tr><th>When</th><th>From</th><th>To</th><th>Changed by</th><th>Note</th></tr>
          </thead>
          <tbody>
            {ardHistory.length === 0 && (
              <tr><td colSpan={5} className="muted">No ARD status changes recorded yet.</td></tr>
            )}
            {ardHistory.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.changedAt).toLocaleString()}</td>
                <td>{entry.oldStatus ?? '—'}</td>
                <td><ArdWorkflowBadge status={entry.newStatus} /></td>
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
