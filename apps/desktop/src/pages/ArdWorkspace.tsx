import { useCallback, useEffect, useState } from 'react';
import type { AnalystAssignedTest, ArdResultReviewStatus } from '@trf/shared';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { EmployeeDashboard } from './EmployeeDashboard';
import { ResultReviewBadge } from '../components/ResultReview';
import { formatDate } from '../components/Badges';

type Tab = 'my-tests' | 'submitted' | 'team';

interface SubmittedRow {
  assignmentId: number;
  trfNumber: string;
  testName: string;
  reviewStatus: ArdResultReviewStatus | null;
  submittedAt: string | null;
  resultValue: string | null;
  resultText: string | null;
  fileName: string | null;
}

interface TeamRow {
  employeeId: number;
  fullName: string;
  employeeCode: string;
  assigned: number;
  inProgress: number;
  submitted: number;
  approved: number;
  rejected: number;
  overdue: number;
}

/**
 * The ARD workspace: one page with tabs for the analyst's own tests, their
 * submitted results, and (for Manager/Admin) a team workload view.
 */
export function ArdWorkspace() {
  const { state } = useServerStatus();
  const { employee, can } = useAuth();
  const [tab, setTab] = useState<Tab>('my-tests');
  const [submitted, setSubmitted] = useState<SubmittedRow[]>([]);
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isManager = can('assignments.manage');

  const loadSubmitted = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.trf.request<{ items: AnalystAssignedTest[] }>({
      method: 'GET', path: '/api/ard-assignments/employee-dashboard',
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error || 'Could not load your submitted results.');
      return;
    }
    const items = (res.data?.items ?? []).filter((a) => a.reviewStatus === 'Submitted');
    setSubmitted(items.map((a) => ({
      assignmentId: a.assignmentId,
      trfNumber: a.trfNumber,
      testName: a.testName,
      reviewStatus: a.reviewStatus ?? null,
      submittedAt: a.submittedAt ?? null,
      resultValue: a.resultValue ?? null,
      resultText: a.resultText ?? null,
      fileName: a.fileName ?? null,
    })));
  }, []);

  const loadTeam = useCallback(async () => {
    if (!isManager) return;
    setLoading(true);
    setError(null);
    // Team workload: one row per ARD employee with their counts.
    const res = await window.trf.request<{ items: TeamRow[] }>({
      method: 'GET', path: '/api/ard-assignments/team-workload',
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error || 'Could not load team workload.');
      return;
    }
    setTeam(res.data?.items ?? []);
  }, [isManager]);

  useEffect(() => {
    if (state === 'offline') return;
    if (tab === 'submitted') void loadSubmitted();
    if (tab === 'team' && isManager) void loadTeam();
  }, [tab, state, loadSubmitted, loadTeam, isManager]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  return (
    <div className="page page--wide">
      <div className="page__head">
        <div>
          <h1>ARD</h1>
          <p className="muted">
            {employee ? `Your tests and results for ${employee.fullName}.` : 'Your ARD tests and results.'}
          </p>
        </div>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'my-tests'} className={tab === 'my-tests' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
          onClick={() => setTab('my-tests')}>My tests</button>
        <button role="tab" aria-selected={tab === 'submitted'} className={tab === 'submitted' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
          onClick={() => setTab('submitted')}>Submitted</button>
        {isManager && (
          <button role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
            onClick={() => setTab('team')}>Team</button>
        )}
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      {tab === 'my-tests' && <EmployeeDashboard />}

      {tab === 'submitted' && (
        <section className="card">
          <h2>Submitted results</h2>
          {loading && <p className="muted">Loading…</p>}
          {!loading && submitted.length === 0 && <p className="muted">You have no submitted results yet.</p>}
          {!loading && submitted.length > 0 && (
            <table className="table table--striped">
              <thead><tr><th>TRF</th><th>Test</th><th>Result</th><th>Submitted</th><th>Review</th></tr></thead>
              <tbody>
                {submitted.map((s) => (
                  <tr key={s.assignmentId}>
                    <td>{s.trfNumber}</td>
                    <td>{s.testName}</td>
                    <td>{s.fileName ? `PDF: ${s.fileName}` : [s.resultValue].filter(Boolean).join(' ') || s.resultText || '—'}</td>
                    <td>{s.submittedAt ? formatDate(s.submittedAt) : '—'}</td>
                    <td><ResultReviewBadge status={s.reviewStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'team' && isManager && (
        <section className="card">
          <h2>Team workload</h2>
          {loading && <p className="muted">Loading…</p>}
          {!loading && team.length === 0 && <p className="muted">No ARD employees found.</p>}
          {!loading && team.length > 0 && (
            <table className="table table--striped">
              <thead><tr><th>Employee</th><th>Assigned</th><th>In progress</th><th>Submitted</th><th>Approved</th><th>Rejected</th><th>Overdue</th></tr></thead>
              <tbody>
                {team.map((t) => (
                  <tr key={t.employeeId}>
                    <td>{t.fullName} <span className="muted">({t.employeeCode})</span></td>
                    <td>{t.assigned}</td>
                    <td>{t.inProgress}</td>
                    <td>{t.submitted}</td>
                    <td>{t.approved}</td>
                    <td>{t.rejected}</td>
                    <td>{t.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}