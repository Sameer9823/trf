import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AnalystAssignedTest, ArdResultReviewStatus } from '@trf/shared';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { EmployeeDashboard } from './EmployeeDashboard';
import { ResultReviewBadge } from '../components/ResultReview';
import { formatDate } from '../components/Badges';
import { EmptyState, SkeletonRows, StatStrip, initials } from '../components/StatStrip';
import { Icons } from '../components/Icons';
import type { StatTile } from '../components/StatStrip';

type Tab = 'my-tests' | 'submitted' | 'approved' | 'team';

interface ResultRow {
  assignmentId: number;
  trfNumber: string;
  arNumber: string | null;
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

const matchesResult = (r: ResultRow, q: string): boolean => {
  if (!q) return true;
  const hay = [r.trfNumber, r.arNumber, r.testName, r.resultValue, r.resultText, r.fileName].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
};

/**
 * The ARD workspace: one page with tabs for the analyst's own tests, their
 * submitted and approved results, and (for Manager/Admin) a team workload view.
 */
export function ArdWorkspace() {
  const { state } = useServerStatus();
  const { employee, can } = useAuth();
  const [tab, setTab] = useState<Tab>('my-tests');
  const [submitted, setSubmitted] = useState<ResultRow[]>([]);
  const [approved, setApproved] = useState<ResultRow[]>([]);
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [resultSearch, setResultSearch] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isManager = can('assignments.manage');

  const loadResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.trf.request<{ items: AnalystAssignedTest[] }>({
      method: 'GET', path: '/api/ard-assignments/employee-dashboard',
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error || 'Could not load your results.');
      return;
    }
    const map = (a: AnalystAssignedTest): ResultRow => ({
      assignmentId: a.assignmentId,
      trfNumber: a.trfNumber,
      arNumber: a.arNumber ?? null,
      testName: a.testName,
      reviewStatus: a.reviewStatus ?? null,
      submittedAt: a.submittedAt ?? null,
      resultValue: a.resultValue ?? null,
      resultText: a.resultText ?? null,
      fileName: a.fileName ?? null,
    });
    const items = res.data?.items ?? [];
    setSubmitted(items.filter((a) => a.reviewStatus === 'Submitted').map(map));
    setApproved(items.filter((a) => a.reviewStatus === 'Approved').map(map));
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
    if (tab === 'submitted' || tab === 'approved') void loadResults();
    if (tab === 'team' && isManager) void loadTeam();
  }, [tab, state, loadResults, loadTeam, isManager]);

  const submittedTiles = useMemo<StatTile[]>(() => [
    { label: 'Submitted', value: submitted.length, tone: 'info' },
    { label: 'Text Results', value: submitted.filter((s) => s.resultValue || s.resultText).length, tone: 'ok' },
    { label: 'PDF Files', value: submitted.filter((s) => s.fileName).length },
  ], [submitted]);

  const approvedTiles = useMemo<StatTile[]>(() => [
    { label: 'Approved', value: approved.length, tone: 'ok' },
    { label: 'Text Results', value: approved.filter((s) => s.resultValue || s.resultText).length, tone: 'info' },
    { label: 'PDF Files', value: approved.filter((s) => s.fileName).length },
  ], [approved]);

  const teamTiles = useMemo<StatTile[]>(() => {
    const sum = team.reduce(
      (a, r) => ({
        assigned: a.assigned + r.assigned, inProgress: a.inProgress + r.inProgress,
        submitted: a.submitted + r.submitted, approved: a.approved + r.approved,
        rejected: a.rejected + r.rejected,
      }),
      { assigned: 0, inProgress: 0, submitted: 0, approved: 0, rejected: 0 },
    );
    return [
      { label: 'Assigned', value: sum.assigned },
      { label: 'In Progress', value: sum.inProgress, tone: 'info' },
      { label: 'Submitted', value: sum.submitted, tone: 'warn' },
      { label: 'Approved', value: sum.approved, tone: 'ok' },
      { label: 'Rejected', value: sum.rejected, tone: 'danger' },
    ];
  }, [team]);

  const visibleSubmitted = useMemo(() => submitted.filter((r) => matchesResult(r, resultSearch)), [submitted, resultSearch]);
  const visibleApproved = useMemo(() => approved.filter((r) => matchesResult(r, resultSearch)), [approved, resultSearch]);
  const visibleTeam = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    if (!q) return team;
    return team.filter((t) => `${t.fullName} ${t.employeeCode}`.toLowerCase().includes(q));
  }, [team, teamSearch]);

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
        <button role="tab" aria-selected={tab === 'approved'} className={tab === 'approved' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
          onClick={() => setTab('approved')}>Approved</button>
        {isManager && (
          <button role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'tabs__btn tabs__btn--active' : 'tabs__btn'}
            onClick={() => setTab('team')}>Team</button>
        )}
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      {tab === 'my-tests' && <EmployeeDashboard />}

      {(tab === 'submitted' || tab === 'approved') && (
        <ResultsCard
          title={tab === 'approved' ? 'Approved results' : 'Submitted results'}
          icon={tab === 'approved' ? Icons.check : Icons.trf}
          rows={tab === 'approved' ? visibleApproved : visibleSubmitted}
          total={tab === 'approved' ? approved.length : submitted.length}
          tiles={tab === 'approved' ? approvedTiles : submittedTiles}
          search={resultSearch}
          onSearch={setResultSearch}
          loading={loading}
          emptyTitle={tab === 'approved' ? 'No approved results yet' : 'No submitted results yet'}
          emptyText={tab === 'approved'
            ? 'Once the AGM approves your results they will appear here.'
            : 'Results you submit for your assigned tests will appear here with their review status.'}
        />
      )}

      {tab === 'team' && isManager && (
        <section className="card">
          <h2>Team workload</h2>
          {!loading && team.length > 0 && <StatStrip tiles={teamTiles} />}
          <div className="filters">
            <input placeholder="Search employee name or code" value={teamSearch}
              onChange={(e) => setTeamSearch(e.target.value)} aria-label="Search team" />
          </div>
          {loading && (
            <table className="table table--striped">
              <thead><tr><th>Employee</th><th className="num">Assigned</th><th className="num">In progress</th><th className="num">Submitted</th><th className="num">Approved</th><th className="num">Rejected</th></tr></thead>
              <tbody><SkeletonRows cols={6} rows={3} /></tbody>
            </table>
          )}
          {!loading && team.length === 0 && (
            <EmptyState
              icon={Icons.employees}
              title="No ARD employees found"
              text="Team workload appears here once ARD employees and assignments exist."
            />
          )}
          {!loading && team.length > 0 && visibleTeam.length === 0 && (
            <p className="muted">No employees match “{teamSearch}”.</p>
          )}
          {!loading && visibleTeam.length > 0 && (
            <table className="table table--striped">
              <thead><tr><th>Employee</th><th className="num">Assigned</th><th className="num">In progress</th><th className="num">Submitted</th><th className="num">Approved</th><th className="num">Rejected</th></tr></thead>
              <tbody>
                {visibleTeam.map((t) => (
                  <tr key={t.employeeId}>
                    <td><span className="avatar-xs" aria-hidden="true">{initials(t.fullName)}</span>{t.fullName} <span className="muted">({t.employeeCode})</span></td>
                    <td className="num">{t.assigned}</td>
                    <td className="num">{t.inProgress}</td>
                    <td className="num">{t.submitted}</td>
                    <td className="num">{t.approved}</td>
                    <td className="num">{t.rejected > 0 ? <span className="badge badge--danger">{t.rejected}</span> : 0}</td>
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

/** A searchable results card shared by the Submitted and Approved tabs. */
function ResultsCard({ title, icon, rows, total, tiles, search, onSearch, loading, emptyTitle, emptyText }: {
  title: string; icon: ReactNode; rows: ResultRow[]; total: number; tiles: StatTile[];
  search: string; onSearch: (value: string) => void; loading: boolean; emptyTitle: string; emptyText: string;
}) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {!loading && total > 0 && <StatStrip tiles={tiles} />}
      <div className="filters">
        <input placeholder="Search TRF, test or result" value={search}
          onChange={(e) => onSearch(e.target.value)} aria-label={`Search ${title.toLowerCase()}`} />
      </div>
      {loading && (
        <table className="table table--striped">
          <thead><tr><th>TRF</th><th>A.R. No.</th><th>Test</th><th>Result</th><th>Submitted</th><th>Review</th></tr></thead>
          <tbody><SkeletonRows cols={6} rows={3} /></tbody>
        </table>
      )}
      {!loading && total === 0 && <EmptyState icon={icon} title={emptyTitle} text={emptyText} />}
      {!loading && total > 0 && rows.length === 0 && (
        <p className="muted">No results match “{search}”.</p>
      )}
      {!loading && rows.length > 0 && (
        <table className="table table--striped">
          <thead><tr><th>TRF</th><th>A.R. No.</th><th>Test</th><th>Result</th><th>Submitted</th><th>Review</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.assignmentId}>
                <td>{s.trfNumber}</td>
                <td>{s.arNumber ?? '—'}</td>
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
  );
}