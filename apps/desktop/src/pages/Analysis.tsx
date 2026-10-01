import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AnalysisItem, AnalysisResultInput, AnalysisSortField, AnalysisSummary, EmployeeProfile } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import {
  ANALYSIS_STATUS_OPTIONS, ANALYSIS_SORTS, OUTCOME_OPTIONS, OFFLINE, analysisApi, outcomeTone, statusTone, toAnalysisQuery,
} from '../lib/analysis';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { PriorityBadge, StatusBadge, formatDate } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';

const STATUS_OPTIONS = [...ANALYSIS_STATUS_OPTIONS, 'Delayed' as const];

export function Analysis() {
  const { state } = useServerStatus();
  const { can, employee } = useAuth();
  const [params, setParams] = useSearchParams();

  const maySeeAll = can('analysis.viewAll');
  const mayRecord = can('analysis.enterResults');
  // Analysts land on their own work; roles that can see everything start there too.
  const [mineOnly, setMineOnly] = useState(!maySeeAll);

  const [items, setItems] = useState<AnalysisItem[]>([]);
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AnalysisItem | null>(null);
  const [nonce, setNonce] = useState(0);

  const filters = useMemo(() => ({
    search: params.get('search') ?? '',
    status: params.get('status') ? params.get('status')!.split(',') : [],
    outcome: params.get('outcome') ? params.get('outcome')!.split(',') : [],
    employeeId: params.get('employeeId') ? Number(params.get('employeeId')) : undefined,
    trfNumber: params.get('trfNumber') ?? '',
    dueFrom: params.get('dueFrom') ?? undefined,
    dueTo: params.get('dueTo') ?? undefined,
    delayedOnly: params.get('delayedOnly') === 'true',
    sortBy: (params.get('sortBy') ?? 'dueDate') as AnalysisSortField,
    sortDir: (params.get('sortDir') ?? 'asc') as 'asc' | 'desc',
  }), [params]);

  const page = Number(params.get('page') ?? 1);

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'false') next.delete(key); else next.set(key, value);
    next.delete('page');
    setParams(next, { replace: true });
  };

  const toggleSort = (field: AnalysisSortField) => {
    const next = new URLSearchParams(params);
    next.set('sortBy', field);
    next.set('sortDir', filters.sortBy === field && filters.sortDir === 'asc' ? 'desc' : 'asc');
    next.delete('page');
    setParams(next, { replace: true });
  };

  const goToPage = (target: number) => {
    const next = new URLSearchParams(params);
    if (target <= 1) next.delete('page'); else next.set('page', String(target));
    setParams(next, { replace: true });
  };

  const query = useMemo(() => toAnalysisQuery({
    ...filters, page, mineOnly: mineOnly && employee ? true : false,
  }), [filters, page, mineOnly, employee]);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void analysisApi.list(query).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) { setError(res.message ?? OFFLINE); return; }
      setError(null);
      setItems(res.data.items);
      setTotal(res.data.total);
      setPageCount(res.data.pageCount);
    });
    return () => { cancelled = true; };
  }, [query, state, nonce]);

  // Counts come from the server over the same scope, so they can never disagree with the list.
  useEffect(() => {
    if (state === 'offline') return;
    let cancelled = false;
    void analysisApi.summary(query).then((res) => { if (!cancelled) setSummary(res); });
    return () => { cancelled = true; };
  }, [query, state, nonce]);

  useEffect(() => {
    if (!maySeeAll || state === 'offline') return;
    void window.trf.request<{ items: EmployeeProfile[] }>({ method: 'GET', path: '/api/employees/assignable' })
      .then((res) => { if (res.ok && res.data) setEmployees(res.data.items); });
  }, [maySeeAll, state]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  const refreshed = (item: AnalysisItem) => {
    setItems((current) => current.map((i) => (i.id === item.id ? item : i)));
    setNonce((n) => n + 1);
  };

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>Analysis</h1>
        <div className="row">
          {maySeeAll && (
            <div className="tabs tabs--inline">
              <button className={`tab ${mineOnly ? 'tab--active' : ''}`} onClick={() => setMineOnly(true)}>My work</button>
              <button className={`tab ${!mineOnly ? 'tab--active' : ''}`} onClick={() => setMineOnly(false)}>All analysis</button>
            </div>
          )}
          <ExportButton
            label="Export to Excel"
            sheet="Analysis"
            filters={{
              search: filters.search,
              status: filters.status.join(','),
              // "My work" is a real narrowing, so the file follows it rather than the tab.
              employeeId: filters.employeeId ?? (mineOnly && employee ? employee.id : undefined),
              trfNumber: filters.trfNumber,
              dueFrom: filters.dueFrom,
              dueTo: filters.dueTo,
              delayedOnly: filters.delayedOnly,
            }}
          />
        </div>
      </div>

      {summary && (
        <div className="stat-row">
          <Stat label="Tests" value={summary.total} />
          <Stat label="In progress" value={summary.inProgress} />
          <Stat label="Completed" value={summary.completed} />
          <Stat label="Passed" value={summary.passed} tone="ok" />
          <Stat label="Failed" value={summary.failed} tone="danger" />
          <Stat label="Re-test" value={summary.reTestRequired} tone="warn" />
          <Stat label="Delayed" value={summary.delayed} tone="danger" />
        </div>
      )}

      <div className="filters">
        <input placeholder="Search TRF, test, batch, customer or result" value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)} aria-label="Search analysis" />
        <select value={filters.status.join(',')} onChange={(e) => setFilter('status', e.target.value || null)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.outcome.join(',')} onChange={(e) => setFilter('outcome', e.target.value || null)} aria-label="Filter by outcome">
          <option value="">All outcomes</option>
          {OUTCOME_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input placeholder="TRF number" value={filters.trfNumber}
          onChange={(e) => setFilter('trfNumber', e.target.value)} aria-label="Filter by TRF number" />
        {maySeeAll && !mineOnly && (
          <select value={filters.employeeId ?? ''} onChange={(e) => setFilter('employeeId', e.target.value || null)} aria-label="Filter by employee">
            <option value="">Everyone</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
          </select>
        )}
        <label className="filters__check">
          <input type="checkbox" checked={filters.delayedOnly}
            onChange={(e) => setFilter('delayedOnly', e.target.checked ? 'true' : null)} />
          Delayed only
        </label>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <table className="table">
        <thead>
          <tr>
            <SortHeader label="TRF No." field="trfNumber" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <SortHeader label="Test" field="testName" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <th>Product / Batch</th>
            <SortHeader label="Due Date" field="dueDate" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <SortHeader label="Status" field="status" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <SortHeader label="Outcome" field="outcome" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <th>Result</th>
            <th>Dates</th>
            {mayRecord && <th aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={9} className="muted">Loading…</td></tr>}
          {!loading && items.length === 0 && (
            <tr><td colSpan={9} className="muted">
              {mineOnly ? 'You have no open analysis work.' : 'No tests match these filters.'}
            </td></tr>
          )}
          {!loading && items.map((item) => (
            <AnalysisRow key={item.id} item={item} mayRecord={mayRecord && item.assignedEmployeeId === employee?.id}
              onOpen={() => setEditing(item)} onChanged={refreshed} />
          ))}
        </tbody>
      </table>

      {!loading && (
        <div className="pager">
          <span className="muted">{total} test(s)</span>
          <span className="row">
            <button className="btn" disabled={page <= 1} onClick={() => goToPage(page - 1)}>Previous</button>
            <button className="btn" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>Next</button>
          </span>
        </div>
      )}

      {editing && (
        <ResultDialog item={editing} onClose={() => setEditing(null)}
          onSaved={(updated) => { setEditing(null); refreshed(updated); }} />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="stat">
      <span className={`stat__value ${tone ? `stat__value--${tone}` : ''}`}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

function SortHeader({ label, field, current, dir, onSort }: {
  label: string; field: AnalysisSortField; current: AnalysisSortField; dir: 'asc' | 'desc';
  onSort: (field: AnalysisSortField) => void;
}) {
  const active = current === field;
  return (
    <th>
      <button className="th-sort" onClick={() => onSort(field)} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        {label}{active ? <span aria-hidden="true">{dir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
      </button>
    </th>
  );
}

function AnalysisRow({ item, mayRecord, onOpen, onChanged }: {
  item: AnalysisItem; mayRecord: boolean; onOpen: () => void; onChanged: (item: AnalysisItem) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(run: () => Promise<{ ok: boolean; data?: AnalysisItem; message?: string }>, label: string) {
    setBusy(true);
    setError(null);
    const res = await run();
    setBusy(false);
    if (!res.ok || !res.data) { setError(res.message ?? `${label} failed.`); return; }
    onChanged(res.data);
  }

  const result = item.result;
  return (
    <tr>
      <td>
        <a className="link" href={`#/trfs/${item.trfId}`}>{item.trfNumber}</a>
        <div><PriorityBadge priority={item.priority} /></div>
      </td>
      <td>
        <strong>{item.testName}</strong>
        <div className="muted">{item.testMethod ?? '—'}</div>
        <div className="muted">{item.specification ?? '—'}</div>
      </td>
      <td>
        {item.productName ?? '—'}
        <div className="muted">{item.batchNumber ?? ''}</div>
      </td>
      <td>
        {formatDate(item.dueDate)}
        {item.isDelayed && item.status !== 'Completed' && item.status !== 'Cancelled' && (
          <div><span className="badge badge--danger">Delayed</span></div>
        )}
      </td>
      <td><span className={`badge ${statusTone(item)}`}>{item.status}</span></td>
      <td><span className={`badge ${outcomeTone(item.outcome)}`}>{item.outcome}</span></td>
      <td>
        {result ? (
          <>
            <strong>{result.resultValue ?? result.resultText}</strong>
            {result.resultValue && <span className="muted"> {result.unit ?? ''}</span>}
            {result.resultValue && (result.lowerLimit ?? result.upperLimit) && (
              <div className="muted">Spec {result.lowerLimit ?? '−∞'} – {result.upperLimit ?? '∞'}</div>
            )}
          </>
        ) : <span className="muted">Not recorded</span>}
      </td>
      <td className="muted">
        Start {formatDate(item.startDate)}
        <div>Done {formatDate(item.completionDate)}</div>
      </td>
      {mayRecord && (
        <td className="table__actions">
          {error && <div className="error-text">{error}</div>}
          <div className="row">
            {(item.status === 'Assigned' || item.status === 'Re-test Required' || item.status === 'Pending') && (
              <button className="btn btn--ghost" disabled={busy}
                onClick={() => act(() => analysisApi.start(item.id, item.version), 'Start')}>Start</button>
            )}
            {item.status !== 'Completed' && item.status !== 'Cancelled' && (
              <button className="btn btn--primary" disabled={busy} onClick={onOpen}>
                {result ? 'Edit result' : 'Enter result'}
              </button>
            )}
            {item.status === 'In Progress' && result && (
              <button className="btn btn--ghost" disabled={busy}
                onClick={() => act(() => analysisApi.complete(item.id, item.version), 'Complete')}>Complete</button>
            )}
            {item.status === 'Completed' && (
              <button className="btn btn--ghost" disabled={busy} onClick={onOpen}>Re-test</button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

/**
 * Records the reading, and offers the re-test request once the test is done. The
 * outcome shown here is the one the server computes; the dialog never guesses it.
 */
function ResultDialog({ item, onClose, onSaved }: {
  item: AnalysisItem; onClose: () => void; onSaved: (item: AnalysisItem) => void;
}) {
  const isReTest = item.status === 'Completed';
  const existing = item.result;
  const [value, setValue] = useState(existing?.resultValue ?? '');
  const [text, setText] = useState(existing?.resultText ?? '');
  const [unit, setUnit] = useState(existing?.unit ?? '');
  const [method, setMethod] = useState(existing?.methodUsed ?? item.testMethod ?? '');
  const [lower, setLower] = useState(existing?.lowerLimit ?? '');
  const [upper, setUpper] = useState(existing?.upperLimit ?? '');
  const [remarks, setRemarks] = useState(existing?.remarks ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setFields({});
    const payload: AnalysisResultInput = {
      resultValue: value.trim() || null,
      resultText: text.trim() || null,
      unit: unit.trim() || null,
      methodUsed: method.trim() || null,
      lowerLimit: lower.trim() || null,
      upperLimit: upper.trim() || null,
      remarks: remarks.trim() || null,
    };
    const res = await analysisApi.saveResult(item.id, item.version, payload);
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.message ?? MESSAGES.SERVER_UNAVAILABLE);
      setFields(res.fields ?? {});
      return;
    }
    onSaved(res.data);
  }

  async function requestReTest() {
    if (!note.trim()) { setError('Say why the test is being repeated.'); setFields({ note: 'Say why the test is being repeated.' }); return; }
    setBusy(true);
    setError(null);
    const res = await analysisApi.reTest(item.id, item.version, note.trim());
    setBusy(false);
    if (!res.ok || !res.data) { setError(res.message ?? 'The re-test could not be requested.'); return; }
    onSaved(res.data);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={isReTest ? 'Request a re-test' : 'Record the result'}>
      <div className="modal">
        <h2>{isReTest ? `Request a re-test — ${item.testName}` : `Record the result — ${item.testName}`}</h2>
        <p className="muted">
          {item.trfNumber}
          {item.specification ? ` · ${item.specification}` : ''}
        </p>
        {error && <p className="error-text" role="alert">{error}</p>}

        {isReTest ? (
          <>
            <p className="muted">
              The recorded result is cleared and the test goes back to Re-test Required. It keeps its
              original start date so the turnaround time still measures the whole job.
            </p>
            <label className="field">
              <span>Why is it being repeated?</span>
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                className={fields.note ? 'field--error' : undefined} />
              {fields.note && <span className="field-error">{fields.note}</span>}
            </label>
            {existing && (
              <p className="muted">
                Current result: {existing.resultValue ?? existing.resultText} {existing.unit ?? ''} · {item.outcome}
              </p>
            )}
          </>
        ) : (
          <>
            <label className="field">
              <span>Result</span>
              <input value={value} onChange={(e) => setValue(e.target.value)}
                placeholder="12.5" className={fields.resultValue ? 'field--error' : undefined}
                aria-describedby={fields.resultValue ? 'result-error' : undefined} />
              {fields.resultValue && <span className="field-error" id="result-error">{fields.resultValue}</span>}
            </label>
            <label className="field">
              <span>…or a reading that is not a number</span>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Slight haze, no free-flowing oil" />
            </label>
            <div className="row">
              <label className="field">
                <span>Unit</span>
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="%" />
              </label>
              <label className="field">
                <span>Method used</span>
                <input value={method} onChange={(e) => setMethod(e.target.value)} placeholder="ASTM D1234" />
              </label>
            </div>
            <div className="row">
              <label className="field">
                <span>Lower limit</span>
                <input value={lower} onChange={(e) => setLower(e.target.value)} placeholder="optional"
                  className={fields.lowerLimit ? 'field--error' : undefined} />
                {fields.lowerLimit && <span className="field-error">{fields.lowerLimit}</span>}
              </label>
              <label className="field">
                <span>Upper limit</span>
                <input value={upper} onChange={(e) => setUpper(e.target.value)} placeholder="optional"
                  className={fields.upperLimit ? 'field--error' : undefined} />
                {fields.upperLimit && <span className="field-error">{fields.upperLimit}</span>}
              </label>
            </div>
            <p className="muted">
              With a numeric result and limits, the server decides Pass or Fail. Without limits the
              outcome stays Not Specified, which is not a pass.
            </p>
            <label className="field">
              <span>Remarks</span>
              <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </label>
          </>
        )}

        <div className="row modal__actions">
          <button className="btn btn--primary" disabled={busy}
            onClick={isReTest ? requestReTest : save}>
            {busy ? 'Saving…' : isReTest ? 'Request re-test' : 'Save result'}
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
