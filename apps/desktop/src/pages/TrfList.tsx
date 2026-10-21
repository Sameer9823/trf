import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Customer, Department, Priority, Product, TrfListItem, TrfListPage, TrfSortField, TrfStatus } from '@trf/shared';
import { DEFAULT_TRF_FILTERS, PRIORITIES, TRF_STATUSES, canEditTrfPartA, canEditTrfPartB, canDeleteTrf } from '@trf/shared';
import { messageOf, toQuery } from '../lib/api';
import { useTrfSort } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { OverdueBadge, PriorityBadge, StatusBadge, ArdWorkflowBadge, formatDate } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { useServerStatus } from '../lib/server-status';

interface ColumnDef {
  field: TrfSortField | null;
  label: string;
  className?: string;
  alwaysVisible: boolean;
}

const ALL_COLUMNS: ColumnDef[] = [
  { field: 'trfNumber', label: 'TRF No.', className: 'col-trf-number', alwaysVisible: true },
  { field: 'trfDate', label: 'Date', alwaysVisible: true },
  { field: 'customerName', label: 'Customer', alwaysVisible: true },
  { field: 'productName', label: 'Product', alwaysVisible: true },
  { field: 'batchNumber', label: 'Batch', alwaysVisible: true },
  { field: 'priority', label: 'Priority', className: 'col-priority', alwaysVisible: false },
  { field: 'status', label: 'Status', alwaysVisible: true },
  { field: 'requiredCompletionDate', label: 'Due Date', alwaysVisible: true },
  { field: null, label: 'Assigned', className: 'col-assigned', alwaysVisible: false },
  { field: 'workflowStatus', label: 'ARD Stage', alwaysVisible: true },
  { field: null, label: 'ARD Analyst', alwaysVisible: true },
  { field: 'tat', label: 'TAT', alwaysVisible: true },
];

const DEFAULT_VISIBLE = ALL_COLUMNS.filter((c) => c.alwaysVisible).map((c) => c.label);

export function TrfList() {
  const { state } = useServerStatus();
  const { can, employee } = useAuth();
  const [params, setParams] = useSearchParams();
  const { sortBy, sortDir, toggleSort } = useTrfSort();

  const [data, setData] = useState<TrfListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => new Set(DEFAULT_VISIBLE));
  const [showColumnToggle, setShowColumnToggle] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TrfListItem | null>(null);
  const [confirmDeleteText, setConfirmDeleteText] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const canEditAny = employee ? (canEditTrfPartA(employee) || canEditTrfPartB(employee)) : false;
  const canDeleteAny = employee ? canDeleteTrf(employee) : false;

  const columns = useMemo(() => ALL_COLUMNS.filter((c) => visibleCols.has(c.label) || c.alwaysVisible), [visibleCols]);

  const toggleColumn = (label: string) => {
    const next = new Set(visibleCols);
    if (next.has(label)) next.delete(label); else next.add(label);
    setVisibleCols(next);
  };

  const toggleDelete = (trf: TrfListItem) => {
    setDeleteTarget(trf);
    setConfirmDeleteText('');
  };

  const confirmDelete = async () => {
    const trf = deleteTarget;
    if (!trf) return;
    const res = await window.trf.request<{ ok: true }>({ method: 'DELETE', path: `/api/trfs/${trf.id}` });
    setDeleteTarget(null);
    if (res.ok) {
      setData((prev) => prev ? { ...prev, items: prev.items.filter((t) => t.id !== trf.id), total: prev.total - 1 } : prev);
      setError(null);
    } else {
      setError(messageOf(res.data, 'This TRF could not be deleted.'));
    }
  };

  // Filters live in the URL so a filtered list can be bookmarked or shared internally.
  const filters = useMemo(() => ({
    search: params.get('search') ?? DEFAULT_TRF_FILTERS.search,
    status: (params.get('status') ? params.get('status')!.split(',') : []) as TrfStatus[],
    priority: (params.get('priority') ? params.get('priority')!.split(',') : []) as Priority[],
    customerId: params.get('customerId') ? Number(params.get('customerId')) : undefined,
    productId: params.get('productId') ? Number(params.get('productId')) : undefined,
    departmentId: params.get('departmentId') ? Number(params.get('departmentId')) : undefined,
    assignedEmployeeId: params.get('assignedEmployeeId') ? Number(params.get('assignedEmployeeId')) : undefined,
    dateFrom: params.get('dateFrom') ?? undefined,
    dateTo: params.get('dateTo') ?? undefined,
    overdueOnly: params.get('overdueOnly') === 'true',
    page: Number(params.get('page') ?? 1),
  }), [params]);

  const setFilter = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '' || value === 'false') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const toggleMulti = (key: 'status' | 'priority', value: string, current: string[]) => {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilter(key, next.join(','));
  };

  const setPage = (page: number) => {
    const next = new URLSearchParams(params);
    if (page <= 1) next.delete('page'); else next.set('page', String(page));
    setParams(next, { replace: true });
  };

  useEffect(() => {
    void window.trf.request<{ items: Customer[] }>({ method: 'GET', path: '/api/lookups/customers' })
      .then((r) => { if (r.ok && r.data) setCustomers(r.data.items); });
    void window.trf.request<{ items: Product[] }>({ method: 'GET', path: '/api/lookups/products' })
      .then((r) => { if (r.ok && r.data) setProducts(r.data.items); });
    void window.trf.request<{ items: Department[] }>({ method: 'GET', path: '/api/departments' })
      .then((r) => { if (r.ok && r.data) setDepartments(r.data.items); });
  }, []);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const query = toQuery({ ...filters, sortBy, sortDir });
    void window.trf.request<TrfListPage>({ method: 'GET', path: `/api/trfs?${query}` })
      .then((res) => {
        if (cancelled) return;
        setLoading(false);
        if (!res.ok || !res.data) {
          setError(res.status === 0 ? 'Company server is unavailable. Please connect to the company network.' : messageOf(res.data, 'TRFs could not be loaded.'));
          setData(null);
          return;
        }
        setError(null);
        setData(res.data);
      });
    return () => { cancelled = true; };
  }, [filters, sortBy, sortDir, state]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  const activeFilterCount = [
    filters.search, filters.customerId, filters.productId, filters.departmentId,
    filters.dateFrom, filters.dateTo, filters.assignedEmployeeId,
  ].filter(Boolean).length + filters.status.length + filters.priority.length + (filters.overdueOnly ? 1 : 0);

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>TRF Management</h1>
        <div className="row">
          {can('trf.create') && <a className="btn btn--primary" href="#/trfs/new">New TRF</a>}
          {can('reports.export') && (
            <ExportButton
              label="Export to Excel"
              filters={{
                search: filters.search,
                status: filters.status.join(','),
                employeeId: filters.assignedEmployeeId,
                dateFrom: filters.dateFrom,
                dateTo: filters.dateTo,
                overdueOnly: filters.overdueOnly,
              }}
            />
          )}
        </div>
      </div>

      <div className="filters">
        <input
          placeholder="Search TRF No., product, batch, customer or employee"
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
          aria-label="Search TRFs"
        />
        <button className="btn" onClick={() => setShowFilters((v) => !v)}>
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </button>
        <div className="col-toggle">
          <button className="btn" onClick={() => setShowColumnToggle((v) => !v)} aria-label="Toggle column visibility">
            Columns
          </button>
        </div>
        {activeFilterCount > 0 && (
          <button className="btn btn--ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</button>
        )}
      </div>

      {showColumnToggle && (
        <div className="col-toggle__panel">
          {ALL_COLUMNS.filter((c) => !c.alwaysVisible).map((c) => (
            <label key={c.label} className="col-toggle__item">
              <input type="checkbox"
                checked={visibleCols.has(c.label)}
                onChange={() => toggleColumn(c.label)}
              />
              {c.label}
            </label>
          ))}
        </div>
      )}

      {showFilters && (
        <div className="filters filters--panel">
          <div className="filters__group">
            <span className="filters__label">Status</span>
            <div className="chips">
              {TRF_STATUSES.map((s) => (
                <button key={s} className={`chip ${filters.status.includes(s) ? 'chip--on' : ''}`}
                  onClick={() => toggleMulti('status', s, filters.status)}>{s}</button>
              ))}
            </div>
          </div>
          <div className="filters__group">
            <span className="filters__label">Priority</span>
            <div className="chips">
              {PRIORITIES.map((p) => (
                <button key={p} className={`chip ${filters.priority.includes(p) ? 'chip--on' : ''}`}
                  onClick={() => toggleMulti('priority', p, filters.priority)}>{p}</button>
              ))}
            </div>
          </div>
          <div className="filters__group filters__row">
            <label>
              Customer
              <select value={filters.customerId ?? ''} onChange={(e) => setFilter('customerId', e.target.value)}>
                <option value="">All</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>
              Product
              <select value={filters.productId ?? ''} onChange={(e) => setFilter('productId', e.target.value)}>
                <option value="">All</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>
              Department
              <select value={filters.departmentId ?? ''} onChange={(e) => setFilter('departmentId', e.target.value)}>
                <option value="">All</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          </div>
          <div className="filters__group filters__row">
            <label>TRF date from<input type="date" value={filters.dateFrom ?? ''} onChange={(e) => setFilter('dateFrom', e.target.value)} /></label>
            <label>TRF date to<input type="date" value={filters.dateTo ?? ''} onChange={(e) => setFilter('dateTo', e.target.value)} /></label>
            <label className="filters__check">
              <input type="checkbox" checked={filters.overdueOnly}
                onChange={(e) => setFilter('overdueOnly', e.target.checked ? 'true' : null)} />
              Overdue only
            </label>
          </div>
        </div>
      )}

      {error && <p className="error-text" role="alert">{error}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.label} className={column.className}>
                  {column.field ? (
                    <button className="th-sort" onClick={() => toggleSort(column.field!)}>
                      {column.label}
                      <span className="th-sort__mark">{sortBy === column.field ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  ) : column.label}
                </th>
              ))}
              <th className="col-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={columns.length + 1} className="muted">Loading…</td></tr>}
            {!loading && data && data.items.length === 0 && (
              <tr><td colSpan={columns.length + 1} className="muted">
                No TRFs match these filters. Clear the filters, or create the first TRF.
              </td></tr>
            )}
            {!loading && data?.items.map((trf) => <TrfRow key={trf.id} trf={trf} columns={columns} canEditAny={canEditAny} canDeleteAny={canDeleteAny} onDelete={() => toggleDelete(trf)} />)}
          </tbody>
        </table>
      </div>

      {data && (
        <div className="pager">
          <span className="muted">{data.total} TRF(s) · page {data.page} of {data.pageCount}</span>
          <span className="row">
            <button className="btn" disabled={data.page <= 1}
              onClick={() => setPage(data.page - 1)}>Previous</button>
            <button className="btn" disabled={data.page >= data.pageCount}
              onClick={() => setPage(data.page + 1)}>Next</button>
          </span>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-title">
          <div className="modal modal--danger">
            <h2 id="delete-title">Delete TRF {deleteTarget.trfNumber}?</h2>
            <p className="muted">This cannot be undone. Enter the TRF number to confirm.</p>
            <input
              value={confirmDeleteText}
              onChange={(e) => setConfirmDeleteText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmDelete(); }}
              placeholder={deleteTarget.trfNumber}
              className="field--error"
            />
            <div className="modal__actions">
              <button className="btn" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button
                className="btn btn--danger"
                disabled={confirmDeleteText !== deleteTarget.trfNumber}
                onClick={confirmDelete}
              >Delete</button>
            </div>
            {error && <p className="error-text">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function TrfRow({ trf, columns, canEditAny, canDeleteAny, onDelete }: {
  trf: TrfListItem; columns: ColumnDef[]; canEditAny: boolean; canDeleteAny: boolean;
  onDelete: () => void;
}) {
  const canDelete = canDeleteAny && trf.status === 'New';
  const showEdit = canEditAny && trf.status !== 'Completed' && trf.status !== 'Cancelled';

  const cellContent = (column: ColumnDef) => {
    switch (column.label) {
      case 'TRF No.':
        return <a className="link nowrap" href={`#/trfs/${trf.id}`}>{trf.trfNumber}</a>;
      case 'Date':
        return <span className="nowrap">{formatDate(trf.trfDate)}</span>;
      case 'Customer':
        return <span className="muted-cell">{trf.customerName ?? '—'}</span>;
      case 'Product':
        return <span className="muted-cell">{trf.productName ?? '—'}</span>;
      case 'Batch':
        return <span className="muted-cell">{trf.batchNumber ?? '—'}</span>;
      case 'Priority':
        return <PriorityBadge priority={trf.priority} />;
      case 'Status':
        return (
          <span className="nowrap">
            <StatusBadge status={trf.status} />
            {trf.isOverdue && <OverdueBadge />}
          </span>
        );
      case 'Due Date':
        return <span className="nowrap">{formatDate(trf.requiredCompletionDate)}</span>;
      case 'Assigned':
        return <span className="muted-cell">{trf.assignedEmployeeName ?? '—'}</span>;
      case 'ARD Stage':
        return <ArdWorkflowBadge status={trf.workflowStatus} />;
      case 'ARD Analyst':
        return <span className="muted-cell">{trf.analystName ?? '—'}</span>;
      case 'TAT':
        return <span className="nowrap">{trf.tat?.toString() ?? '—'}</span>;
      default:
        return null;
    }
  };

  return (
    <tr>
      {columns.map((column) => (
        <td key={column.label} className={column.className}>
          {cellContent(column)}
        </td>
      ))}
      <td className="col-actions">
        <div className="table-actions">
          {showEdit && (
            <a className="btn-icon" href={`#/trfs/${trf.id}/edit`} aria-label="Edit TRF" title="Edit">
              <span aria-hidden>✏</span>
            </a>
          )}
          {canDelete && (
            <button className="btn-icon btn-icon--danger" aria-label="Delete TRF" title="Delete" onClick={onDelete}>
              <span aria-hidden>✕</span>
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
