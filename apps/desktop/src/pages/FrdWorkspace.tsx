import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { EmptyState, SkeletonRows, initials } from '../components/StatStrip';
import { Icons } from '../components/Icons';
import { formatDate } from '../components/Badges';

interface FrdEmployeeRow {
  employeeId: number; fullName: string; employeeCode: string; designation: string | null;
  trfsCreated: number; new: number; assigned: number; inProgress: number; analysisCompleted: number;
  coaPending: number; completed: number; cancelled: number; createdThisMonth: number; lastCreatedAt: string | null;
}

type SortKey = 'fullName' | 'trfsCreated' | 'new' | 'inProgress' | 'completed' | 'cancelled' | 'createdThisMonth' | 'lastCreatedAt';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'fullName', label: 'Employee' },
  { key: 'trfsCreated', label: 'TRFs created' },
  { key: 'new', label: 'New' },
  { key: 'inProgress', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'createdThisMonth', label: 'This month' },
  { key: 'lastCreatedAt', label: 'Last created' },
];

const COLLAPSED_ROWS = 8;

/**
 * The FRD team view for higher authorities: every active Formulation employee
 * with the TRFs they created, including those who have created none.
 */
export function FrdWorkspace() {
  const { state } = useServerStatus();
  const navigate = useNavigate();
  const [rows, setRows] = useState<FrdEmployeeRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'trfsCreated', dir: 'desc' });
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.trf.request<{ items: FrdEmployeeRow[] }>({ method: 'GET', path: '/api/frd/employees' });
    setLoading(false);
    if (!res.ok || !res.data) { setError(res.error || 'Could not load the FRD team.'); setRows([]); return; }
    setRows(res.data.items);
  }, []);

  useEffect(() => {
    if (state === 'offline') return;
    void load();
  }, [state, load]);

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'fullName' ? 'asc' : 'desc' }));
  };

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => `${r.fullName} ${r.employeeCode}`.toLowerCase().includes(q)) : rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'fullName') return a.fullName.localeCompare(b.fullName) * dir;
      if (sort.key === 'lastCreatedAt') {
        const av = a.lastCreatedAt ?? '';
        const bv = b.lastCreatedAt ?? '';
        return av.localeCompare(bv) * dir;
      }
      return ((a[sort.key] as number) - (b[sort.key] as number)) * dir;
    });
  }, [rows, search, sort]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  const displayed = showAll ? visibleRows : visibleRows.slice(0, COLLAPSED_ROWS);

  return (
    <div className="page page--wide">
      <div className="page__head">
        <div>
          <h1>FRD team</h1>
          <p className="muted">
            {loading ? 'Loading the team…' : `${rows.length} employee${rows.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="filters">
          <input placeholder="Search employee" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="Search employee" />
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
              <thead><tr>{COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}<th aria-label="Open" /></tr></thead>
              <tbody><SkeletonRows cols={COLUMNS.length + 1} rows={3} /></tbody>
            </table>
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <EmptyState icon={Icons.employees} title="No FRD employees found" text="Active Formulation employees appear here once the team exists." />
        )}

        {!loading && rows.length > 0 && visibleRows.length === 0 && (
          <p className="muted">No employees match "{search}".</p>
        )}

        {!loading && displayed.length > 0 && (
          <div className="table-wrap">
            <table className="table table--striped">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={c.key === 'fullName' || c.key === 'lastCreatedAt' ? '' : 'num'}
                      aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button className="th-sort" onClick={() => toggleSort(c.key)}>
                        {c.label}
                        <span className="th-sort__mark">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                  ))}
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {displayed.map((r) => (
                  <tr key={r.employeeId}
                    className={r.trfsCreated === 0 ? 'row--muted' : ''}
                    tabIndex={0}
                    onClick={() => navigate(`/frd/employee/${r.employeeId}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/frd/employee/${r.employeeId}`); }
                    }}>
                    <td>
                      <a className="link" href={`#/frd/employee/${r.employeeId}`} onClick={(e) => e.stopPropagation()}>
                        <span className="avatar-xs" aria-hidden="true">{initials(r.fullName)}</span>
                        <span className="truncate" title={r.fullName}>{r.fullName}</span>
                        <span className="muted"> ({r.employeeCode})</span>
                      </a>
                    </td>
                    <td className="num">{r.trfsCreated}</td>
                    <td className="num">{r.new}</td>
                    <td className="num">{r.inProgress}</td>
                    <td className="num">{r.completed}</td>
                    <td className="num">{r.cancelled}</td>
                    <td className="num">{r.createdThisMonth}</td>
                    <td className="nowrap">{r.lastCreatedAt ? formatDate(r.lastCreatedAt) : '—'}</td>
                    <td><a className="link" href={`#/frd/employee/${r.employeeId}`} onClick={(e) => e.stopPropagation()}>View work →</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!showAll && visibleRows.length > COLLAPSED_ROWS && (
          <div className="pager">
            <button type="button" className="btn" onClick={() => setShowAll(true)}>
              Show all ({visibleRows.length})
            </button>
          </div>
        )}
      </section>
    </div>
  );
}