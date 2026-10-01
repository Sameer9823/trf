import { z } from 'zod';
import type {
  AnalysisFilters, AnalysisItem, AnalysisResult, AnalysisSortField,
  AnalysisStatusView, Outcome, Priority, TrfStatus,
} from '@trf/shared';
import {
  ANALYSIS_SORT_FIELDS, ANALYSIS_STATUSES, OUTCOMES,
} from '@trf/shared';

export { DELAYED_SQL } from './assignment-query';

export const STATUS_VIEWS: readonly AnalysisStatusView[] = [...ANALYSIS_STATUSES, 'Delayed'];

/**
 * Pass or Fail is decided here, in one expression, so the badge, the filter and
 * any later report all read the same rule. A result with no limits is "Not
 * Specified" and a test with no result is "Not Tested"; neither is called Pass.
 */
export const OUTCOME_SQL = `CASE
  WHEN r.id IS NULL THEN 'Not Tested'
  WHEN (r.lower_limit IS NULL AND r.upper_limit IS NULL) OR r.result_value IS NULL THEN 'Not Specified'
  WHEN r.result_value BETWEEN r.lower_limit AND r.upper_limit THEN 'Pass'
  ELSE 'Fail'
END`;

export const ANALYSIS_SELECT = `
  a.id, a.trf_id, a.test_name, a.test_method, a.specification, a.assigned_employee_id,
  a.assigned_date, a.due_date, a.status, a.version, a.updated_at,
  a.start_date, a.completion_date, a.remarks,
  t.trf_number, t.batch_number, t.status AS trf_status, t.priority,
  t.required_completion_date, t.version AS trf_version,
  p.name AS product_name, c.name AS customer_name,
  e.full_name AS assigned_employee_name,
  r.id AS result_id, r.result_value, r.result_text, r.unit, r.method_used,
  r.lower_limit, r.upper_limit, r.remarks AS result_remarks,
  r.entered_by, r.entered_at, r.version AS result_version, r.updated_at AS result_updated_at,
  by_name.full_name AS entered_by_name,
  (${OUTCOME_SQL}) AS outcome,
  (a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE
     AND a.status NOT IN ('Completed', 'Cancelled')) AS is_delayed
`;

export const ANALYSIS_FROM = `
  FROM analysis_tests a
  JOIN trfs t ON t.id = a.trf_id
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN customers c ON c.id = t.customer_id
  LEFT JOIN employees e ON e.id = a.assigned_employee_id
  LEFT JOIN analysis_results r ON r.analysis_test_id = a.id
  LEFT JOIN employees by_name ON by_name.id = r.entered_by
`;

export const ANALYSIS_SORT_SQL: Record<AnalysisSortField, string> = {
  trfNumber: 't.trf_number',
  testName: 'a.test_name',
  assignedEmployeeName: 'e.full_name',
  dueDate: 'a.due_date',
  status: 'a.status',
  outcome: 'outcome',
  startDate: 'a.start_date',
  completionDate: 'a.completion_date',
};

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

export const analysisListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).default(''),
  status: z.string().default(''),
  // Comma-separated outcome filter.
  outcome: z.string().default(''),
  employeeId: z.coerce.number().int().positive().optional(),
  trfId: z.coerce.number().int().positive().optional(),
  trfNumber: z.string().trim().max(40).default(''),
  dueFrom: ISO_DATE.optional(),
  dueTo: ISO_DATE.optional(),
  delayedOnly: z.enum(['true', 'false']).default('false'),
  mineOnly: z.enum(['true', 'false']).default('false'),
  sortBy: z.enum(ANALYSIS_SORT_FIELDS).default('dueDate'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});

export function toAnalysisFilters(q: z.infer<typeof analysisListQuerySchema>): AnalysisFilters {
  const split = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);
  return {
    page: q.page,
    pageSize: q.pageSize,
    search: q.search,
    status: split(q.status).filter((v): v is AnalysisStatusView => STATUS_VIEWS.includes(v as AnalysisStatusView)),
    outcome: split(q.outcome).filter((v): v is Outcome => (OUTCOMES as readonly string[]).includes(v)),
    employeeId: q.employeeId,
    trfId: q.trfId,
    trfNumber: q.trfNumber,
    dueFrom: q.dueFrom,
    dueTo: q.dueTo,
    delayedOnly: q.delayedOnly === 'true',
    mineOnly: q.mineOnly === 'true',
    sortBy: q.sortBy,
    sortDir: q.sortDir,
  };
}

export function buildAnalysisWhere(filters: AnalysisFilters, params: unknown[], scope: { employeeId: number } | null): string {
  const clauses: string[] = [];

  if (scope) {
    params.push(scope.employeeId);
    clauses.push(`a.assigned_employee_id = $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${filters.search.toLowerCase()}%`);
    const p = params.length;
    clauses.push(`(lower(a.test_name) LIKE $${p} OR lower(t.trf_number) LIKE $${p}
      OR lower(COALESCE(t.batch_number, '')) LIKE $${p} OR lower(COALESCE(p.name, '')) LIKE $${p}
      OR lower(COALESCE(c.name, '')) LIKE $${p} OR lower(COALESCE(e.full_name, '')) LIKE $${p}
      OR lower(COALESCE(r.result_text, '')) LIKE $${p})`);
  }
  if (filters.trfNumber) {
    params.push(`%${filters.trfNumber.toLowerCase()}%`);
    clauses.push(`lower(t.trf_number) LIKE $${params.length}`);
  }

  const stored = filters.status.filter((s) => s !== 'Delayed');
  if (stored.length) {
    params.push(stored);
    clauses.push(`a.status = ANY($${params.length})`);
  }
  if (filters.status.includes('Delayed')) {
    const delayed = `(a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE AND a.status NOT IN ('Completed', 'Cancelled'))`;
    clauses.push(stored.length ? `(a.status = ANY($${params.length - 1}) OR ${delayed})` : delayed);
  }
  if (filters.outcome.length) {
    params.push(filters.outcome);
    clauses.push(`(${OUTCOME_SQL}) = ANY($${params.length})`);
  }
  if (filters.delayedOnly) {
    clauses.push(`a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE AND a.status NOT IN ('Completed', 'Cancelled')`);
  }
  if (filters.employeeId) { params.push(filters.employeeId); clauses.push(`a.assigned_employee_id = $${params.length}`); }
  if (filters.trfId) { params.push(filters.trfId); clauses.push(`a.trf_id = $${params.length}`); }
  if (filters.dueFrom) { params.push(filters.dueFrom); clauses.push(`a.due_date >= $${params.length}::date`); }
  if (filters.dueTo) { params.push(filters.dueTo); clauses.push(`a.due_date <= $${params.length}::date`); }

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

export interface AnalysisRow {
  id: number; trf_id: number; test_name: string; test_method: string | null; specification: string | null;
  assigned_employee_id: number | null; assigned_date: string | null; due_date: string | null;
  status: import('@trf/shared').AnalysisStatus; version: number; updated_at: Date;
  start_date: string | null; completion_date: string | null; remarks: string | null;
  trf_number: string; batch_number: string | null; trf_status: TrfStatus; priority: Priority;
  required_completion_date: string | null; trf_version: number;
  product_name: string | null; customer_name: string | null; assigned_employee_name: string | null;
  result_id: number | null; result_value: string | number | null; result_text: string | null;
  unit: string | null; method_used: string | null; lower_limit: string | number | null;
  upper_limit: string | number | null; result_remarks: string | null;
  entered_by: number | null; entered_at: Date | null; result_version: number | null;
  result_updated_at: Date | null; entered_by_name: string | null;
  outcome: Outcome; is_delayed: boolean;
}

export const dateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  return (typeof value === 'string' ? value : value.toISOString()).slice(0, 10);
};

/** NUMERIC arrives as a string by default, which is exactly what keeps 14 digits intact. */
const decimal = (value: string | number | null): string | null =>
  value === null || value === undefined ? null : String(value);

export function toAnalysisResult(row: AnalysisRow): AnalysisResult | null {
  if (!row.result_id) return null;
  return {
    id: row.result_id,
    analysisTestId: row.id,
    resultValue: decimal(row.result_value),
    resultText: row.result_text,
    unit: row.unit,
    methodUsed: row.method_used,
    lowerLimit: decimal(row.lower_limit),
    upperLimit: decimal(row.upper_limit),
    remarks: row.result_remarks,
    enteredById: row.entered_by,
    enteredByName: row.entered_by_name,
    enteredAt: row.entered_at ? new Date(row.entered_at).toISOString() : null,
    version: row.result_version ?? 1,
    updatedAt: row.result_updated_at ? new Date(row.result_updated_at).toISOString() : new Date().toISOString(),
  };
}

export function toAnalysisItem(row: AnalysisRow): AnalysisItem {
  return {
    id: row.id,
    trfId: row.trf_id,
    trfNumber: row.trf_number,
    productName: row.product_name,
    batchNumber: row.batch_number,
    customerName: row.customer_name,
    trfStatus: row.trf_status,
    trfVersion: row.trf_version,
    priority: row.priority,
    requiredCompletionDate: dateOnly(row.required_completion_date),
    testName: row.test_name,
    testMethod: row.test_method,
    specification: row.specification,
    assignedEmployeeId: row.assigned_employee_id,
    assignedEmployeeName: row.assigned_employee_name,
    assignedDate: dateOnly(row.assigned_date),
    dueDate: dateOnly(row.due_date),
    status: row.status,
    isDelayed: Boolean(row.is_delayed),
    startDate: dateOnly(row.start_date),
    completionDate: dateOnly(row.completion_date),
    remarks: row.remarks,
    outcome: row.outcome,
    result: toAnalysisResult(row),
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
