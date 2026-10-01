import { z } from 'zod';
import {
  PRIORITIES, TRF_SORT_FIELDS, TRF_STATUSES, TrfDetail, TrfFilters, TrfListItem, TrfStatus, Priority,
} from '@trf/shared';

/** One parser for the list endpoint's query string, so the client cannot inject SQL fragments. */
export const trfListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).default(''),
  status: z.string().default(''),
  priority: z.string().default(''),
  customerId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  assignedEmployeeId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.').optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.').optional(),
  dueFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  overdueOnly: z.enum(['true', 'false']).default('false'),
  sortBy: z.enum(TRF_SORT_FIELDS).default('trfDate'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

const splitList = (raw: string, allowed: readonly string[]): string[] =>
  raw.split(',').map((v) => v.trim()).filter((v) => v && allowed.includes(v));

export function toFilters(q: z.infer<typeof trfListQuerySchema>): TrfFilters {
  return {
    page: q.page,
    pageSize: q.pageSize,
    search: q.search,
    status: splitList(q.status, TRF_STATUSES) as TrfStatus[],
    priority: splitList(q.priority, PRIORITIES) as Priority[],
    customerId: q.customerId,
    productId: q.productId,
    assignedEmployeeId: q.assignedEmployeeId,
    departmentId: q.departmentId,
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    dueFrom: q.dueFrom,
    dueTo: q.dueTo,
    overdueOnly: q.overdueOnly === 'true',
    sortBy: q.sortBy,
    sortDir: q.sortDir,
  };
}

/** Whitelisted sort columns: the client sends a field name, never a SQL fragment. */
export const TRF_SORT_SQL: Record<string, string> = {
  trfNumber: 't.trf_number',
  trfDate: 't.trf_date',
  customerName: 'c.name',
  productName: 'p.name',
  batchNumber: 't.batch_number',
  priority: 't.priority',
  status: 't.status',
  requiredCompletionDate: 't.required_completion_date',
  createdAt: 't.created_at',
};

/** Overdue is always this expression: due date passed and status not terminal. Never stored. */
export const OVERDUE_SQL = `(t.required_completion_date IS NOT NULL AND t.required_completion_date < CURRENT_DATE
  AND t.status NOT IN ('Completed', 'Cancelled'))`;

export const TRF_SELECT = `
  t.id, t.trf_number, t.trf_date, t.customer_id, c.name AS customer_name,
  t.product_id, p.name AS product_name, t.batch_number, t.priority, t.status,
  t.required_completion_date, t.assigned_employee_id, e.full_name AS assigned_employee_name,
  t.department_id, d.name AS department_name, t.created_at, t.updated_at, t.version
`;

export const TRF_FROM = `
  FROM trfs t
  LEFT JOIN customers c ON c.id = t.customer_id
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN employees e ON e.id = t.assigned_employee_id
  LEFT JOIN departments d ON d.id = t.department_id
`;

const dateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
};

const timestamp = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

export interface TrfRow {
  id: number; trf_number: string; trf_date: string; customer_id: number | null; customer_name: string | null;
  product_id: number | null; product_name: string | null; batch_number: string | null; priority: Priority;
  status: TrfStatus; required_completion_date: string | null; assigned_employee_id: number | null;
  assigned_employee_name: string | null; department_id: number | null; department_name: string | null;
  created_at: Date; updated_at: Date; version: number;
  // detail-only columns
  sample_quantity: string | null; sample_received_date: string | null; requested_analysis: string | null;
  special_instructions: string | null; remarks: string | null; created_by: number | null;
  created_by_name: string | null;
}

export function toListItem(row: TrfRow, overdue: boolean): TrfListItem {
  return {
    id: row.id,
    trfNumber: row.trf_number,
    trfDate: dateOnly(row.trf_date)!,
    customerId: row.customer_id,
    customerName: row.customer_name,
    productId: row.product_id,
    productName: row.product_name,
    batchNumber: row.batch_number,
    priority: row.priority,
    status: row.status,
    requiredCompletionDate: dateOnly(row.required_completion_date),
    assignedEmployeeId: row.assigned_employee_id,
    assignedEmployeeName: row.assigned_employee_name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    isOverdue: overdue,
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
    version: row.version,
  };
}

export function toDetail(row: TrfRow, overdue: boolean): TrfDetail {
  return {
    ...toListItem(row, overdue),
    sampleQuantity: row.sample_quantity,
    sampleReceivedDate: dateOnly(row.sample_received_date),
    requestedAnalysis: row.requested_analysis,
    specialInstructions: row.special_instructions,
    remarks: row.remarks,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
  };
}

export const TRF_DETAIL_SELECT = `${TRF_SELECT},
  t.sample_quantity, t.sample_received_date, t.requested_analysis, t.special_instructions,
  t.remarks, t.created_by, cb.full_name AS created_by_name`;

export const TRF_DETAIL_FROM = `${TRF_FROM}
  LEFT JOIN employees cb ON cb.id = t.created_by`;
