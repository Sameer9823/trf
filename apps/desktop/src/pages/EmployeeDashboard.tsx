import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AnalystAssignedTest, ArdTestAssignmentStatus, TrfDetail } from '@trf/shared';
import { ARD_TEST_ASSIGNMENT_STATUSES } from '@trf/shared';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { formatDate } from '../components/Badges';
import { messageOf } from '../lib/api';
import { NotificationCentre } from '../components/NotificationCentre';

interface AssignmentSummary {
  id: number;
  trfNumber: string;
  arNumber: string | null;
  productName: string | null;
  genericName: string | null;
  batchNumber: string | null;
  testName: string;
  testStatus: ArdTestAssignmentStatus;
  assignedAt: string | null;
  dueDate: string | null;
  /** Result fields */
  outcome: 'Pass' | 'Fail' | 'NA' | null;
  resultValue: string | null;
  unit: string | null;
  /** Completion fields */
  analysisStartDate: string | null;
  completionDate: string | null;
  completedBy: number | null;
  completedByName: string | null;
  /** TRF-level fields for submit button */
  trfId: number;
  ardSubmittedAt: string | null;
  workflowStatus: string | null;
  remarksStatus: string | null;
  completedAt: string | null;
  completedByAgmName: string | null;
  version: number;
}

const STATUS_LABEL: Record<ArdTestAssignmentStatus, string> = {
  'Pending Assignment': 'Pending',
  'Assigned': 'Assigned',
  'In Progress': 'In Progress',
  'Completed': 'Completed',
  'Re-test Required': 'Re-test',
  'Cancelled': 'Cancelled',
};

const STATUS_COLOR: Record<ArdTestAssignmentStatus, string> = {
  'Pending Assignment': 'var(--muted)',
  'Assigned': 'var(--accent)',
  'In Progress': 'var(--accent-2)',
  'Completed': 'var(--ok)',
  'Re-test Required': 'var(--warn)',
  'Cancelled': 'var(--danger)',
};

export function EmployeeDashboard() {
  const { state } = useServerStatus();
  const { employee } = useAuth();
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.trf.request<{ items: (AnalystAssignedTest & {
      trfId: number;
      ardSubmittedAt: string | null;
      workflowStatus: string | null;
      remarksStatus: string | null;
      completedAt: string | null;
      completedByAgmName: string | null;
      version: number;
    })[] }>({
      method: 'GET', path: '/api/ard-assignments/employee-dashboard',
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error || 'Could not load your assignments.');
      return;
    }
    const items = (res.data?.items ?? []).map((a) => ({
      id: a.assignmentId,
      trfNumber: a.trfNumber,
      arNumber: a.arNumber,
      productName: a.productName,
      genericName: a.genericName,
      batchNumber: a.batchNumber,
      testName: a.testName,
      testStatus: a.testStatus,
      assignedAt: a.assignedAt,
      dueDate: a.dueDate,
      outcome: a.outcome ?? null,
      resultValue: a.resultValue ?? null,
      unit: a.unit ?? null,
      analysisStartDate: a.analysisStartDate ?? null,
      completionDate: a.completionDate ?? null,
      completedBy: a.completedBy ?? null,
      completedByName: a.completedByName ?? null,
      trfId: a.trfId ?? 0,
      ardSubmittedAt: a.ardSubmittedAt ?? null,
      workflowStatus: a.workflowStatus ?? null,
      remarksStatus: a.remarksStatus ?? null,
      completedAt: a.completedAt ?? null,
      completedByAgmName: a.completedByAgmName ?? null,
      version: a.version ?? 0,
    }));
    setAssignments(items);
  }, []);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    void load();
  }, [load, state]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  if (loading && assignments.length === 0) {
    return <div className="page page--wide"><p className="muted">Loading your test assignments…</p></div>;
  }

  const pendingCount = assignments.filter((a) => a.testStatus === 'Pending Assignment').length;
  const inProgressCount = assignments.filter(
    (a) => a.testStatus === 'Assigned' || a.testStatus === 'In Progress' || a.testStatus === 'Re-test Required',
  ).length;
  const completedCount = assignments.filter(
    (a) => a.testStatus === 'Completed' || a.testStatus === 'Cancelled',
  ).length;

  async function updateStatus(id: number, status: ArdTestAssignmentStatus) {
    setUpdatingId(id);
    const res = await window.trf.request({
      method: 'PATCH',
      path: `/api/ard-assignments/${id}/status`,
      body: { status, version: 1, note: null },
    });
    setUpdatingId(null);
    if (!res.ok) {
      setError(res.error || 'Could not update the test status.');
      return;
    }
    void load();
  }

  async function submitToAgm(a: AssignmentSummary) {
    setUpdatingId(a.id);
    setError(null);
    const res = await window.trf.request<TrfDetail>({
      method: 'POST',
      path: `/api/trfs/${a.trfId}/ard-submit`,
      body: { version: a.version },
    });
    setUpdatingId(null);
    if (!res.ok) {
      setError(messageOf(res.data, 'Could not submit to AGM.'));
      return;
    }
    void load();
  }

  return (
    <div className="page page--wide">
      <div className="page__head">
        <div>
          <h1>Your Tests</h1>
          <p className="muted">
            {employee
              ? `Showing ARD test assignments for ${employee.fullName}.`
              : 'Showing your ARD test assignments.'}
          </p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <div className="stat-row stat-row--wrap">
        <div className="stat"><span className="stat__value stat__value--info">{pendingCount}</span><span className="stat__label">Pending assignment</span></div>
        <div className="stat"><span className="stat__value stat__value--info">{inProgressCount}</span><span className="stat__label">In progress</span></div>
        <div className="stat"><span className="stat__value stat__value--ok">{completedCount}</span><span className="stat__label">Completed</span></div>
      </div>

      {assignments.length === 0 ? (
        <div className="notice">
          <strong>No tests assigned to you.</strong> When a GM or AGM assigns a test, it will appear here.
        </div>
      ) : (
        <table className="table table--striped" role="grid">
            <thead>
              <tr>
                <th>TRF</th><th>A.R. No.</th><th>Product</th><th>Generic Name</th><th>Test</th><th>Assigned</th><th>Due Date</th><th>Status</th><th>Result</th><th>Outcome</th><th>Completed</th><th>Actions</th>
              </tr>
            </thead>
          <tbody>
             {assignments.map((a) => (
               <tr key={a.id}>
                 <td><Link to={`#/trfs/${a.trfId}`} className="link">{a.trfNumber}</Link></td>
                 <td>{a.arNumber ?? '—'}</td>
                 <td>{a.productName ?? '—'}</td>
                 <td>{a.genericName ?? '—'}</td>
                 <td>{a.testName}</td>
                 <td>{a.assignedAt ? formatDate(a.assignedAt) : '—'}</td>
                 <td>{a.dueDate ? formatDate(a.dueDate) : '—'}</td>
                 <td>
                   <span className="badge" style={{ color: STATUS_COLOR[a.testStatus] }}>
                     {STATUS_LABEL[a.testStatus]}
                   </span>
                 </td>
                 <td>{a.resultValue ?? '—'}{a.unit ? ` ${a.unit}` : ''}</td>
                 <td>{a.outcome ?? '—'}</td>
                 <td>{a.completedByName ? `${a.completedByName} (${formatDate(a.completionDate) ?? ''})` : '—'}</td>
                 <td>
                   {updatingId === a.id ? <span className="muted">Saving…</span> : (
                     <>
                       <button
                         className="btn btn--tiny"
                         onClick={() => updateStatus(a.id, 'In Progress')}
                         disabled={a.testStatus === 'In Progress' || a.testStatus === 'Completed' || a.testStatus === 'Cancelled'}
                       >Mark In Progress</button>
                       <button
                         className="btn btn--tiny"
                         onClick={() => updateStatus(a.id, 'Completed')}
                         disabled={a.testStatus === 'Completed' || a.testStatus === 'Cancelled'}
                       >Mark Complete</button>
                       {a.ardSubmittedAt === null && a.workflowStatus === 'Completed' && a.remarksStatus === 'Approved' && (
                         <button
                           className="btn btn--tiny btn--primary"
                           onClick={() => submitToAgm(a)}
                           disabled={updatingId === a.id}
                         >Submit to AGM</button>
                       )}
                     </>
                   )}
                 </td>
               </tr>
             ))}
          </tbody>
        </table>
      )}

      {/* Notification Centre */}
      <section style={{ marginTop: '24px' }}>
        <NotificationCentre unreadOnly={true} />
      </section>
    </div>
  );
}

