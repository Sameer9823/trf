import { z } from 'zod';
import type { AnalysisStatus, Priority, TrfStatus } from '@trf/shared';
import {
  ASSIGNMENT_SORT_FIELDS, ASSIGNMENT_STATUS_VIEWS, Assignment,
  AssignmentFilters, AnalysisStatusView, Priority as PriorityType,
} from '@trf/shared';

/** "Delayed" is a filter value; when present it filters on the due-date expression, not a column. */
export const DELAYED_SQL = `(a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE
  AND a.status NOT IN ('Completed', 'Cancelled'))`;

export const ASSIGNMENT_SELECT = `
  a.id, a.trf_id, a.test_name, a.test_method, a.specification, a.assigned_employee_id,
  a.assigned_date, a.due_date, a.status, a.version, a.created_at, a.updated_at,
  t.trf_number, t.product_id, t.batch_number, t.status AS trf_status, t.priority,
  t.required_completion_date, t.trf_date, t.version AS trf_version,
  p.name AS product_name, c.name AS customer_name,
  e.full_name AS assigned_employee_name, e.department_id, d.name AS department_name
`;

export const ASSIGNMENT_FROM = `
  FROM analysis_tests a
  JOIN trfs t ON t.id = a.trf_id
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN customers c ON c.id = t.customer_id
  LEFT JOIN employees e ON e.id = a.assigned_employee_id
  LEFT JOIN departments d ON d.id = e.department_id
`;

export const ASSIGNMENT_SORT_SQL: Record<string, string> = {
  trfNumber: 't.trf_number',
  testName: 'a.test_name',
  assignedEmployeeName: 'e.full_name',
  dueDate: 'a.due_date',
  status: 'a.status',
  assignedDate: 'a.assigned_date',
  priority: 't.priority',
};

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

export const assignmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).default(''),
  status: z.string().default(''),
  employeeId: z.coerce.number().int().positive().optional(),
  trfId: z.coerce.number().int().positive().optional(),
  trfNumber: z.string().trim().max(40).default(''),
  dueFrom: ISO_DATE.optional(),
  dueTo: ISO_DATE.optional(),
  delayedOnly: z.enum(['true', 'false']).default('false'),
  sortBy: z.enum(ASSIGNMENT_SORT_FIELDS).default('dueDate'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  groupByTrf: z.enum(['true', 'false']).default('false'),
});

export function toAssignmentFilters(q: z.infer<typeof assignmentListQuerySchema>): AssignmentFilters {
  return {
    page: q.page,
    pageSize: q.pageSize,
    search: q.search,
    status: q.status.split(',').map((v) => v.trim()).filter((v) => v && ASSIGNMENT_STATUS_VIEWS.includes(v as AnalysisStatusView)) as AnalysisStatusView[],
    employeeId: q.employeeId,
    trfId: q.trfId,
    trfNumber: q.trfNumber,
    dueFrom: q.dueFrom,
    dueTo: q.dueTo,
    delayedOnly: q.delayedOnly === 'true',
    sortBy: q.sortBy,
    sortDir: q.sortDir,
  };
}

export function buildAssignmentWhere(filters: AssignmentFilters, params: unknown[], scope: { employeeId: number } | null): string {
  const clauses: string[] = [];

  // An Analyst only ever sees their own work, applied in SQL.
  if (scope) {
    params.push(scope.employeeId);
    clauses.push(`a.assigned_employee_id = $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${filters.search.toLowerCase()}%`);
    const p = params.length;
    clauses.push(`(lower(a.test_name) LIKE $${p} OR lower(t.trf_number) LIKE $${p}
      OR lower(COALESCE(t.batch_number, '')) LIKE $${p} OR lower(COALESCE(p.name, '')) LIKE $${p}
      OR lower(COALESCE(c.name, '')) LIKE $${p} OR lower(COALESCE(e.full_name, '')) LIKE $${p})`);
  }
  if (filters.trfNumber) {
    params.push(`%${filters.trfNumber.toLowerCase()}%`);
    clauses.push(`lower(t.trf_number) LIKE $${params.length}`);
  }

  const stored = filters.status.filter((s) => s !== 'Delayed') as AnalysisStatus[];
  if (stored.length) {
    params.push(stored);
    clauses.push(`a.status = ANY($${params.length})`);
  }
  // "Delayed" among the chosen statuses, or on its own, filters the computed column.
  if (filters.status.includes('Delayed')) {
    if (stored.length === 0) clauses.push(DELAYED_SQL);
    else clauses.push(`(a.status = ANY($${params.length - 1}) OR ${DELAYED_SQL})`);
  }
  if (filters.delayedOnly) clauses.push(DELAYED_SQL);

  if (filters.employeeId) { params.push(filters.employeeId); clauses.push(`a.assigned_employee_id = $${params.length}`); }
  if (filters.trfId) { params.push(filters.trfId); clauses.push(`a.trf_id = $${params.length}`); }
  if (filters.dueFrom) { params.push(filters.dueFrom); clauses.push(`a.due_date >= $${params.length}::date`); }
  if (filters.dueTo) { params.push(filters.dueTo); clauses.push(`a.due_date <= $${params.length}::date`); }

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

export interface AssignmentRow {
  id: number; trf_id: number; test_name: string; test_method: string | null; specification: string | null;
  assigned_employee_id: number | null; assigned_date: string | null; due_date: string | null;
  status: AnalysisStatus; version: number; created_at: Date; updated_at: Date;
  trf_number: string; product_id: number | null; batch_number: string | null; trf_status: TrfStatus;
  priority: Priority; required_completion_date: string | null; trf_date: string; trf_version: number;
  product_name: string | null; customer_name: string | null;
  assigned_employee_name: string | null; department_id: number | null; department_name: string | null;
}

const dateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  return (typeof value === 'string' ? value : value.toISOString()).slice(0, 10);
};

export function toAssignment(row: AssignmentRow & { is_delayed?: boolean }): Assignment {
  return {
    id: row.id,
    trfId: row.trf_id,
    trfNumber: row.trf_number,
    productName: row.product_name,
    batchNumber: row.batch_number,
    customerName: row.customer_name,
    trfStatus: row.trf_status,
    priority: row.priority as PriorityType,
    testName: row.test_name,
    testMethod: row.test_method,
    specification: row.specification,
    assignedEmployeeId: row.assigned_employee_id,
    assignedEmployeeName: row.assigned_employee_name,
    assignedDate: dateOnly(row.assigned_date),
    dueDate: dateOnly(row.due_date),
    status: row.status,
    isDelayed: Boolean(row.is_delayed),
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}