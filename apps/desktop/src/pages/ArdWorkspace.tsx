import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { EmptyState, SkeletonRows, initials } from '../components/StatStrip';
import { Icons } from '../components/Icons';
import { BulkReassignDialog } from './ArdEmployeeDetail';

interface ArdEmployeeRow {
  employeeId: number;
  fullName: string;
  employeeCode: string;
  designation: string | null;
  assignedTrfs: number;
  testsAssigned: number;
  assigned: number;
  inProgress: number;
  submitted: number;
  approved: number;
  rejected: number;
  overdue: number;
  completedTests: number;
}

type SortKey = 'fullName' | 'assignedTrfs' | 'testsAssigned' | 'inProgress' | 'submitted' | 'approved' | 'rejected' | 'overdue';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'fullName', label: 'Employee' },
  { key: 'assignedTrfs', label: 'TRFs' },
  { key: 'testsAssigned', label: 'Tests assigned' },
  { key: 'inProgress', label: 'In progress' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'overdue', label: 'Overdue' },
];

/**
 * The ARD team view: every active ARD employee with their workload, including
 * those with no work. Available to the ARD audience (assignments.manage).
 */
export function ArdWorkspace() {
  const { state } = useServerStatus();
  const { employee, can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ArdEmployeeRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'overdue', dir: 'desc' });
  const [reassign, setReassign] = useState<ArdEmployeeRow | null>(null);

  const isManager = can('assignments.manage');

  const load = useCallback(async () => {
    if (!isManager) return;
    setLoading(true);
    setError(null);
    const res = await window.trf.request<{ items: ArdEmployeeRow[] }>({
      method: 'GET', path: '/api/ard-assignments/employees',
    });
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.error || 'Could not load the ARD team.');
      setRows([]);
      return;
    }
    setRows(res.data.items);
  }, [isManager]);

  useEffect(() => {
    if (state === 'offline') return;
    if (isManager) void load();
  }, [state, load, isManager]);

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'fullName' ? 'asc' : 'desc' }));
  };

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => `${r.fullName} ${r.employeeCode}`.toLowerCase().includes(q))
      : rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'fullName') return a.fullName.localeCompare(b.fullName) * dir;
      const diff = (a[sort.key] as number) - (b[sort.key] as number);
      if (diff !== 0) return diff * dir;
      // Stable tiebreak: overdue first, then in progress.
      if (a.overdue !== b.overdue) return b.overdue - a.overdue;
      return b.inProgress - a.inProgress;
    });
  }, [rows, search, sort]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

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
          <h1>ARD team</h1>
          <p className="muted">
            {loading ? 'Loading the team…' : `${rows.length} employee${rows.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="filters">
          <input
            placeholder="Search employee"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search employee"
          />
        </div>
      </div>

      {error && (
        <div className="notice notice--error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn--primary" onClick={() => void load()}>Try again</button>
        </div>
      )}

      <section className="card">
        {loading && (
          <div className="table-wrap">
            <table className="table table--striped">
              <thead><tr>{COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}<th aria-label="Open" /><th aria-label="Reassign" /></tr></thead>
              <tbody><SkeletonRows cols={COLUMNS.length + 2} rows={3} /></tbody>
            </table>
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <EmptyState
            icon={Icons.employees}
            title="No ARD employees found"
            text="Active ARD employees appear here once the team exists."
          />
        )}

        {!loading && rows.length > 0 && visibleRows.length === 0 && (
          <p className="muted">No employees match "{search}".</p>
        )}

        {!loading && visibleRows.length > 0 && (
          <div className="table-wrap">
            <table className="table table--striped">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={c.key === 'fullName' ? '' : 'num'}
                      aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button className="th-sort" onClick={() => toggleSort(c.key)}>
                        {c.label}
                        <span className="th-sort__mark">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                  ))}
                  <th aria-label="Open" />
                  <th aria-label="Reassign" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const hasWork = r.testsAssigned > 0 || r.assignedTrfs > 0;
                  return (
                    <tr key={r.employeeId}
                      className={hasWork ? '' : 'row--muted'}
                      tabIndex={0}
                      onClick={() => navigate(`/ard/employee/${r.employeeId}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/ard/employee/${r.employeeId}`); }
                      }}>
                      <td>
                        <a className="link" href={`#/ard/employee/${r.employeeId}`}
                          onClick={(e) => e.stopPropagation()}>
                          <span className="avatar-xs" aria-hidden="true">{initials(r.fullName)}</span>
                          <span className="truncate" title={r.fullName}>{r.fullName}</span>
                          <span className="muted"> ({r.employeeCode})</span>
                        </a>
                      </td>
                      <td className="num">{r.assignedTrfs}</td>
                      <td className="num">{r.testsAssigned}</td>
                      <td className="num">{r.inProgress}</td>
                      <td className="num">{r.submitted}</td>
                      <td className="num">{r.approved}</td>
                      <td className="num">{r.rejected > 0 ? <span className="badge badge--danger">{r.rejected}</span> : 0}</td>
                      <td className="num">{r.overdue > 0 ? <span className="badge badge--danger">{r.overdue}</span> : 0}</td>
                      <td><a className="link" href={`#/ard/employee/${r.employeeId}`}
                        onClick={(e) => e.stopPropagation()}>View work →</a></td>
                      <td>
                        {r.testsAssigned > 0 && (
                          <button type="button" className="btn btn--sm btn--ghost"
                            onClick={(e) => { e.stopPropagation(); setReassign(r); }}>
                            Reassign
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {reassign && (
        <BulkReassignDialog
          employeeId={reassign.employeeId}
          employeeName={reassign.fullName}
          onClose={() => setReassign(null)}
          onSaved={async () => { setReassign(null); await load(); }}
        />
      )}
    </div>
  );
}