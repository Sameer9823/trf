import type {
  AnalysisFilters, AnalysisItem, AnalysisPage, AnalysisResultInput, AnalysisSortField,
  AnalysisStatus, AnalysisSummary, Outcome,
} from '@trf/shared';
import { ANALYSIS_STATUSES, MESSAGES, OUTCOMES } from '@trf/shared';
import { fieldsOf, messageOf } from './api';

/** Serialises the analysis filters the list endpoint expects. */
export function toAnalysisQuery(filters: {
  page?: number; pageSize?: number; search?: string; status?: string[];
  outcome?: string[]; employeeId?: number; trfId?: number; trfNumber?: string;
  dueFrom?: string; dueTo?: string; delayedOnly?: boolean; mineOnly?: boolean;
  sortBy?: string; sortDir?: 'asc' | 'desc';
}): string {
  const params = new URLSearchParams();
  params.set('page', String(filters.page ?? 1));
  params.set('pageSize', String(filters.pageSize ?? 25));
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.status?.length) params.set('status', filters.status.join(','));
  if (filters.outcome?.length) params.set('outcome', filters.outcome.join(','));
  if (filters.employeeId) params.set('employeeId', String(filters.employeeId));
  if (filters.trfId) params.set('trfId', String(filters.trfId));
  if (filters.trfNumber?.trim()) params.set('trfNumber', filters.trfNumber.trim());
  if (filters.dueFrom) params.set('dueFrom', filters.dueFrom);
  if (filters.dueTo) params.set('dueTo', filters.dueTo);
  if (filters.delayedOnly) params.set('delayedOnly', 'true');
  if (filters.mineOnly) params.set('mineOnly', 'true');
  params.set('sortBy', filters.sortBy ?? 'dueDate');
  params.set('sortDir', filters.sortDir ?? 'asc');
  return params.toString();
}

type Result<T> = { ok: boolean; data?: T; message?: string; fields?: Record<string, string> };

export interface AnalysisApi {
  list(query: string): Promise<Result<AnalysisPage>>;
  summary(query: string): Promise<AnalysisSummary | null>;
  byTrf(trfId: number): Promise<AnalysisItem[]>;
  mine(): Promise<AnalysisItem[]>;
  start(id: number, version: number): Promise<Result<AnalysisItem>>;
  saveResult(id: number, version: number, result: AnalysisResultInput): Promise<Result<AnalysisItem>>;
  complete(id: number, version: number, note?: string): Promise<Result<AnalysisItem>>;
  reTest(id: number, version: number, note: string): Promise<Result<AnalysisItem>>;
}

export const analysisApi: AnalysisApi = {
  async list(query) {
    const res = await window.trf.request<AnalysisPage>({ method: 'GET', path: `/api/analysis?${query}` });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'The analysis list could not be loaded.') };
    return { ok: true, data: res.data };
  },
  async summary(query) {
    const res = await window.trf.request<AnalysisSummary>({ method: 'GET', path: `/api/analysis/summary?${query}` });
    return res.ok && res.data ? res.data : null;
  },
  async byTrf(trfId) {
    const res = await window.trf.request<{ items: AnalysisItem[] }>({ method: 'GET', path: `/api/analysis/trfs/${trfId}` });
    return res.ok && res.data ? res.data.items : [];
  },
  async mine() {
    const res = await window.trf.request<{ items: AnalysisItem[] }>({ method: 'GET', path: '/api/analysis/mine' });
    return res.ok && res.data ? res.data.items : [];
  },
  async start(id, version) {
    const res = await window.trf.request<AnalysisItem>({
      method: 'POST', path: `/api/analysis/tests/${id}/start`, body: { version },
    });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'The test could not be started.') };
    return { ok: true, data: res.data };
  },
  async saveResult(id, version, result) {
    const res = await window.trf.request<AnalysisItem>({
      method: 'PUT', path: `/api/analysis/tests/${id}/result`, body: { ...result, version },
    });
    if (!res.ok || !res.data) {
      return { ok: false, message: messageOf(res.data, 'The result could not be saved.'), fields: fieldsOf(res.data) };
    }
    return { ok: true, data: res.data };
  },
  async complete(id, version, note) {
    const res = await window.trf.request<AnalysisItem>({
      method: 'POST', path: `/api/analysis/tests/${id}/complete`, body: { version, note: note ?? null },
    });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'The test could not be completed.') };
    return { ok: true, data: res.data };
  },
  async reTest(id, version, note) {
    const res = await window.trf.request<AnalysisItem>({
      method: 'POST', path: `/api/analysis/tests/${id}/re-test`, body: { version, note },
    });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'The re-test could not be requested.') };
    return { ok: true, data: res.data };
  },
};

const STATUS_TONE: Record<AnalysisStatus, string> = {
  Pending: 'badge--muted',
  Assigned: 'badge--info',
  'In Progress': 'badge--info',
  Completed: 'badge--ok',
  'Re-test Required': 'badge--warn',
  Cancelled: 'badge--muted',
};

export function statusTone(item: AnalysisItem): string {
  if (item.isDelayed && item.status !== 'Completed' && item.status !== 'Cancelled') return 'badge--danger';
  return STATUS_TONE[item.status];
}

/** Pass and Fail are the only outcomes that say anything about the sample. */
export function outcomeTone(outcome: Outcome): string {
  if (outcome === 'Pass') return 'badge--ok';
  if (outcome === 'Fail') return 'badge--danger';
  if (outcome === 'Not Tested') return 'badge--muted';
  return 'badge--warn';
}

export const ANALYSIS_STATUS_OPTIONS = ANALYSIS_STATUSES;
export const OUTCOME_OPTIONS = OUTCOMES;
export const ANALYSIS_SORTS: { field: AnalysisSortField; label: string }[] = [
  { field: 'dueDate', label: 'Due date' },
  { field: 'trfNumber', label: 'TRF No.' },
  { field: 'testName', label: 'Test' },
  { field: 'assignedEmployeeName', label: 'Employee' },
  { field: 'status', label: 'Status' },
  { field: 'outcome', label: 'Outcome' },
  { field: 'startDate', label: 'Start date' },
  { field: 'completionDate', label: 'Completion date' },
];

export type { AnalysisFilters };
export const OFFLINE = MESSAGES.SERVER_UNAVAILABLE;
