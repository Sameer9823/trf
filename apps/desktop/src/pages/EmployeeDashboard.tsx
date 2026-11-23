import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AnalystAssignedTest, ArdResultReviewStatus, ArdTestAssignmentStatus } from '@trf/shared';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { formatDate } from '../components/Badges';
import { NotificationCentre } from '../components/NotificationCentre';
import { ResultReviewBadge, SubmitResultModal, ResultFileButton, type SubmitTarget } from '../components/ResultReview';

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
  resultText: string | null;
  unit: string | null;
  methodUsed: string | null;
  specification: string | null;
  remarks: string | null;
  /** The AGM's review of the submitted result */
  reviewStatus: ArdResultReviewStatus | null;
  reviewReason: string | null;
  reviewedByName: string | null;
  resultMode: 'text' | 'pdf' | null;
  fileName: string | null;
  /** Completion fields */
  analysisStartDate: string | null;
  completionDate: string | null;
  completedBy: number | null;
  completedByName: string | null;
  trfId: number;
  /** Needed to submit a result: it guards against a newer change. */
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

const STATUS_BADGE: Record<ArdTestAssignmentStatus, string> = {
  'Pending Assignment': 'badge--muted',
  'Assigned': 'badge--info',
  'In Progress': 'badge--info',
  'Completed': 'badge--ok',
  'Re-test Required': 'badge--warn',
  'Cancelled': 'badge--danger',
};

export function EmployeeDashboard() {
  const { state } = useServerStatus();
  const { employee } = useAuth();
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState<SubmitTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.trf.request<{ items: AnalystAssignedTest[] }>({
      method: 'GET', path: '/api/ard-assignments/employee-dashboard',
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error || 'Could not load your assignments.');
      return;
    }
    const items: AssignmentSummary[] = (res.data?.items ?? []).map((a) => ({
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
      resultText: a.resultText ?? null,
      unit: a.unit ?? null,
      methodUsed: a.methodUsed ?? null,
      specification: a.specification ?? null,
      remarks: a.remarks ?? null,
      reviewStatus: a.reviewStatus ?? null,
      reviewReason: a.reviewReason ?? null,
      reviewedByName: a.reviewedByName ?? null,
      resultMode: a.resultMode ?? null,
      fileName: a.fileName ?? null,
      analysisStartDate: a.analysisStartDate ?? null,
      completionDate: a.completionDate ?? null,
      completedBy: a.completedBy ?? null,
      completedByName: a.completedByName ?? null,
      trfId: a.trfId ?? 0,
      version: a.assignmentVersion ?? 0,
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

  const pendingCount = assignments.filter((a) => a.testStatus === 'Pending Assignment' || a.testStatus === 'Assigned').length;
  const inProgressCount = assignments.filter(
    (a) => a.testStatus === 'In Progress' || a.testStatus === 'Re-test Required',
  ).length;
  const submittedCount = assignments.filter((a) => a.reviewStatus === 'Submitted').length;
  const approvedCount = assignments.filter((a) => a.reviewStatus === 'Approved').length;
  const rejectedCount = assignments.filter((a) => a.reviewStatus === 'Rejected').length;
  const today = new Date().toISOString().slice(0, 10);
  const overdueCount = assignments.filter(
    (a) => a.dueDate && a.dueDate < today && a.testStatus !== 'Completed' && a.testStatus !== 'Cancelled',
  ).length;

  async function updateStatus(a: AssignmentSummary, status: ArdTestAssignmentStatus) {
    setUpdatingId(a.id);
    const res = await window.trf.request({
      method: 'PATCH',
      path: `/api/ard-assignments/${a.id}/status`,
      body: { status, version: a.version, note: null },
    });
    setUpdatingId(null);
    if (!res.ok) {
      setError(res.error || 'Could not update the test status.');
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
        <div className="stat stat--clickable"><span className="stat__value stat__value--info">{pendingCount}</span><span className="stat__label">Assigned</span></div>
        <div className="stat stat--clickable"><span className="stat__value stat__value--info">{inProgressCount}</span><span className="stat__label">In progress</span></div>
        <div className="stat stat--clickable"><span className="stat__value stat__value--warn">{submittedCount}</span><span className="stat__label">Submitted</span></div>
        <div className="stat stat--clickable"><span className="stat__value stat__value--ok">{approvedCount}</span><span className="stat__label">Approved</span></div>
        <div className="stat stat--clickable"><span className="stat__value stat__value--danger">{rejectedCount}</span><span className="stat__label">Rejected</span></div>
        <div className="stat stat--clickable"><span className="stat__value stat__value--danger">{overdueCount}</span><span className="stat__label">Overdue</span></div>
      </div>

      {assignments.length === 0 ? (
        <div className="notice">
          <strong>No tests assigned to you.</strong> When a GM or AGM assigns a test, it will appear here.
        </div>
      ) : (
        <table className="table table--striped" role="grid">
            <thead>
              <tr>
                <th>TRF</th><th>A.R. No.</th><th>Product</th><th>Generic Name</th><th>Test</th><th>Assigned</th><th>Due Date</th><th>Status</th><th>Result</th><th>Outcome</th><th>AGM review</th><th>Actions</th>
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
                    <span className={`badge ${STATUS_BADGE[a.testStatus] ?? 'badge--info'}`}>
                      {STATUS_LABEL[a.testStatus]}
                    </span>
                  </td>
                 <td>{a.resultMode === 'pdf' && a.fileName ? <ResultFileButton assignmentId={a.id} fileName={a.fileName} /> : (a.resultValue ?? '—')}{a.resultMode !== 'pdf' && a.unit ? ` ${a.unit}` : ''}</td>
                 <td>{a.outcome ?? '—'}</td>
<td>
                    <ResultReviewBadge status={a.reviewStatus} />
                    {a.reviewStatus === 'Rejected' && a.reviewReason && (
                      <div className="reject-reason">{a.reviewReason}</div>
                    )}
                    {a.reviewStatus === 'Approved' && a.reviewedByName && <div className="muted">{a.reviewedByName}</div>}
                  </td>
                 <td>
                   {updatingId === a.id ? <span className="muted">Saving…</span> : (
                     <>
                       <button
                         className="btn btn--tiny"
                         onClick={() => updateStatus(a, 'In Progress')}
                         disabled={a.testStatus === 'In Progress' || a.testStatus === 'Completed' || a.testStatus === 'Cancelled' || a.reviewStatus === 'Submitted'}
                       >Mark In Progress</button>
                       <button
                         className="btn btn--tiny btn--primary"
                         onClick={() => setSubmitting({
                           assignmentId: a.id, version: a.version, testName: a.testName, trfNumber: a.trfNumber,
                           analysisStartDate: a.analysisStartDate,
previous: a.reviewStatus === 'Rejected' ? {
                              resultValue: a.resultValue, resultText: a.resultText, unit: a.unit, methodUsed: a.methodUsed,
                              specification: a.specification,
                              outcome: a.outcome, remarks: a.remarks,
                            } : null,
                         })}
                         disabled={a.testStatus === 'Completed' || a.testStatus === 'Cancelled' || a.reviewStatus === 'Submitted'}
                       >{a.reviewStatus === 'Rejected' ? 'Correct & resubmit' : 'Submit result'}</button>
                     </>
                   )}
                 </td>
               </tr>
             ))}
          </tbody>
        </table>
      )}

      <SubmitResultModal target={submitting} onClose={() => setSubmitting(null)} onSubmitted={() => void load()} />

      {/* Notification Centre */}
      <section style={{ marginTop: '24px' }}>
        <NotificationCentre unreadOnly={true} />
      </section>
    </div>
  );
}

