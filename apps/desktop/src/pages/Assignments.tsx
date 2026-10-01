import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Assignment, AssignmentGroup, EmployeeProfile, TestCatalogItem, WorkloadRow } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { assignmentApi, assignmentStatusLabel, assignmentStatusTone, toAssignmentQuery } from '../lib/assignments';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { PriorityBadge, StatusBadge, formatDate } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { useServerStatus } from '../lib/server-status';

type View = 'byTrf' | 'workload' | 'mine';

const STATUSES = ['Pending', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled', 'Delayed'];

export function Assignments() {
  const { state } = useServerStatus();
  const { can, employee } = useAuth();
  const [params, setParams] = useSearchParams();

  const mayManage = can('assignments.manage');
  const [view, setView] = useState<View>(mayManage ? 'byTrf' : 'mine');
  const [data, setData] = useState<Assignment[]>([]);
  const [groups, setGroups] = useState<AssignmentGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [workload, setWorkload] = useState<WorkloadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reassign, setReassign] = useState<Assignment | null>(null);
  const [nonce, setNonce] = useState(0);

  const filters = useMemo(() => ({
    search: params.get('search') ?? '',
    status: params.get('status') ? params.get('status')!.split(',') : [],
    employeeId: params.get('employeeId') ? Number(params.get('employeeId')) : undefined,
    trfNumber: params.get('trfNumber') ?? '',
    dueFrom: params.get('dueFrom') ?? undefined,
    dueTo: params.get('dueTo') ?? undefined,
    delayedOnly: params.get('delayedOnly') === 'true',
  }), [params]);

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'false') next.delete(key); else next.set(key, value);
    next.delete('page');
    setParams(next, { replace: true });
  };

  const goToPage = (target: number) => {
    const next = new URLSearchParams(params);
    if (target <= 1) next.delete('page'); else next.set('page', String(target));
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const query = toAssignmentQuery({
      ...filters,
      page: Number(params.get('page') ?? 1),
      groupByTrf: view === 'byTrf',
      // "My work" is the same endpoint with the signed-in employee as the filter.
      employeeId: view === 'mine' && employee ? employee.id : filters.employeeId,
    });
    void assignmentApi.list(query).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) { setError(res.message ?? MESSAGES.SERVER_UNAVAILABLE); return; }
      setError(null);
      setTotal(res.data.total);
      setPageCount(res.data.pageCount);
      if (view === 'byTrf') {
        setGroups((res.data as unknown as import('@trf/shared').AssignmentGroupPage).items);
        setData([]);
      } else {
        setData(res.data.items);
        setGroups([]);
      }
    });
    return () => { cancelled = true; };
  }, [filters, params, view, employee, state, nonce]);

  useEffect(() => {
    if (view !== 'workload' || state === 'offline') return;
    let cancelled = false;
    void assignmentApi.workload().then((rows) => { if (!cancelled) setWorkload(rows); });
    return () => { cancelled = true; };
  }, [view, state, nonce]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  const views: { key: View; label: string }[] = [
    ...(mayManage ? [{ key: 'byTrf' as View, label: 'By TRF' }, { key: 'workload' as View, label: 'Workload' }] : []),
    { key: 'mine', label: mayManage ? 'All assignments' : 'My assignments' },
  ];

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>Assignments</h1>
        <div className="row">
          {views.length > 1 && (
            <div className="tabs tabs--inline">
              {views.map((v) => (
                <button key={v.key} className={`tab ${view === v.key ? 'tab--active' : ''}`} onClick={() => setView(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <ExportButton
            label="Export to Excel"
            sheet="Assignments"
            filters={{
              search: filters.search,
              status: filters.status.join(','),
              employeeId: filters.employeeId,
              trfNumber: filters.trfNumber,
              dueFrom: filters.dueFrom,
              dueTo: filters.dueTo,
              delayedOnly: filters.delayedOnly,
            }}
          />
        </div>
      </div>

      {view !== 'workload' && (
        <div className="filters">
          <input placeholder="Search TRF, test, batch, customer or employee" value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)} aria-label="Search assignments" />
          <select value={filters.status.join(',')} onChange={(e) => setFilter('status', e.target.value || null)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input placeholder="TRF number" value={filters.trfNumber}
            onChange={(e) => setFilter('trfNumber', e.target.value)} aria-label="Filter by TRF number" />
          <label className="filters__check">
            <input type="checkbox" checked={filters.delayedOnly}
              onChange={(e) => setFilter('delayedOnly', e.target.checked ? 'true' : null)} />
            Delayed only
          </label>
        </div>
      )}

      {error && <p className="error-text" role="alert">{error}</p>}

      {view === 'workload' && (
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th><th>Department</th><th className="num">Pending</th>
              <th className="num">In Progress</th><th className="num">Delayed</th>
              <th className="num">Open total</th><th className="num">Completed</th><th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="muted">Loading…</td></tr>}
            {!loading && workload.length === 0 && (
              <tr><td colSpan={8} className="muted">No open work is assigned to anyone yet.</td></tr>
            )}
            {!loading && workload.map((row) => (
              <tr key={row.employeeId}>
                <td>{row.employeeName}</td>
                <td>{row.departmentName ?? '—'}</td>
                <td className="num">{row.pending}</td>
                <td className="num">{row.inProgress}</td>
                <td className="num">{row.delayed > 0 ? <span className="badge badge--danger">{row.delayed}</span> : 0}</td>
                <td className="num"><strong>{row.openTotal}</strong></td>
                <td className="num">{row.completed}</td>
                <td><a className="link" href={`#/assignments?employeeId=${row.employeeId}`}>View work</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view === 'byTrf' && (
        <div className="groups">
          {loading && <p className="muted">Loading…</p>}
          {!loading && groups.length === 0 && (
            <div className="notice">
              <strong>No tests are assigned yet.</strong>
              <p className="muted">Open a TRF and use “Assign tests” to give work to your analysts.</p>
            </div>
          )}
          {!loading && groups.map((group) => (
            <TrfGroup key={group.trfId} group={group} mayManage={mayManage}
              onReassign={setReassign} />
          ))}
        </div>
      )}

      {view === 'mine' && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>TRF No.</th><th>Test</th><th>Product</th><th>Batch No.</th>
                <th>Assigned Date</th><th>Due Date</th><th>Status</th>
                {mayManage && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={mayManage ? 8 : 7} className="muted">Loading…</td></tr>}
              {!loading && data.length === 0 && (
                <tr><td colSpan={mayManage ? 8 : 7} className="muted">
                  {view === 'mine' && !mayManage ? 'You have no assigned tests.' : 'No tests match these filters.'}
                </td></tr>
              )}
              {!loading && data.map((a) => (
                <tr key={a.id}>
                  <td><a className="link" href={`#/trfs/${a.trfId}`}>{a.trfNumber}</a></td>
                  <td>{a.testName}</td>
                  <td>{a.productName ?? '—'}</td>
                  <td>{a.batchNumber ?? '—'}</td>
                  <td>{formatDate(a.assignedDate)}</td>
                  <td>{formatDate(a.dueDate)}</td>
                  <td>
                    <span className={`badge ${assignmentStatusTone(a)}`}>{assignmentStatusLabel(a)}</span>
                    {a.isDelayed && a.status !== 'Completed' && a.status !== 'Cancelled' && (
                      <span className="muted"> due {formatDate(a.dueDate)}</span>
                    )}
                  </td>
                  {mayManage && (
                    <td className="table__actions">
                      <button className="btn btn--ghost" onClick={() => setReassign(a)}>Reassign</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {!loading && (
            <div className="pager">
              <span className="muted">{total} assignment(s)</span>
              <span className="row">
                <button className="btn" disabled={page <= 1} onClick={() => goToPage(page - 1)}>Previous</button>
                <button className="btn" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>Next</button>
              </span>
            </div>
          )}
        </>
      )}

      {reassign && (
        <ReassignDialog assignment={reassign} onClose={() => setReassign(null)}
          onSaved={() => { setReassign(null); setNonce((n) => n + 1); }} />
      )}
    </div>
  );
}

/** TRF -> tests -> employee, the layout the Manager asked for. */
function TrfGroup({ group, mayManage, onReassign }: {
  group: AssignmentGroup; mayManage: boolean; onReassign: (a: Assignment) => void;
}) {
  return (
    <section className="panel">
      <div className="group__head">
        <div>
          <a className="link link--lg" href={`#/trfs/${group.trfId}`}>{group.trfNumber}</a>
          <StatusBadge status={group.trfStatus} />
          <span className="muted"> {group.productName ?? 'No product'} · {group.batchNumber ?? 'No batch'}</span>
          {group.customerName && <span className="muted"> · {group.customerName}</span>}
        </div>
        <div className="row">
          <PriorityBadge priority={group.priority} />
          <span className="muted">Due {formatDate(group.requiredCompletionDate)}</span>
          {mayManage && <a className="btn btn--primary" href={`#/trfs/${group.trfId}?assign=1`}>Assign tests</a>}
        </div>
      </div>
      <table className="table table--nested">
        <thead>
          <tr><th>Test</th><th>Method</th><th>Specification</th><th>Assigned Employee</th><th>Due Date</th><th>Status</th>{mayManage && <th aria-label="Actions" />}</tr>
        </thead>
        <tbody>
          {group.tests.map((a) => (
            <tr key={a.id}>
              <td><strong>{a.testName}</strong></td>
              <td>{a.testMethod ?? '—'}</td>
              <td>{a.specification ?? '—'}</td>
              <td>{a.assignedEmployeeName ?? '—'}</td>
              <td>{formatDate(a.dueDate)}</td>
              <td><span className={`badge ${assignmentStatusTone(a)}`}>{assignmentStatusLabel(a)}</span></td>
              {mayManage && (
                <td className="table__actions">
                  <button className="btn btn--ghost" onClick={() => onReassign(a)}>Reassign</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ReassignDialog({ assignment, onClose, onSaved }: {
  assignment: Assignment; onClose: () => void; onSaved: () => void;
}) {
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [employeeId, setEmployeeId] = useState(String(assignment.assignedEmployeeId ?? ''));
  const [dueDate, setDueDate] = useState(assignment.dueDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void assignmentApi.assignables().then(setEmployees); }, []);

  async function save() {
    setBusy(true);
    setError(null);
    const res = await assignmentApi.update(assignment.id, assignment.version, {
      assignedEmployeeId: employeeId ? Number(employeeId) : null,
      dueDate: dueDate || null,
    });
    setBusy(false);
    if (!res.ok) { setError(res.message ?? 'The assignment could not be changed.'); return; }
    onSaved();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Reassign test">
      <div className="modal">
        <h2>Reassign {assignment.testName}</h2>
        <p className="muted">{assignment.trfNumber}{assignment.batchNumber ? ` · ${assignment.batchNumber}` : ''}</p>
        {error && <p className="error-text" role="alert">{error}</p>}

        <label htmlFor="reassign-employee">Employee</label>
        <select id="reassign-employee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Not assigned</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName}{e.role !== 'Analyst' ? ` (${e.role})` : ''}</option>)}
        </select>

        <label htmlFor="reassign-due">Due date</label>
        <input id="reassign-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />

        <div className="row modal__actions">
          <button className="btn btn--primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export { STATUSES as ASSIGNMENT_STATUS_OPTIONS };
export type { TestCatalogItem };