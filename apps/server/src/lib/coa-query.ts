import { z } from 'zod';
import type { Coa, CoaFilters, CoaLine, CoaSignOff, CoaSortField, CoaStatus, Outcome, Priority, TrfStatus } from '@trf/shared';
import { COA_SORT_FIELDS, COA_STATUSES } from '@trf/shared';

export const COA_SELECT = `
  c.id, c.trf_id, c.coa_number, c.status, c.remarks, c.version, c.created_at, c.updated_at,
  c.prepared_by, c.prepared_at, c.reviewed_by, c.reviewed_at,
  c.approved_by, c.approved_at, c.issued_by, c.issued_at,
  t.trf_number, t.trf_date, t.batch_number, t.status AS trf_status, t.priority,
  t.required_completion_date, t.sample_quantity, t.requested_analysis,
  p.name AS product_name, cu.name AS customer_name, cu.address AS customer_address,
  prep.full_name AS prepared_by_name, rev.full_name AS reviewed_by_name,
  appr.full_name AS approved_by_name, iss.full_name AS issued_by_name
`;

export const COA_FROM = `
  FROM coas c
  JOIN trfs t ON t.id = c.trf_id
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN customers cu ON cu.id = t.customer_id
  LEFT JOIN employees prep ON prep.id = c.prepared_by
  LEFT JOIN employees rev ON rev.id = c.reviewed_by
  LEFT JOIN employees appr ON appr.id = c.approved_by
  LEFT JOIN employees iss ON iss.id = c.issued_by
`;

export const COA_SORT_SQL: Record<CoaSortField, string> = {
  coaNumber: 'c.coa_number',
  trfNumber: 't.trf_number',
  customerName: 'cu.name',
  status: 'c.status',
  createdAt: 'c.created_at',
  issuedAt: 'c.issued_at',
};

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

export const coaListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).default(''),
  status: z.string().default(''),
  trfId: z.coerce.number().int().positive().optional(),
  trfNumber: z.string().trim().max(40).default(''),
  dateFrom: ISO_DATE.optional(),
  dateTo: ISO_DATE.optional(),
  mineOnly: z.enum(['true', 'false']).default('false'),
  sortBy: z.enum(COA_SORT_FIELDS).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export function toCoaFilters(q: z.infer<typeof coaListQuerySchema>): CoaFilters {
  return {
    page: q.page,
    pageSize: q.pageSize,
    search: q.search,
    status: q.status.split(',').map((v) => v.trim())
      .filter((v): v is CoaStatus => (COA_STATUSES as readonly string[]).includes(v)),
    trfId: q.trfId,
    trfNumber: q.trfNumber,
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    mineOnly: q.mineOnly === 'true',
    sortBy: q.sortBy,
    sortDir: q.sortDir,
  };
}

export function buildCoaWhere(filters: CoaFilters, params: unknown[], scope: { employeeId: number } | null): string {
  const clauses: string[] = [];

  // "Prepared by me": the certificates this person is responsible for.
  if (scope) {
    params.push(scope.employeeId);
    clauses.push(`(c.prepared_by = $${params.length} OR c.approved_by = $${params.length})`);
  }

  if (filters.search) {
    params.push(`%${filters.search.toLowerCase()}%`);
    const p = params.length;
    clauses.push(`(lower(COALESCE(c.coa_number, '')) LIKE $${p} OR lower(t.trf_number) LIKE $${p}
      OR lower(COALESCE(t.batch_number, '')) LIKE $${p} OR lower(COALESCE(p.name, '')) LIKE $${p}
      OR lower(COALESCE(cu.name, '')) LIKE $${p})`);
  }
  if (filters.trfNumber) {
    params.push(`%${filters.trfNumber.toLowerCase()}%`);
    clauses.push(`lower(t.trf_number) LIKE $${params.length}`);
  }
  if (filters.status.length) {
    params.push(filters.status);
    clauses.push(`c.status = ANY($${params.length})`);
  }
  if (filters.trfId) { params.push(filters.trfId); clauses.push(`c.trf_id = $${params.length}`); }
  // Filtered on the date the certificate was raised, which is what a report means.
  if (filters.dateFrom) { params.push(filters.dateFrom); clauses.push(`c.created_at >= $${params.length}::date`); }
  if (filters.dateTo) { params.push(filters.dateTo); clauses.push(`c.created_at < ($${params.length}::date + INTERVAL '1 day')`); }

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

export interface CoaRow {
  id: number; trf_id: number; coa_number: string | null; status: CoaStatus; remarks: string | null;
  version: number; created_at: Date; updated_at: Date;
  prepared_by: number | null; prepared_at: Date | null;
  reviewed_by: number | null; reviewed_at: Date | null;
  approved_by: number | null; approved_at: Date | null;
  issued_by: number | null; issued_at: Date | null;
  trf_number: string; trf_date: Date | string; batch_number: string | null; trf_status: TrfStatus; priority: Priority;
  required_completion_date: Date | string | null; sample_quantity: string | null; requested_analysis: string | null;
  product_name: string | null; customer_name: string | null; customer_address: string | null;
  prepared_by_name: string | null; reviewed_by_name: string | null;
  approved_by_name: string | null; issued_by_name: string | null;
}

export interface CoaLineRow {
  id: number; analysis_test_id: number | null; test_name: string; test_method: string | null;
  specification: string | null; result_value: string | number | null; result_text: string | null;
  unit: string | null; lower_limit: string | number | null; upper_limit: string | number | null;
  outcome: Outcome;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);
const decimal = (value: string | number | null): string | null =>
  value === null || value === undefined ? null : String(value);

/** A DATE column arrives as a Date object or a string, depending on the driver build. */
const dateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
};

export function toCoaLine(row: CoaLineRow): CoaLine {
  return {
    id: row.id,
    analysisTestId: row.analysis_test_id,
    testName: row.test_name,
    testMethod: row.test_method,
    specification: row.specification,
    resultValue: decimal(row.result_value),
    resultText: row.result_text,
    unit: row.unit,
    lowerLimit: decimal(row.lower_limit),
    upperLimit: decimal(row.upper_limit),
    outcome: row.outcome,
  };
}

const signOff = (id: number | null, name: string | null, at: Date | null): CoaSignOff => ({ id, name, at: iso(at) });

export function toCoa(row: CoaRow, lines: CoaLineRow[]): Coa {
  const items = lines.map(toCoaLine);
  return {
    id: row.id,
    trfId: row.trf_id,
    trfNumber: row.trf_number,
    coaNumber: row.coa_number,
    status: row.status,
    trfStatus: row.trf_status,
    productName: row.product_name,
    batchNumber: row.batch_number,
    customerName: row.customer_name,
    customerAddress: row.customer_address,
    trfDate: dateOnly(row.trf_date) ?? '',
    requiredCompletionDate: dateOnly(row.required_completion_date),
    priority: row.priority,
    sampleQuantity: row.sample_quantity,
    requestedAnalysis: row.requested_analysis,
    remarks: row.remarks,
    preparedBy: signOff(row.prepared_by, row.prepared_by_name, row.prepared_at),
    reviewedBy: signOff(row.reviewed_by, row.reviewed_by_name, row.reviewed_at),
    approvedBy: signOff(row.approved_by, row.approved_by_name, row.approved_at),
    issuedBy: signOff(row.issued_by, row.issued_by_name, row.issued_at),
    lines: items,
    counts: {
      total: items.length,
      passed: items.filter((l) => l.outcome === 'Pass').length,
      failed: items.filter((l) => l.outcome === 'Fail').length,
    },
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
