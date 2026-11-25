import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import type { Customer, Department, EmployeeOption, Priority, Product, TrfListItem, TrfListPage, TrfSortField, TrfStatus, ArdWorkflowStatus } from '@trf/shared';
import { DEFAULT_TRF_FILTERS, PRIORITIES, TRF_STATUSES, ArdWorkflowStatus as ARD_WORKFLOW_STATUSES, LIST_FIELD_ORDER, LIST_HIDDEN_FIELD_KEYS, listFieldLabel, 
canEditTrfPartA, canEditTrfPartB, canDeleteTrf, bulletList, analystNameList } from '@trf/shared';
import { messageOf, toQuery } from '../lib/api';
import { useTrfSort } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { OverdueBadge, PriorityBadge, StatusBadge, ArdFinalStatusBadge, ArdStageBadge, ArdCoaBadge, ArdReportingBadge, RemarksStatusBadge, ArdRemarksStatusBadge, formatDate } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { Modal } from '../components/Modal';
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
/**
 * The Dosage Form and Test Requested columns each fold their option
 * multi-select and free-text "Other" into a single column, so the list shows
 * one "Dosage Form" and one "Test Requested" instead of repeating them. These
 * keys stay in the shared field spec (used by the form and the detail page)
 * but are not rendered as their own list columns.
 */
const HIDDEN_LIST_KEYS = new Set<string>(LIST_HIDDEN_FIELD_KEYS);

const RECORD_COLUMNS: ColumnDef[] = LIST_FIELD_ORDER
  .filter((field) => !HIDDEN_LIST_KEYS.has(field.key))
  .map((field) => ({
    field: field.key as TrfSortField,
    label: listFieldLabel(field),
    alwaysVisible: field.key === 'trfNumber',
  }));

const ALL_COLUMNS: ColumnDef[] = [
  ...RECORD_COLUMNS,
  { field: 'status', label: 'Status', alwaysVisible: false },
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
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('trfListHiddenColumns') : null;
    if (saved) { try { return new Set(JSON.parse(saved) as string[]); } catch { } }
    return new Set<string>();
  });
  const [showColumnToggle, setShowColumnToggle] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TrfListItem | null>(null);
  const [confirmDeleteText, setConfirmDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);
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
    setDeleting(true);
    const res = await window.trf.request<{ ok: true }>({ method: 'DELETE', path: `/api/trfs/${trf.id}` });
    setDeleting(false);
    if (res.ok) {
      setData((prev) => prev ? { ...prev, items: prev.items.filter((t) => t.id !== trf.id), total: prev.total - 1 } : prev);
      setError(null);
      setDeleteTarget(null);
    } else {
      setError(messageOf(res.data, 'This TRF could not be deleted.'));
    }
  };

  const filters = useMemo(() => ({
    search: params.get('search') ?? DEFAULT_TRF_FILTERS.search,
    status: (params.get('status') ? params.get('status')!.split(',') : []) as TrfStatus[],
    workflowStatus: (params.get('workflowStatus') ? params.get('workflowStatus')!.split(',') : []) as ArdWorkflowStatus[],
    priority: (params.get('priority') ? params.get('priority')!.split(',') : []) as Priority[],
    customerId: params.get('customerId') ? Number(params.get('customerId')) : undefined,
    productId: params.get('productId') ? Number(params.get('productId')) : undefined,
    assignedEmployeeId: params.get('assignedEmployeeId') ? Number(params.get('assignedEmployeeId')) : undefined,
    createdBy: params.get('createdBy') ? Number(params.get('createdBy')) : undefined,
    departmentId: params.get('departmentId') ? Number(params.get('departmentId')) : undefined,
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

  const toggleMulti = (key: 'status' | 'priority' | 'workflowStatus', value: string, current: string[]) => {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilter(key, next.join(','));
  };

  const setPage = (page: number) => {
    const next = new URLSearchParams(params);
    if (page <= 1) next.delete('page'); else next.set('page', String(page));
    setParams(next, { replace: true });
  };

  // Load filter dropdown data in parallel with TRF list, with caching to avoid refetching
  useEffect(() => {
    let cancelled = false;

    // Check cache first (5 minute TTL)
    const cacheKey = 'trfListFilterData';
    const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
    const cacheTime = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey + '_time') : null;
    const isCacheValid = cacheTime && (Date.now() - Number(cacheTime)) < 5 * 60 * 1000;

    if (cached && isCacheValid) {
      try {
        const data = JSON.parse(cached);
        setCustomers(data.customers);
        setProducts(data.products);
        setDepartments(data.departments);
        setEmployees(data.employees ?? []);
      } catch {
        // Cache corrupted, will refetch
      }
    }

    // Fetch fresh data in parallel
    Promise.all([
      window.trf.request<{ items: Customer[] }>({ method: 'GET', path: '/api/lookups/customers' }),
      window.trf.request<{ items: Product[] }>({ method: 'GET', path: '/api/lookups/products' }),
      window.trf.request<{ items: Department[] }>({ method: 'GET', path: '/api/departments' }),
      window.trf.request<{ items: EmployeeOption[] }>({ method: 'GET', path: '/api/lookups/employees' }),
    ]).then(([customersRes, productsRes, departmentsRes, employeesRes]) => {
      if (cancelled) return;
      const customersData = customersRes.ok && customersRes.data ? customersRes.data.items : [];
      const productsData = productsRes.ok && productsRes.data ? productsRes.data.items : [];
      const departmentsData = departmentsRes.ok && departmentsRes.data ? departmentsRes.data.items : [];
      const employeesData = employeesRes.ok && employeesRes.data ? employeesRes.data.items : [];

      setCustomers(customersData);
      setProducts(productsData);
      setDepartments(departmentsData);
      setEmployees(employeesData);

      // Update cache
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(cacheKey, JSON.stringify({
          customers: customersData,
          products: productsData,
          departments: departmentsData,
          employees: employeesData,
        }));
        localStorage.setItem(cacheKey + '_time', String(Date.now()));
      }
    }).catch(() => {
      // Silently ignore filter data fetch errors - the dropdowns will just be empty
      // The user can still use the TRF list
    });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const query = toQuery({ ...filters, sortBy, sortDir });
    window.trf.request<TrfListPage>({ method: 'GET', path: `/api/trfs?${query}` })
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
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err.message ?? 'TRFs could not be loaded.');
        setData(null);
      });
    return () => { cancelled = true; };
  }, [filters, sortBy, sortDir, state]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  const activeFilterCount = [
    filters.search, filters.customerId, filters.productId, filters.departmentId, filters.assignedEmployeeId, filters.createdBy,
    filters.dateFrom, filters.dateTo,
  ].filter(Boolean).length + filters.status.length + filters.workflowStatus.length + filters.priority.length + (filters.overdueOnly ? 1 : 0);

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
                assignedEmployeeId: filters.assignedEmployeeId,
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
            <span className="filters__label">Final status</span>
            <div className="chips">
              {ARD_WORKFLOW_STATUSES.map((s) => (
                <button key={s} className={`chip ${filters.workflowStatus.includes(s) ? 'chip--on' : ''}`}
                  onClick={() => toggleMulti('workflowStatus', s, filters.workflowStatus)}>{s}</button>
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
            <label>
              Assigned employee
              <select value={filters.assignedEmployeeId ?? ''} onChange={(e) => setFilter('assignedEmployeeId', e.target.value)}>
                <option value="">All</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
              </select>
            </label>
            <label>
              Created by
              <select value={filters.createdBy ?? ''} onChange={(e) => setFilter('createdBy', e.target.value)}>
                <option value="">All</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
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
        <Modal
          open={true}
          onClose={() => !deleting && setDeleteTarget(null)}
          title={`Delete TRF ${deleteTarget.trfNumber}?`}
          busy={deleting}
        >
          <p className="muted">This cannot be undone. Enter the TRF number to confirm.</p>
          <input
            value={confirmDeleteText}
            onChange={(e) => setConfirmDeleteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') !deleting && confirmDelete(); }}
            placeholder={deleteTarget.trfNumber}
            className={confirmDeleteText !== deleteTarget.trfNumber ? 'field--error' : undefined}
            disabled={deleting}
          />
          <div className="modal__actions">
            <button className="btn" type="button" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button
              className="btn btn--danger"
              disabled={deleting || confirmDeleteText !== deleteTarget.trfNumber}
              onClick={confirmDelete}
            >Delete</button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </Modal>
      )}
    </div>
  );
}

const TRUNCATE_FIELDS = new Set([
   'Market/Customer', 'Product Name', 'Batch Number', 'Batch Size',
   'Manufacturing Location', 'Label Claim', 'Pack Size', 'Pack Type',
   'Storage Condition', 'Storage Period', 'Test Details',
   'Analysis Required For / Purpose', 'Remarks', 'Sample Submitted By',
   'A.R. No.', 'ARD Remark', 'Reporting', 'COA', 'Remarks / Status',
   'ARD Remarks / Status', 'Signature / Date',
]);

/** Columns that hold more than one value and render as a bulleted block. */
const BULLET_FIELDS = new Set(['Dosage Form', 'Test Requested', 'Analyst Name']);

function TrfRow({ trf, columns, canEditAny, canDeleteAny, onDelete }: {
  trf: TrfListItem; columns: ColumnDef[]; canEditAny: boolean; canDeleteAny: boolean;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const canDelete = canDeleteAny && trf.status === 'New';
  const showEdit = canEditAny && trf.status !== 'Completed' && trf.status !== 'Cancelled';

  function handleRowClick(e: React.MouseEvent) {
    // Don't navigate if clicking on action buttons or links
    const target = e.target as HTMLElement;
    if (target.closest('a') || target.closest('button')) {
      return;
    }
    navigate(`/trfs/${trf.id}`);
  }

  async function printTrf(trfId: number) {
    const res = await window.trf.printTrf(trfId);
    if (!res.ok) window.alert(res.message ?? 'The TRF could not be printed.');
  }

  async function saveTrfAsPdf(trfId: number, trfNumber: string) {
    // TRF numbers can contain '/', which is not allowed in a file name.
    const fileName = `TRF-${trfNumber.replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
    const res = await window.trf.printToPDF(trfId, fileName);
    if (!res.ok) window.alert(res.message ?? 'The PDF could not be created.');
  }

  const rawCell = (column: ColumnDef): { node: ReactNode; text: string | null } => {
    switch (column.label) {
      case 'TRF No.':
        return { node: <a className="link nowrap" href={`#/trfs/${trf.id}`}>{trf.trfNumber}</a>, text: null };
      case 'Date of Request':
        return { node: <span className="nowrap">{formatDate(trf.trfDate)}</span>, text: null };
      case 'Product Name':
        return { node: <span className="muted-cell">{trf.productName ?? '—'}</span>, text: trf.productName };
      case 'Generic Name':
        return { node: <span className="muted-cell">{trf.genericName ?? '—'}</span>, text: trf.genericName };
      case 'Batch Number':
        return { node: <span className="muted-cell">{trf.batchNumber ?? '—'}</span>, text: trf.batchNumber };
      case 'Batch Size':
        return { node: <span className="muted-cell">{trf.batchSize ?? '—'}</span>, text: trf.batchSize };
      case 'Market/Customer':
        return { node: <span className="muted-cell">{trf.customerName ?? '—'}</span>, text: trf.customerName };
      case 'Dosage Form': {
        const label = bulletList([
          ...(trf.dosageFormOptionNames?.length ? trf.dosageFormOptionNames : [trf.dosageForm]),
          trf.dosageFormOther,
        ]) || '—';
        return { node: <span className="cell-bullets">{label}</span>, text: label === '—' ? null : label };
      }
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
      case 'Test Requested': {
        const label = bulletList([
          ...(trf.testRequestedOptionNames?.length ? trf.testRequestedOptionNames : [trf.requestedAnalysis]),
          trf.testRequestedOther,
        ]) || '—';
        return { node: <span className="cell-bullets">{label}</span>, text: label === '—' ? null : label };
      }
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
      case 'Analyst Name': {
        const label = bulletList(analystNameList(trf.assignedAnalystNames, trf.analystName)) || '—';
        return { node: <span className="cell-bullets">{label}</span>, text: label === '—' ? null : label };
      }
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
      case 'Sample Received By':
        return { node: <span className="muted-cell">{trf.sampleReceivedByName ?? '—'}</span>, text: trf.sampleReceivedByName };
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
    // A bulleted column already lists every value, so it is never truncated.
    if (BULLET_FIELDS.has(column.label)) return node;
    // A long value is cut to one line with an ellipsis, and the whole value is
    // in the tooltip so nothing is lost.
    if (!TRUNCATE_FIELDS.has(column.label) || !text) return node;
    return <span className="truncate" title={text}>{node}</span>;
  };

  return (
    <tr onClick={handleRowClick} style={{ cursor: 'pointer' }}>
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
          {trf.status === 'Completed' && trf.lockedAt && trf.finalApprovalStatus === 'Approved' && (
            <>
              <button className="btn-icon" aria-label="Print TRF" title="Print" onClick={() => printTrf(trf.id)}>
                <span aria-hidden>🖨</span>
              </button>
              <button className="btn-icon" aria-label="Save TRF as PDF" title="Save as PDF" onClick={() => saveTrfAsPdf(trf.id, trf.trfNumber)}>
                <span aria-hidden>📄</span>
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
