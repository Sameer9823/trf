import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Customer, Department, Priority, Product, TrfListItem, TrfListPage, TrfSortField, TrfStatus } from '@trf/shared';
import { DEFAULT_TRF_FILTERS, PRIORITIES, TRF_STATUSES } from '@trf/shared';
import { messageOf, toQuery } from '../lib/api';
import { useTrfSort } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { OverdueBadge, PriorityBadge, StatusBadge, formatDate } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { useServerStatus } from '../lib/server-status';

const COLUMNS: { field: TrfSortField | null; label: string; className?: string }[] = [
  { field: 'trfNumber', label: 'TRF No.' },
  { field: 'trfDate', label: 'TRF Date' },
  { field: 'customerName', label: 'Customer' },
  { field: 'productName', label: 'Product' },
  { field: 'batchNumber', label: 'Batch No.' },
  { field: 'priority', label: 'Priority' },
  { field: 'status', label: 'Status' },
  { field: 'requiredCompletionDate', label: 'Due Date' },
  { field: null, label: 'Assigned Employee' },
];

export function TrfList() {
  const { state } = useServerStatus();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const { sortBy, sortDir, toggleSort } = useTrfSort();

  const [data, setData] = useState<TrfListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [showFilters, setShowFilters] = useState(false);

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
    // Any filter change returns to page one, otherwise a narrower list can land on an empty page.
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
        if (!res.ok || !res.data) { setError(res.status === 0 ? 'Company server is unavailable. Please connect to the company network.' : messageOf(res.data, 'TRFs could not be loaded.')); setData(null); return; }
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
        {activeFilterCount > 0 && (
          <button className="btn btn--ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</button>
        )}
      </div>

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

      <table className="table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.label} className={column.className}>
                {column.field ? (
                  <button className="th-sort" onClick={() => toggleSort(column.field!)}>
                    {column.label}
                    <span className="th-sort__mark">{sortBy === column.field ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                ) : column.label}
              </th>
            ))}
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={COLUMNS.length + 1} className="muted">Loading…</td></tr>}
          {!loading && data && data.items.length === 0 && (
            <tr><td colSpan={COLUMNS.length + 1} className="muted">
              No TRFs match these filters. Clear the filters, or create the first TRF.
            </td></tr>
          )}
          {!loading && data?.items.map((trf) => <TrfRow key={trf.id} trf={trf} />)}
        </tbody>
      </table>

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
    </div>
  );
}

function TrfRow({ trf }: { trf: TrfListItem }) {
  return (
    <tr>
      <td><a className="link" href={`#/trfs/${trf.id}`}>{trf.trfNumber}</a></td>
      <td>{formatDate(trf.trfDate)}</td>
      <td>{trf.customerName ?? '—'}</td>
      <td>{trf.productName ?? '—'}</td>
      <td>{trf.batchNumber ?? '—'}</td>
      <td><PriorityBadge priority={trf.priority} /></td>
      <td>
        <StatusBadge status={trf.status} />
        {trf.isOverdue && <OverdueBadge />}
      </td>
      <td>{formatDate(trf.requiredCompletionDate)}</td>
      <td>{trf.assignedEmployeeName ?? '—'}</td>
      <td><a className="link" href={`#/trfs/${trf.id}`}>Open</a></td>
    </tr>
  );
}
