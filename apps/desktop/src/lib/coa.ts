import type { Coa, CoaPage, CoaSortField, CoaStatus, CoaSummary } from '@trf/shared';
import { COA_STATUSES, MESSAGES } from '@trf/shared';
import { messageOf } from './api';

/** Serialises the COA filters the list endpoint expects. */
export function toCoaQuery(filters: {
  page?: number; pageSize?: number; search?: string; status?: string[];
  trfId?: number; trfNumber?: string; dateFrom?: string; dateTo?: string;
  mineOnly?: boolean; sortBy?: string; sortDir?: 'asc' | 'desc';
}): string {
  const params = new URLSearchParams();
  params.set('page', String(filters.page ?? 1));
  params.set('pageSize', String(filters.pageSize ?? 25));
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.status?.length) params.set('status', filters.status.join(','));
  if (filters.trfId) params.set('trfId', String(filters.trfId));
  if (filters.trfNumber?.trim()) params.set('trfNumber', filters.trfNumber.trim());
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);
  if (filters.mineOnly) params.set('mineOnly', 'true');
  params.set('sortBy', filters.sortBy ?? 'createdAt');
  params.set('sortDir', filters.sortDir ?? 'desc');
  return params.toString();
}

type Result<T> = { ok: boolean; data?: T; message?: string; fields?: Record<string, string> };

export interface CoaApi {
  list(query: string): Promise<Result<CoaPage>>;
  summary(query: string): Promise<CoaSummary | null>;
  byId(id: number): Promise<Coa | null>;
  byTrf(trfId: number): Promise<Coa | null>;
  draft(trfId: number, remarks?: string | null): Promise<Result<Coa>>;
  submit(id: number, version: number, note?: string): Promise<Result<Coa>>;
  approve(id: number, version: number, note?: string): Promise<Result<Coa>>;
  returnForChange(id: number, version: number, note: string): Promise<Result<Coa>>;
  issue(id: number, version: number, note?: string): Promise<Result<Coa>>;
  updateRemarks(id: number, version: number, remarks: string | null): Promise<Result<Coa>>;
  audit(id: number): Promise<{ action: string; userName: string | null; at: string }[]>;
}

const act = async (path: string, body: unknown, fallback: string): Promise<Result<Coa>> => {
  const res = await window.trf.request<Coa>({ method: 'POST', path, body });
  if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, fallback) };
  return { ok: true, data: res.data };
};

export const coaApi: CoaApi = {
  async list(query) {
    const res = await window.trf.request<CoaPage>({ method: 'GET', path: `/api/coa?${query}` });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'Certificates could not be loaded.') };
    return { ok: true, data: res.data };
  },
  async summary(query) {
    const res = await window.trf.request<CoaSummary>({ method: 'GET', path: `/api/coa/summary?${query}` });
    return res.ok && res.data ? res.data : null;
  },
  async byId(id) {
    const res = await window.trf.request<Coa>({ method: 'GET', path: `/api/coa/${id}` });
    return res.ok && res.data ? res.data : null;
  },
  async byTrf(trfId) {
    const res = await window.trf.request<{ coa: Coa | null }>({ method: 'GET', path: `/api/coa/trfs/${trfId}` });
    return res.ok && res.data ? res.data.coa : null;
  },
  async draft(trfId, remarks) {
    return act('/api/coa', { trfId, remarks: remarks ?? null }, 'The certificate could not be drafted.');
  },
  async submit(id, version, note) {
    return act(`/api/coa/${id}/submit`, { version, note: note ?? null }, 'The certificate could not be sent for review.');
  },
  async approve(id, version, note) {
    return act(`/api/coa/${id}/approve`, { version, note: note ?? null }, 'The certificate could not be approved.');
  },
  async returnForChange(id, version, note) {
    return act(`/api/coa/${id}/return`, { version, note }, 'The certificate could not be sent back.');
  },
  async issue(id, version, note) {
    return act(`/api/coa/${id}/issue`, { version, note: note ?? null }, 'The certificate could not be issued.');
  },
  async updateRemarks(id, version, remarks) {
    const res = await window.trf.request<Coa>({
      method: 'PATCH', path: `/api/coa/${id}`, body: { version, remarks },
    });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'The certificate could not be changed.') };
    return { ok: true, data: res.data };
  },
  async audit(id) {
    const res = await window.trf.request<{ items: { action: string; userName: string | null; at: string }[] }>({
      method: 'GET', path: `/api/coa/${id}/audit`,
    });
    return res.ok && res.data ? res.data.items : [];
  },
};

const TONE: Record<CoaStatus, string> = {
  Pending: 'badge--muted',
  Draft: 'badge--info',
  'Under Review': 'badge--warn',
  Approved: 'badge--info',
  Issued: 'badge--ok',
};

export function coaStatusTone(status: CoaStatus): string {
  return TONE[status];
}

export const COA_STATUS_OPTIONS = COA_STATUSES;

export const COA_SORTS: { field: CoaSortField; label: string }[] = [
  { field: 'coaNumber', label: 'COA No.' },
  { field: 'trfNumber', label: 'TRF No.' },
  { field: 'customerName', label: 'Customer' },
  { field: 'status', label: 'Status' },
  { field: 'createdAt', label: 'Created' },
  { field: 'issuedAt', label: 'Issued' },
];

export const OFFLINE = MESSAGES.SERVER_UNAVAILABLE;
