import type {
  AnalysisStatus, Assignment, AssignmentGroup, AssignmentGroupPage, AssignmentInput,
  AssignmentListPage, EmployeeProfile, Paginated, TestCatalogItem, WorkloadRow,
} from '@trf/shared';
import { ASSIGNMENT_STATUS_VIEWS } from '@trf/shared';
import { fieldsOf, messageOf } from './api';

/** Serialises the assignment filters the same way the list endpoint expects. */
export function toAssignmentQuery(filters: {
  page?: number; pageSize?: number; search?: string; status?: string[];
  employeeId?: number; trfId?: number; trfNumber?: string;
  dueFrom?: string; dueTo?: string; delayedOnly?: boolean;
  sortBy?: string; sortDir?: 'asc' | 'desc'; groupByTrf?: boolean;
}): string {
  const params = new URLSearchParams();
  params.set('page', String(filters.page ?? 1));
  params.set('pageSize', String(filters.pageSize ?? 25));
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.status?.length) params.set('status', filters.status.join(','));
  if (filters.employeeId) params.set('employeeId', String(filters.employeeId));
  if (filters.trfId) params.set('trfId', String(filters.trfId));
  if (filters.trfNumber?.trim()) params.set('trfNumber', filters.trfNumber.trim());
  if (filters.dueFrom) params.set('dueFrom', filters.dueFrom);
  if (filters.dueTo) params.set('dueTo', filters.dueTo);
  if (filters.delayedOnly) params.set('delayedOnly', 'true');
  if (filters.groupByTrf) params.set('groupByTrf', 'true');
  params.set('sortBy', filters.sortBy ?? 'dueDate');
  params.set('sortDir', filters.sortDir ?? 'asc');
  return params.toString();
}

export interface AssignmentApi {
  list(query: string): Promise<{ ok: boolean; data?: AssignmentListPage; message?: string }>;
  /** Same endpoint with groupByTrf: the Manager's by-TRF view. */
  listByTrf(query: string): Promise<{ ok: boolean; data?: AssignmentGroupPage; message?: string }>;
  createMany(trfId: number, assignments: AssignmentInput[]):
    Promise<{ ok: boolean; data?: { items: Assignment[]; trfStatus: string }; message?: string; fields?: Record<string, string> }>;
  update(id: number, version: number, patch: Partial<Assignment> & { assignedEmployeeId?: number | null; dueDate?: string | null; note?: string }):
    Promise<{ ok: boolean; data?: Assignment; message?: string }>;
  cancel(id: number, version: number): Promise<{ ok: boolean; data?: Assignment; message?: string }>;
  workload(): Promise<WorkloadRow[]>;
  catalog(): Promise<TestCatalogItem[]>;
  assignables(): Promise<EmployeeProfile[]>;
  byTrf(trfId: number): Promise<Assignment[]>;
}

export const assignmentApi: AssignmentApi = {
  async list(query) {
    const res = await window.trf.request<AssignmentListPage>({ method: 'GET', path: `/api/assignments?${query}` });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'Assignments could not be loaded.') };
    return { ok: true, data: res.data };
  },
  async listByTrf(query) {
    const res = await window.trf.request<AssignmentGroupPage>({ method: 'GET', path: `/api/assignments?${query}` });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'Assignments could not be loaded.') };
    return { ok: true, data: res.data };
  },
  async createMany(trfId, assignments) {
    const res = await window.trf.request<{ items: Assignment[]; trfStatus: string }>({
      method: 'POST', path: `/api/assignments/trfs/${trfId}/assignments`, body: { assignments },
    });
    if (!res.ok || !res.data) {
      return { ok: false, message: messageOf(res.data, 'The tests could not be assigned.'), fields: fieldsOf(res.data) };
    }
    return { ok: true, data: res.data };
  },
  async update(id, version, patch) {
    const res = await window.trf.request<Assignment>({
      method: 'PATCH', path: `/api/assignments/tests/${id}`, body: { ...patch, version },
    });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'The assignment could not be changed.') };
    return { ok: true, data: res.data };
  },
  async cancel(id, version) {
    const res = await window.trf.request<Assignment>({
      method: 'POST', path: `/api/assignments/tests/${id}/cancel`, body: { version },
    });
    if (!res.ok || !res.data) return { ok: false, message: messageOf(res.data, 'The assignment could not be cancelled.') };
    return { ok: true, data: res.data };
  },
  async workload() {
    const res = await window.trf.request<{ items: WorkloadRow[] }>({ method: 'GET', path: '/api/assignments/workload' });
    return res.ok && res.data ? res.data.items : [];
  },
  async catalog() {
    const res = await window.trf.request<{ items: TestCatalogItem[] }>({ method: 'GET', path: '/api/test-catalog' });
    return res.ok && res.data ? res.data.items : [];
  },
  async assignables() {
    const res = await window.trf.request<{ items: EmployeeProfile[] }>({ method: 'GET', path: '/api/employees/assignable' });
    return res.ok && res.data ? res.data.items : [];
  },
  async byTrf(trfId) {
    const res = await window.trf.request<{ items: Assignment[] }>({ method: 'GET', path: `/api/assignments/trfs/${trfId}` });
    return res.ok && res.data ? res.data.items : [];
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

/** "Delayed" wins over the stored status when the due date has passed. */
export function assignmentStatusLabel(a: Assignment): string {
  if (a.isDelayed && a.status !== 'Completed' && a.status !== 'Cancelled') return 'Delayed';
  return a.status;
}

export function assignmentStatusTone(a: Assignment): string {
  if (a.isDelayed && a.status !== 'Completed' && a.status !== 'Cancelled') return 'badge--danger';
  return STATUS_TONE[a.status];
}

export { ASSIGNMENT_STATUS_VIEWS };