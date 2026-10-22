import { z } from 'zod';
import {
   PRIORITIES, TRF_SORT_FIELDS, TRF_STATUSES, TrfDetail, TrfFilters, TrfListItem, TrfStatus, Priority,
   ArdWorkflowStatus, ArdStage, ArdReportingStatus, ArdCoaStatus, RemarksStatus, ArdRemarksStatus,
   DEFAULT_ARD_STAGE,
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
  workflowStatus: z.string().default(''),
  analystId: z.coerce.number().int().positive().optional(),
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
    workflowStatus: splitList(q.workflowStatus, ArdWorkflowStatus) as ArdWorkflowStatus[],
    analystId: q.analystId,
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
  workflowStatus: 't.workflow_status',
  tat: 'tat',
  createdBy: 't.created_by',
  createdAt: 't.created_at',
  ardRemarksStatus: 't.ard_remarks_status',
  remarksStatus: 't.remarks_status',
  assignedEmployeeName: 'e.full_name',
  batchSize: 't.batch_size',
  dosageForm: 't.dosage_form',
  manufacturingLocation: 't.manufacturing_location',
  labelClaim: 't.label_claim',
  packSize: 't.pack_size',
  packType: 't.pack_type',
  storageCondition: 't.storage_condition',
  storagePeriod: 't.storage_period',
  manufacturingDate: 't.manufacturing_date',
  expiryDate: 't.expiry_date',
  sampleQuantity: 't.sample_quantity',
  requestedAnalysis: 't.requested_analysis',
  specialInstructions: 't.special_instructions',
  analysisPurpose: 't.analysis_purpose',
  remarks: 't.remarks',
   sampleGivenBy: 't.sample_given_by',
   sampleSubmittedById: 't.sample_submitted_by_id',
   sampleSubmittedByName: 'ssb.full_name',
   signatureDate: 't.signature_date',
  ardNumber: 't.ard_number',
  analystName: 'an.full_name',
  analysisStartDate: 't.analysis_start_date',
  reportingStatus: 't.reporting_status',
  coaStatus: 't.coa_status',
  ardRemarks: 't.ard_remarks',
  sampleReceivedByName: 'srb.full_name',
  sampleReceivedDate: 't.sample_received_date',
  stage: 't.ard_stage',
};

/** Overdue is always this expression: due date passed and status not terminal. Never stored. */
export const OVERDUE_SQL = `(t.required_completion_date IS NOT NULL AND t.required_completion_date < CURRENT_DATE
  AND t.status NOT IN ('Completed', 'Cancelled'))`;

/**
 * TAT for the ARD workflow: calendar days from the Date of Analysis to the day
 * the Final Status became terminal, or to today while the request is still
 * open. NULL when no Date of Analysis has been recorded. Computed on the fly,
 * never stored, so it always reflects the current date.
 */
export const ARD_TAT_SQL = `CASE WHEN t.analysis_start_date IS NULL THEN NULL
  WHEN t.workflow_status IN ('Completed', 'Cancelled')
    THEN COALESCE(t.finalized_at, t.analysis_start_date)::date - t.analysis_start_date::date
  ELSE CURRENT_DATE - t.analysis_start_date::date END`;

export const TRF_SELECT = `
  t.id, t.trf_number, t.trf_date, t.customer_id, c.name AS customer_name,
  t.product_id, p.name AS product_name, t.batch_number, t.priority, t.status,
  t.required_completion_date, t.assigned_employee_id, e.full_name AS assigned_employee_name,
  t.department_id, d.name AS department_name, t.created_at, t.updated_at, t.version,
  t.sample_quantity, t.sample_received_date, t.requested_analysis, t.special_instructions,
  t.remarks, t.created_by, cb.full_name AS created_by_name,
  t.batch_size, t.dosage_form, t.manufacturing_location, t.label_claim,
  t.pack_size, t.pack_type, t.storage_condition, t.storage_period,
  t.manufacturing_date, t.expiry_date, t.analysis_purpose, t.sample_given_by, t.signature_date,
  t.ard_number, t.ard_stage, t.ard_analyst_id, an.full_name AS analyst_name,
  t.analysis_start_date, t.reporting_status, t.coa_status, t.workflow_status, t.ard_remarks,
  t.remarks_status, t.ard_remarks_status, t.sample_received_by, srb.full_name AS sample_received_by_name,
  t.sample_submitted_by_id, ssb.full_name AS sample_submitted_by_name,
  t.finalized_at, t.deleted_at
`;

export const TRF_FROM = `
  FROM trfs t
  LEFT JOIN customers c ON c.id = t.customer_id
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN employees e ON e.id = t.assigned_employee_id
  LEFT JOIN departments d ON d.id = t.department_id
  LEFT JOIN employees ssb ON ssb.id = t.sample_submitted_by_id
`;

/**
 * ARD analyst, creator and sample receiver joined so the screens can show
 * their names. Every alias used by TRF_SELECT has to be joined exactly once.
 */
export const TRF_DETAIL_FROM = `${TRF_FROM}
  LEFT JOIN employees cb ON cb.id = t.created_by
  LEFT JOIN employees an ON an.id = t.ard_analyst_id
  LEFT JOIN employees srb ON srb.id = t.sample_received_by`;

/**
 * A DATE column arrives as a Date at local midnight. Reading it back through
 * toISOString() would move it to the previous day for anyone east of
 * Greenwich, so the local calendar day is taken instead. The Excel export
 * writes the same local day, so the two agree.
 */
const dateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const timestamp = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

export interface TrfRow {
   id: number; trf_number: string; trf_date: string; customer_id: number | null; customer_name: string | null;
  product_id: number | null; product_name: string | null; batch_number: string | null; priority: Priority;
  status: TrfStatus; required_completion_date: string | null; assigned_employee_id: number | null;
  assigned_employee_name: string | null; department_id: number | null; department_name: string | null;
  created_at: Date; updated_at: Date; version: number;
  sample_quantity: string | null; sample_received_date: string | null; requested_analysis: string | null;
  special_instructions: string | null; remarks: string | null; created_by: number | null;
  created_by_name: string | null;
  batch_size: string | null; dosage_form: string | null; manufacturing_location: string | null;
  label_claim: string | null; pack_size: string | null; pack_type: string | null;
  storage_condition: string | null; storage_period: string | null;
  manufacturing_date: string | null; expiry_date: string | null; analysis_purpose: string | null;
  sample_given_by: string | null; signature_date: string | null;
  ard_number: string | null; ard_stage: string; ard_analyst_id: number | null; analyst_name: string | null;
  analysis_start_date: string | null; reporting_status: string; coa_status: string;
  workflow_status: string; ard_remarks: string | null;
   remarks_status: string; ard_remarks_status: string; sample_received_by: number | null;
   sample_received_by_name: string | null;
   sample_submitted_by_id: number | null; sample_submitted_by_name: string | null;
   finalized_at: Date | string | null; deleted_at: Date | string | null;
   tat: number | null;
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
    sampleQuantity: row.sample_quantity,
    sampleReceivedDate: dateOnly(row.sample_received_date),
    requestedAnalysis: row.requested_analysis,
    specialInstructions: row.special_instructions,
    remarks: row.remarks,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    batchSize: row.batch_size,
    dosageForm: row.dosage_form,
    manufacturingLocation: row.manufacturing_location,
    labelClaim: row.label_claim,
    packSize: row.pack_size,
    packType: row.pack_type,
    storageCondition: row.storage_condition,
    storagePeriod: row.storage_period,
    manufacturingDate: dateOnly(row.manufacturing_date),
    expiryDate: dateOnly(row.expiry_date),
    analysisPurpose: row.analysis_purpose,
     sampleGivenBy: row.sample_given_by,
     sampleSubmittedById: row.sample_submitted_by_id,
     sampleSubmittedByName: row.sample_submitted_by_name,
     signatureDate: dateOnly(row.signature_date),
    ardNumber: row.ard_number,
    ardAnalystId: row.ard_analyst_id,
     stage: (row.ard_stage ?? DEFAULT_ARD_STAGE) as ArdStage,
    analystName: row.analyst_name,
    analysisStartDate: dateOnly(row.analysis_start_date),
    reportingStatus: (row.reporting_status ?? 'Pending') as ArdReportingStatus,
    coaStatus: (row.coa_status ?? 'Pending') as ArdCoaStatus,
    tat: row.tat,
    workflowStatus: (row.workflow_status ?? 'Received') as ArdWorkflowStatus,
    remarksStatus: (row.remarks_status ?? 'Pending') as RemarksStatus,
    sampleReceivedBy: row.sample_received_by,
    sampleReceivedByName: row.sample_received_by_name,
    ardRemarksStatus: (row.ard_remarks_status ?? 'Pending') as ArdRemarksStatus,
    ardRemarks: row.ard_remarks,
    finalizedAt: timestamp(row.finalized_at),
    deletedAt: timestamp(row.deleted_at),
  };
}

export function toDetail(row: TrfRow, overdue: boolean): TrfDetail {
  return { ...toListItem(row, overdue) };
}

/**
 * The detail select is the list select plus the calculated TAT. The list
 * select already carries every stored column, so nothing is repeated here.
 */
export const TRF_DETAIL_SELECT = `${TRF_SELECT},
  (${ARD_TAT_SQL}) AS tat`;
