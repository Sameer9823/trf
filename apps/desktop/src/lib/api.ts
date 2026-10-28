import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_TRF_FILTERS, EmployeeProfile, PRIORITIES, TrfFilters, TrfSortField,
} from '@trf/shared';

const API_BASE = '/api';

export interface ApiBody { error?: { code?: string; message?: string; fields?: Record<string, string> } }

/** Server error message if the API gave one, otherwise a plain fallback. */
export function messageOf(data: unknown, fallback: string): string {
  const body = data as ApiBody | undefined;
  return body?.error?.message ?? fallback;
}

export function fieldsOf(data: unknown): Record<string, string> {
  const body = data as ApiBody | undefined;
  return body?.error?.fields ?? {};
}

/**
 * Serialises the filter state into the query string the list endpoint expects.
 * Both the TRF list and any later export use exactly this, so an export always
 * matches the list the user is looking at.
 */
export function toQuery(filters: Partial<TrfFilters> & { page?: number }): string {
  const params = new URLSearchParams();
  const merged = { ...DEFAULT_TRF_FILTERS, ...filters };
  params.set('page', String(merged.page));
  params.set('pageSize', String(merged.pageSize));
  if (merged.search.trim()) params.set('search', merged.search.trim());
  if (merged.status.length) params.set('status', merged.status.join(','));
  if (merged.priority.length) params.set('priority', merged.priority.join(','));
  if (merged.customerId) params.set('customerId', String(merged.customerId));
  if (merged.productId) params.set('productId', String(merged.productId));
  if (merged.assignedEmployeeId) params.set('assignedEmployeeId', String(merged.assignedEmployeeId));
  if (merged.departmentId) params.set('departmentId', String(merged.departmentId));
  if (merged.dateFrom) params.set('dateFrom', merged.dateFrom);
  if (merged.dateTo) params.set('dateTo', merged.dateTo);
  if (merged.dueFrom) params.set('dueFrom', merged.dueFrom);
  if (merged.dueTo) params.set('dueTo', merged.dueTo);
  if (merged.overdueOnly) params.set('overdueOnly', 'true');
  params.set('sortBy', merged.sortBy);
  params.set('sortDir', merged.sortDir);
  return params.toString();
}

export type SortSetter = (field: TrfSortField) => void;

/** One sort state for a table header: clicking the active column flips the direction. */
export function useTrfSort(): {
  sortBy: TrfSortField;
  sortDir: 'asc' | 'desc';
  toggleSort: (field: TrfSortField) => void;
} {
  const [sortBy, setSortBy] = useState<TrfSortField>(DEFAULT_TRF_FILTERS.sortBy);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(DEFAULT_TRF_FILTERS.sortDir);

  const toggleSort = useCallback((field: TrfSortField) => {
    if (field === sortBy) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir('asc'); }
  }, [sortBy]);

  return useMemo(() => ({ sortBy, sortDir, toggleSort }), [sortBy, sortDir, toggleSort]);
}

export interface Loadable {
  loading: boolean;
  error: string | null;
}

/** Generic async load with the two states every list screen needs. */
export function useLoader<T>(run: () => Promise<T | null>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    run()
      .then((result) => { if (!cancelled) { setData(result); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload, setData };
}

/** Employees who can hold analysis work, used by the assign control. */
export function useAssignableEmployees() {
  const [items, setItems] = useState<EmployeeProfile[]>([]);
  useEffect(() => {
    void window.trf.request<{ items: EmployeeProfile[] }>({
      method: 'GET', path: `${API_BASE}/employees/assignable`,
    }).then((res) => { if (res.ok && res.data) setItems(res.data.items); });
  }, []);
  return items;
}

export const PRIORITY_OPTIONS = PRIORITIES;
