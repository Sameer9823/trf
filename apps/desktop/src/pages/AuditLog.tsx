import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AuditEntry, AuditPage, AuditSortField, AuditTone } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { useServerStatus } from '../lib/server-status';
import { ExportButton } from '../components/ExportButton';

interface ApiBody { error?: { code?: string; message?: string } }
interface Vocabulary {
  modules: string[];
  actions: string[];
  recordTypes: string[];
}

const TONE_CLASS: Record<AuditTone, string> = {
  ok: 'badge--ok', info: 'badge--info', warn: 'badge--warn', danger: 'badge--danger',
};

/** Renders one value so `null`, an object and a number all read sensibly. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * The trail is a reading screen, not an editing one. A row expands to show the
 * field-by-field change, because "Result recorded" on its own does not say which
 * number changed or from what.
 */
export function AuditLog() {
  const { can } = useAuth();
  const { state } = useServerStatus();
  const [params, setParams] = useSearchParams();

  const [data, setData] = useState<AuditPage | null>(null);
  const [vocabulary, setVocabulary] = useState<Vocabulary>({ modules: [], actions: [], recordTypes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filters = useMemo(() => ({
    search: params.get('search') ?? '',
    module: params.get('module') ?? '',
    action: params.get('action') ?? '',
    userId: params.get('userId') ? Number(params.get('userId')) : undefined,
    recordRef: params.get('recordRef') ?? '',
    dateFrom: params.get('dateFrom') ?? undefined,
    dateTo: params.get('dateTo') ?? undefined,
    page: Number(params.get('page') ?? 1),
  }), [params]);

  const setFilter = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '') next.delete(key); else next.set(key, value);
    // Any filter change returns to page one, or a narrower trail lands on an empty page.
    next.delete('page');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const setPage = (page: number) => {
    const next = new URLSearchParams(params);
    if (page <= 1) next.delete('page'); else next.set('page', String(page));
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ page: String(filters.page), pageSize: '50' });
    if (filters.search.trim()) query.set('search', filters.search.trim());
    if (filters.module) query.set('module', filters.module);
    if (filters.action) query.set('action', filters.action);
    if (filters.userId) query.set('userId', String(filters.userId));
    if (filters.recordRef.trim()) query.set('recordRef', filters.recordRef.trim());
    if (filters.dateFrom) query.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) query.set('dateTo', filters.dateTo);

    const res = await window.trf.request<AuditPage>({ method: 'GET', path: `/api/audit?${query}` });
    setLoading(false);
    if (!res.ok || !res.data) {
      const body = res.data as ApiBody | undefined;
      setError(res.status === 0 ? MESSAGES.SERVER_UNAVAILABLE : body?.error?.message ?? 'The audit trail could not be loaded.');
      return;
    }
    setError(null);
    setData(res.data);
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!can('audit.view')) return;
    void window.trf.request<Vocabulary>({ method: 'GET', path: '/api/audit/vocabulary' })
      .then((res) => { if (res.ok && res.data) setVocabulary(res.data); });
  }, [can]);

  if (!can('audit.view')) {
    return (
      <div className="page">
        <div className="page__head"><h1>Audit Log</h1></div>
        <div className="notice">
          <strong>You do not have permission to read the audit log.</strong>
          <p className="muted">A manager or administrator can show it to you.</p>
        </div>
      </div>
    );
  }

  const summary = data?.summary;
  const activeCount = [
    filters.search, filters.module, filters.action, filters.userId, filters.recordRef,
    filters.dateFrom, filters.dateTo,
  ].filter(Boolean).length;

  // The Audit Log sheet reads these names, so the file is the trail that was
  // being read rather than the whole history.
  const exportFilters = {
    search: filters.search,
    recordRef: filters.recordRef,
    module: filters.module,
    action: filters.action,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  };

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>Audit Log</h1>
        <div className="row">
          <ExportButton label="Export the Audit Log" sheet="Audit Log" filters={exportFilters} />
        </div>
      </div>

      {state === 'offline' && <OfflineNotice />}
      <p className="muted">
        Who changed what, and when. The trail is written in the same transaction as the change,
        so it can be read but never edited or removed.
      </p>

      {summary && (
        <div className="stat-row">
          <div className="stat"><span className="stat__label">Entries</span><strong className="stat__value">{summary.total.toLocaleString()}</strong></div>
          <div className="stat"><span className="stat__label">Sign-in and access events</span><strong className={`stat__value ${summary.securityEvents > 0 ? 'stat__value--warn' : ''}`}>{summary.securityEvents.toLocaleString()}</strong></div>
          {summary.byDay[0] && (
            <div className="stat"><span className="stat__label">Most recent day</span><strong className="stat__value">{summary.byDay[0].count}</strong><span className="stat__hint">{new Date(`${summary.byDay[0].day}T00:00:00`).toLocaleDateString('en-GB')}</span></div>
          )}
          {summary.byUser[0] && (
            <div className="stat"><span className="stat__label">Most active</span><strong className="stat__value">{summary.byUser[0].count}</strong><span className="stat__hint">{summary.byUser[0].userName ?? 'Unknown'}</span></div>
          )}
        </div>
      )}

      <div className="filters">
        <input
          placeholder="Search person, action or record"
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
          aria-label="Search the audit log"
        />
        <select value={filters.module} onChange={(e) => setFilter('module', e.target.value || null)} aria-label="Filter by module">
          <option value="">All modules</option>
          {vocabulary.modules.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filters.action} onChange={(e) => setFilter('action', e.target.value || null)} aria-label="Filter by action">
          <option value="">All actions</option>
          {vocabulary.actions
            .filter((a) => !filters.module || a.startsWith(`${filters.module}.`))
            .map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={filters.userId ?? ''} onChange={(e) => setFilter('userId', e.target.value || null)} aria-label="Filter by person">
          <option value="">Everyone</option>
          {(data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </select>
        <input placeholder="Record" value={filters.recordRef}
          onChange={(e) => setFilter('recordRef', e.target.value)} aria-label="Filter by record reference" />
        <input type="date" value={filters.dateFrom ?? ''} onChange={(e) => setFilter('dateFrom', e.target.value || null)} aria-label="From date" />
        <input type="date" value={filters.dateTo ?? ''} onChange={(e) => setFilter('dateTo', e.target.value || null)} aria-label="To date" />
        {activeCount > 0 && (
          <button className="btn btn--ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</button>
        )}
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <table className="table table--audit">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Record</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={5} className="muted">Loading the trail…</td></tr>}
          {!loading && data && data.items.length === 0 && (
            <tr><td colSpan={5} className="muted">Nothing was recorded for these filters.</td></tr>
          )}
          {!loading && data?.items.map((entry) => (
            <AuditRow
              key={entry.id}
              entry={entry}
              open={expanded === entry.id}
              onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
            />
          ))}
        </tbody>
      </table>

      {data && data.pageCount > 1 && (
        <div className="pager">
          <button className="btn" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
          <span className="muted">Page {data.page} of {data.pageCount} · {data.total.toLocaleString()} entries</span>
          <button className="btn" disabled={data.page >= data.pageCount} onClick={() => setPage(data.page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

function AuditRow({ entry, open, onToggle }: { entry: AuditEntry; open: boolean; onToggle: () => void }) {
  const hasDetail = entry.changes.length > 0 || Boolean(entry.summary);

  return (
    <>
      <tr className={open ? 'audit__row--open' : ''}>
        <td className="audit__when">{formatMoment(entry.createdAt)}</td>
        <td>{entry.userName ?? <span className="muted">Unknown</span>}</td>
        <td><span className={`badge ${TONE_CLASS[entry.tone]}`}>{entry.label}</span><span className="muted audit__action"> {entry.action}</span></td>
        <td>{entry.recordRef ?? <span className="muted">—</span>}{entry.recordType && <span className="muted"> · {entry.recordType}</span>}</td>
        <td>
          {hasDetail ? (
            <button className="link" onClick={onToggle} aria-expanded={open}>
              {open ? 'Hide' : `${entry.changes.length || Object.keys(entry.summary ?? {}).length} change${(entry.changes.length || Object.keys(entry.summary ?? {}).length) === 1 ? '' : 's'}`}
            </button>
          ) : <span className="muted">—</span>}
        </td>
      </tr>
      {open && hasDetail && (
        <tr className="audit__detail-row">
          <td colSpan={5}>
            {entry.changes.length > 0 ? (
              <table className="table table--nested">
                <thead><tr><th>Field</th><th>Was</th><th>Became</th></tr></thead>
                <tbody>
                  {entry.changes.map((change) => (
                    <tr key={change.field}>
                      <td>{change.field}</td>
                      <td className="muted">{renderValue(change.old)}</td>
                      <td><strong>{renderValue(change.new)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <dl className="audit__summary">
                {Object.entries(entry.summary ?? {}).map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
                ))}
              </dl>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
