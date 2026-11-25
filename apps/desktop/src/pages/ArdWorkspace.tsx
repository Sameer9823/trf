import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { EmptyState, SkeletonRows, StatStrip, initials } from '../components/StatStrip';
import { Icons } from '../components/Icons';
import { cardLink } from '../lib/dashboard';
import { Modal } from '../components/Modal';
import type { StatTile } from '../components/StatStrip';
import { assignmentApi } from '../lib/assignments';
import { StatusBadge } from '../components/Badges';

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
 * The ARD workspace: team workload view for Manager/Admin.
 */
export function ArdWorkspace() {
  const { state } = useServerStatus();
  const { employee, can } = useAuth();
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [teamSearch, setTeamSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isManager = can('assignments.manage');

  const loadTeam = useCallback(async () => {
    if (!isManager) return;
    setLoading(true);
    setError(null);
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
    if (isManager) void loadTeam();
  }, [state, loadTeam, isManager]);

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

  const visibleTeam = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    if (!q) return team;
    return team.filter((t) => `${t.fullName} ${t.employeeCode}`.toLowerCase().includes(q));
  }, [team, teamSearch]);

  // Employee workload detail modal state
  const [detailEmployee, setDetailEmployee] = useState<TeamRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<{
    workload: any[];
    trfSummary: { completed: number; pending: number; inProgress: number; total: number };
  } | null>(null);

  const openEmployeeDetail = useCallback(async (emp: TeamRow) => {
    setDetailEmployee(emp);
    setDetailLoading(true);
    setDetailData(null);
    try {
      const query = new URLSearchParams();
      query.set('employeeId', String(emp.employeeId));
      query.set('pageSize', '100');
      const res = await assignmentApi.list(`?${query.toString()}`);
      if (res.ok && res.data) {
        const items = res.data.items;
        const trfMap = new Map<number, { trfNumber: string; arNumber: string | null; tests: any[]; status: string }>();
        for (const item of items) {
          if (!trfMap.has(item.trfId)) {
            trfMap.set(item.trfId, {
              trfNumber: item.trfNumber,
              arNumber: item.arNumber ?? null,
              tests: [],
              status: item.trfStatus ?? 'Unknown',
            });
          }
          trfMap.get(item.trfId)!.tests.push({
            testName: item.testName,
            status: item.status,
            assignedDate: item.assignedDate,
            dueDate: item.dueDate,
            isDelayed: item.isDelayed,
          });
        }
        const trfList = Array.from(trfMap.entries()).map(([id, data]) => ({ trfId: id, ...data }));

        const completed = trfList.filter(t => t.status === 'Completed').length;
        const inProgress = trfList.filter(t => ['In Progress', 'Analysis Completed', 'Assigned'].includes(t.status)).length;
        const pending = trfList.filter(t => t.status === 'New').length;

        setDetailData({
          workload: trfList,
          trfSummary: { completed, pending, inProgress, total: trfList.length },
        });
      }
    } catch (err) {
      console.error('Failed to load employee detail:', err);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeEmployeeDetail = useCallback(() => {
    setDetailEmployee(null);
    setDetailData(null);
  }, []);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  // Only show team tab for managers
  if (!isManager) {
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
        <p className="muted">You do not have permission to view the team workload.</p>
      </div>
    );
  }

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

      {error && <p className="error-text" role="alert">{error}</p>}

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
          <p className="muted">No employees match "{teamSearch}".</p>
        )}
        {!loading && visibleTeam.length > 0 && (
          <table className="table table--striped">
            <thead><tr><th>Employee</th><th className="num">Assigned</th><th className="num">In progress</th><th className="num">Submitted</th><th className="num">Approved</th><th className="num">Rejected</th></tr></thead>
            <tbody>
              {visibleTeam.map((t) => (
                <tr key={t.employeeId}>
                  <td>
                    <a href={cardLink('assignments', { employeeId: t.employeeId })} className="link">
                      <span className="avatar-xs" aria-hidden="true">{initials(t.fullName)}</span>{t.fullName} <span className="muted">({t.employeeCode})</span>
                    </a>
                    <button className="btn btn--ghost btn--tiny" onClick={() => openEmployeeDetail(t)} aria-label={`View ${t.fullName}'s workload details`}>Details</button>
                  </td>
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
      <EmployeeWorkloadDetail
        employee={detailEmployee}
        isOpen={!!detailEmployee}
        onClose={closeEmployeeDetail}
        loading={detailLoading}
        data={detailData}
      />
    </div>
  );
}

const closeEmployeeDetail = () => {
  // This is defined inside the component
};

/** Employee workload detail modal - shows comprehensive TRF/test workload for an ARD employee. */
function EmployeeWorkloadDetail({ employee, isOpen, onClose, loading, data }: {
  employee: { employeeId: number; fullName: string; employeeCode: string } | null;
  isOpen: boolean;
  onClose: () => void;
  loading: boolean;
  data: { workload: any[]; trfSummary: { completed: number; pending: number; inProgress: number; total: number } } | null;
}) {
  if (!isOpen || !employee) return null;

  return (
    <Modal open={isOpen} onClose={onClose} title={`${employee.fullName} (${employee.employeeCode}) — Workload Details`}>
      {loading && (
        <div className="modal-body">
          <div className="skel skel--text" style={{ width: '200px' }} />
          <div className="skel skel--text" style={{ width: '150px' }} />
          <div className="skel skel--text" style={{ width: '100px' }} />
        </div>
      )}
      {!loading && data && (
        <div className="modal-body">
          <div className="stat-strip" style={{ marginBottom: '16px' }}>
            <div className="stat-tile"><span className="stat-tile__value">{data.trfSummary.total}</span><span className="stat-tile__label">Total TRFs</span></div>
            <div className="stat-tile stat-tile--ok"><span className="stat-tile__value">{data.trfSummary.completed}</span><span className="stat-tile__label">Completed</span></div>
            <div className="stat-tile stat-tile--info"><span className="stat-tile__value">{data.trfSummary.inProgress}</span><span className="stat-tile__label">In Progress</span></div>
            <div className="stat-tile stat-tile--warn"><span className="stat-tile__value">{data.trfSummary.pending}</span><span className="stat-tile__label">Pending</span></div>
          </div>

          <div className="table-wrap">
            <table className="table table--striped">
              <thead>
                <tr>
                  <th>TRF</th>
                  <th>A.R. No.</th>
                  <th>TRF Status</th>
                  <th>Tests</th>
                  <th>Tests Completed</th>
                  <th>Tests In Progress</th>
                  <th>Tests Pending</th>
                </tr>
              </thead>
              <tbody>
                {data.workload.length === 0 ? (
                  <tr><td colSpan={7} className="muted">No assignments found for this employee.</td></tr>
                ) : (
                  data.workload.map((trf) => (
                    <tr key={trf.trfId}>
                      <td><strong>{trf.trfNumber}</strong></td>
                      <td>{trf.arNumber ?? '—'}</td>
                      <td><StatusBadge status={trf.status} /></td>
                      <td>{trf.tests.length}</td>
                      <td className="num">{trf.tests.filter((t: any) => t.status === 'Completed').length}</td>
                      <td className="num">{trf.tests.filter((t: any) => ['In Progress', 'Assigned'].includes(t.status)).length}</td>
                      <td className="num">{trf.tests.filter((t: any) => t.status === 'Pending').length}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {data.workload.length > 0 && (
            <details style={{ marginTop: '16px' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Test Details (click to expand)</summary>
              <div style={{ marginTop: '12px' }}>
                {data.workload.map((trf) => (
                  <div key={trf.trfId} style={{ marginBottom: '16px', padding: '12px', background: 'var(--tint-3)', borderRadius: '8px' }}>
                    <div style={{ fontWeight: 600, marginBottom: '8px' }}>{trf.trfNumber} — {trf.tests.length} tests</div>
                    <table className="table table--striped" style={{ fontSize: '13px' }}>
                      <thead>
                        <tr><th>Test</th><th>Status</th><th>Assigned</th><th>Due</th><th>Delayed</th></tr>
                      </thead>
                      <tbody>
                        {trf.tests.map((test: any) => (
                          <tr key={test.testName}>
                            <td>{test.testName}</td>
                            <td><StatusBadge status={test.status} /></td>
                            <td>{test.assignedDate ? test.assignedDate.split('T')[0] : '—'}</td>
                            <td>{test.dueDate ? test.dueDate.split('T')[0] : '—'}</td>
                            <td>{test.isDelayed ? <span className="badge badge--danger">Delayed</span> : 'No'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {!loading && !data && (
        <div className="modal-body">
          <EmptyState icon={Icons.trf} title="No data" text="Could not load workload details." />
        </div>
      )}
    </Modal>
  );
}