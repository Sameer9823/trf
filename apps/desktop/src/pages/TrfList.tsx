import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Customer, Department, Priority, Product, TrfListItem, TrfListPage, TrfSortField, TrfStatus } from '@trf/shared';
import { DEFAULT_TRF_FILTERS, PRIORITIES, TRF_STATUSES, LIST_FIELD_ORDER, listFieldLabel, canEditTrfPartA, canEditTrfPartB, canDeleteTrf } from '@trf/shared';
import { messageOf, toQuery } from '../lib/api';
import { useTrfSort } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { OverdueBadge, PriorityBadge, StatusBadge, ArdFinalStatusBadge, ArdStageBadge, ArdCoaBadge, ArdReportingBadge, RemarksStatusBadge, ArdRemarksStatusBadge, formatDate } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { useServerStatus } from '../lib/server-status';

interface ColumnDef {
  field: TrfSortField | null;
  label: string;
  className?: string;
  alwaysVisible: boolean;
}

/**
 * The list columns follow the shared field order, so the list, the form, the
 * detail page, the printable TRF and the Excel sheet all read in the same
 * sequence. The operational columns at the end are not part of the TRF record
 * itself.
 */
const RECORD_COLUMNS: ColumnDef[] = LIST_FIELD_ORDER.map((field) => ({
  field: field.key as TrfSortField,
  label: listFieldLabel(field),
  alwaysVisible: field.key === 'trfNumber',
}));

const ALL_COLUMNS: ColumnDef[] = [
  ...RECORD_COLUMNS,
  { field: 'status', label: 'Status', alwaysVisible: false },
  { field: 'priority', label: 'Priority', className: 'col-priority', alwaysVisible: false },
  { field: 'assignedEmployeeName', label: 'Assigned', className: 'col-assigned', alwaysVisible: false },
  { field: null, label: 'Overdue', alwaysVisible: false },
];

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
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('trfListHiddenColumns') : null;
    if (saved) { try { return new Set(JSON.parse(saved) as string[]); } catch { } }
    return new Set<string>();
  });
  const [showColumnToggle, setShowColumnToggle] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TrfListItem | null>(null);
  const [confirmDeleteText, setConfirmDeleteText] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const canEditAny = employee ? (canEditTrfPartA(employee) || canEditTrfPartB(employee)) : false;
  const canDeleteAny = employee ? canDeleteTrf(employee) : false;

  const columns = useMemo(
    () => ALL_COLUMNS.filter((c) => c.alwaysVisible || !hiddenCols.has(c.label)),
    [hiddenCols],
  );

  const toggleColumn = (label: string) => {
    const next = new Set(hiddenCols);
    if (next.has(label)) next.delete(label); else next.add(label);
    setHiddenCols(next);
    if (typeof localStorage !== 'undefined') localStorage.setItem('trfListHiddenColumns', JSON.stringify([...next]));
  };

  const showAllColumns = () => {
    setHiddenCols(new Set<string>());
    if (typeof localStorage !== 'undefined') localStorage.removeItem('trfListHiddenColumns');
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
          <button className="btn btn--ghost" onClick={showAllColumns}>Show all columns</button>
          {ALL_COLUMNS.filter((c) => !c.alwaysVisible).map((c) => (
            <label key={c.label} className="col-toggle__item">
              <input type="checkbox"
                checked={!hiddenCols.has(c.label)}
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
        <table className="table table--wide">
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

const TRUNCATE_FIELDS = new Set([
   'Market/Customer', 'Product Name', 'Batch Number', 'Batch Size', 'Dosage Form',
   'Manufacturing Location', 'Label Claim', 'Pack Size', 'Pack Type',
   'Storage Condition', 'Storage Period', 'Test Requested', 'Test Details',
   'Analysis Required For / Purpose', 'Remarks', 'Sample Submitted By',
   'A.R. No.', 'Analyst Name', 'ARD Remark', 'Reporting', 'COA', 'Remarks / Status',
   'ARD Remarks / Status', 'Signature / Date',
]);

function TrfRow({ trf, columns, canEditAny, canDeleteAny, onDelete }: {
  trf: TrfListItem; columns: ColumnDef[]; canEditAny: boolean; canDeleteAny: boolean;
  onDelete: () => void;
}) {
  const canDelete = canDeleteAny && trf.status === 'New';
  const showEdit = canEditAny && trf.status !== 'Completed' && trf.status !== 'Cancelled';

  const rawCell = (column: ColumnDef): { node: ReactNode; text: string | null } => {
    switch (column.label) {
      case 'TRF No.':
        return { node: <a className="link nowrap" href={`#/trfs/${trf.id}`}>{trf.trfNumber}</a>, text: null };
      case 'Date of Request':
        return { node: <span className="nowrap">{formatDate(trf.trfDate)}</span>, text: null };
      case 'Product Name':
        return { node: <span className="muted-cell">{trf.productName ?? '—'}</span>, text: trf.productName };
      case 'Batch Number':
        return { node: <span className="muted-cell">{trf.batchNumber ?? '—'}</span>, text: trf.batchNumber };
      case 'Batch Size':
        return { node: <span className="muted-cell">{trf.batchSize ?? '—'}</span>, text: trf.batchSize };
      case 'Market/Customer':
        return { node: <span className="muted-cell">{trf.customerName ?? '—'}</span>, text: trf.customerName };
      case 'Dosage Form':
        return { node: <span className="muted-cell">{trf.dosageForm ?? '—'}</span>, text: trf.dosageForm };
      case 'Manufacturing Location':
        return { node: <span className="muted-cell">{trf.manufacturingLocation ?? '—'}</span>, text: trf.manufacturingLocation };
      case 'Label Claim':
        return { node: <span className="muted-cell">{trf.labelClaim ?? '—'}</span>, text: trf.labelClaim };
      case 'Pack Size':
        return { node: <span className="muted-cell">{trf.packSize ?? '—'}</span>, text: trf.packSize };
      case 'Pack Type':
        return { node: <span className="muted-cell">{trf.packType ?? '—'}</span>, text: trf.packType };
      case 'Storage Condition':
        return { node: <span className="muted-cell">{trf.storageCondition ?? '—'}</span>, text: trf.storageCondition };
      case 'Storage Period':
        return { node: <span className="muted-cell">{trf.storagePeriod ?? '—'}</span>, text: trf.storagePeriod };
      case 'Manufacturing Date':
        return { node: <span className="nowrap">{formatDate(trf.manufacturingDate)}</span>, text: null };
      case 'Expiry Date':
        return { node: <span className="nowrap">{formatDate(trf.expiryDate)}</span>, text: null };
      case 'Test Requested':
        return { node: <span className="muted-cell">{trf.requestedAnalysis ?? '—'}</span>, text: trf.requestedAnalysis };
      case 'Test Details':
        return { node: <span className="muted-cell">{trf.specialInstructions ?? '—'}</span>, text: trf.specialInstructions };
      case 'Analysis Required For / Purpose':
        return { node: <span className="muted-cell">{trf.analysisPurpose ?? '—'}</span>, text: trf.analysisPurpose };
      case 'Required Completion Date':
        return { node: <span className="nowrap">{formatDate(trf.requiredCompletionDate)}</span>, text: null };
      case 'Sample Quantity':
        return { node: <span className="muted-cell">{trf.sampleQuantity ?? '—'}</span>, text: trf.sampleQuantity };
      case 'Sample Submitted By':
        return {
          node: <span className="muted-cell">{trf.sampleSubmittedByName ?? trf.sampleGivenBy ?? '—'}</span>,
          text: trf.sampleSubmittedByName ?? trf.sampleGivenBy,
        };
      case 'Remarks / Status':
        return { node: <RemarksStatusBadge status={trf.remarksStatus} />, text: null };
      case 'Remarks':
        return { node: <span className="muted-cell">{trf.remarks ?? '—'}</span>, text: trf.remarks };
      case 'Signature / Date':
        return { node: <span className="nowrap">{formatDate(trf.signatureDate)}</span>, text: null };
      case 'A.R. No.':
        return { node: <span className="muted-cell">{trf.ardNumber ?? '—'}</span>, text: trf.ardNumber };
      case 'Stage':
        return { node: <ArdStageBadge stage={trf.stage} />, text: null };
      case 'Analyst Name':
        return { node: <span className="muted-cell">{trf.analystName ?? '—'}</span>, text: trf.analystName };
      case 'Date of Analysis':
        return { node: <span className="nowrap">{formatDate(trf.analysisStartDate)}</span>, text: null };
      case 'Reporting':
        return { node: <span className="nowrap"><ArdReportingBadge status={trf.reportingStatus} /></span>, text: null };
      case 'COA':
        return { node: <ArdCoaBadge status={trf.coaStatus} />, text: null };
      case 'ARD Remarks / Status':
        return { node: <ArdRemarksStatusBadge status={trf.ardRemarksStatus} />, text: null };
      case 'ARD Remark':
        return { node: <span className="muted-cell">{trf.ardRemarks ?? '—'}</span>, text: trf.ardRemarks };
      case 'TAT':
        return { node: <span className="nowrap">{trf.tat?.toString() ?? '—'}</span>, text: null };
      case 'Final Status':
        if (trf.remarksStatus !== 'Approved') {
          return {
            node: (
              <span className="nowrap">
                <ArdFinalStatusBadge status={trf.workflowStatus} />
                <span className="badge badge--warning badge--small" style={{ marginLeft: 4 }}>Awaiting approval</span>
              </span>
            ),
            text: null,
          };
        }
        return { node: <ArdFinalStatusBadge status={trf.workflowStatus} />, text: null };
      case 'Sample Received Date':
        return { node: <span className="nowrap">{formatDate(trf.sampleReceivedDate)}</span>, text: null };
      case 'Status':
        return {
          node: (
            <span className="nowrap">
              <StatusBadge status={trf.status} />
              {trf.isOverdue && <OverdueBadge />}
            </span>
          ),
          text: null,
        };
      case 'Priority':
        return { node: <PriorityBadge priority={trf.priority} />, text: null };
      case 'Assigned':
        return { node: <span className="muted-cell">{trf.assignedEmployeeName ?? '—'}</span>, text: trf.assignedEmployeeName };
      case 'Overdue':
        return {
          node: trf.isOverdue ? <OverdueBadge /> : <span className="muted-cell">—</span>,
          text: null,
        };
      default:
        return { node: null, text: null };
    }
  };

  const cellContent = (column: ColumnDef) => {
    const { node, text } = rawCell(column);
    if (!node) return null;
    // A long value is cut to one line with an ellipsis, and the whole value is
    // in the tooltip so nothing is lost.
    if (!TRUNCATE_FIELDS.has(column.label) || !text) return node;
    return <span className="truncate" title={text}>{node}</span>;
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
