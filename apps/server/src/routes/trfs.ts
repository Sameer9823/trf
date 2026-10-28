import { Router } from 'express';
import { z } from 'zod';
import type { EmployeeProfile, TrfListPage, TrfStatus, TrfStatusHistoryEntry, ArdStatusHistoryEntry } from '@trf/shared';
import fs from 'node:fs';
import {
   MESSAGES, PRIORITIES, TRF_STATUS_TRANSITIONS, canTransitionTrf,
   TERMINAL_ARD_STATUSES, roleHasPermission, canEditTrfPartA, canEditTrfPartB,
   ArdWorkflowStatus, ArdRemarksStatus, ARD_REMARKS_STATUSES,
   FINAL_APPROVAL_STATUSES,
} from '@trf/shared';
import { pool, withTransaction } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound, versionConflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { notifyEmployee, createNotification } from '../lib/notifications';
import { nextNumber, trfDuplicateError } from '../lib/numbers';
import {
  OVERDUE_SQL, ARD_TAT_SQL, TRF_DETAIL_FROM, TRF_DETAIL_SELECT, TRF_FROM, TRF_SELECT, TRF_SORT_SQL,
  TrfRow, toDetail, toListItem, trfListQuerySchema, toFilters,
} from '../lib/trf-query';
import { authenticate, currentEmployee, requirePermission, requireTrfCreate, requireTrfEdit, requireArdEdit, requireTrfDelete, requireRole, requireAdminApproval, requireAnyApprover, requireLockAdmin, validateBody } from '../middleware/auth';

const trfsRouter = Router();
trfsRouter.use(authenticate);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

const createSchema = z.object({
  trfDate: ISO_DATE,
  customerId: z.number({
    invalid_type_error: 'Select a customer from the list or create one first.',
  }).int().positive({ message: 'Select a customer from the list or create one first.' }),
  productId: z.number({
    invalid_type_error: 'Select a product from the list or create one first.',
  }).int().positive({ message: 'Select a product from the list or create one first.' }),
  batchNumber: z.string().trim().max(200).nullable().optional(),
  sampleQuantity: z.string().trim().max(60).nullable().optional(),
  sampleReceivedDate: ISO_DATE.nullable().optional(),
  requiredCompletionDate: ISO_DATE.nullable().optional(),
  priority: z.enum(PRIORITIES).default('Normal'),
  requestedAnalysis: z.string().trim().max(4000).nullable().optional(),
  specialInstructions: z.string().trim().max(2000).nullable().optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  remarks: z.string().trim().max(2000).nullable().optional(),
  batchSize: z.string().trim().max(200).nullable().optional(),
  dosageForm: z.string().trim().max(200).nullable().optional(),
  dosageFormOther: z.string().trim().max(2000).nullable().optional(),
  dosageFormOptionIds: z.array(z.number().int().positive()).optional(),
  manufacturingLocation: z.string().trim().max(200).nullable().optional(),
  labelClaim: z.string().trim().max(200).nullable().optional(),
  packSize: z.string().trim().max(200).nullable().optional(),
  packType: z.string().trim().max(200).nullable().optional(),
  storageCondition: z.string().trim().max(200).nullable().optional(),
  storagePeriod: z.string().trim().max(200).nullable().optional(),
  manufacturingDate: ISO_DATE.nullable().optional(),
  expiryDate: ISO_DATE.nullable().optional(),
  analysisPurpose: z.string().trim().max(1000).nullable().optional(),
    sampleGivenBy: z.string().trim().max(200).nullable().optional(),
    sampleSubmittedById: z.number().int().positive().nullable().optional(),
    signatureDate: ISO_DATE.nullable().optional(),
    ardRemarksStatus: z.enum(ARD_REMARKS_STATUSES).optional(),
    // New fields
    genericName: z.string().trim().max(200).nullable().optional(),
    testRequestedOptionIds: z.array(z.number().int().positive()).optional(),
    testRequestedOther: z.string().trim().max(2000).nullable().optional(),
    formulationApprovalStatus: z.enum(FINAL_APPROVAL_STATUSES).optional(),
    ardApprovalStatus: z.enum(FINAL_APPROVAL_STATUSES).optional(),
});

const updateSchema = createSchema.partial().extend({
  version: z.number().int().positive(),
  // The ARD block: Stage, Analyst Name, Date of Analysis, Reporting, COA,
  // the ARD remark Status and note, and the Final Status.
  ardAnalystId: z.number().int().positive().nullable().optional(),
  sampleReceivedById: z.number().int().positive().nullable().optional(),
  analysisStartDate: ISO_DATE.nullable().optional(),
  reportingStatus: z.enum(['Pending', 'Draft', 'Submitted', 'Reviewed', 'Approved', 'Rejected']).optional(),
  coaStatus: z.enum(['Pending', 'Draft', 'Under Review', 'Approved', 'Issued']).optional(),
  workflowStatus: z.enum(ArdWorkflowStatus).optional(),
  ardStage: z.string().trim().min(1, 'Enter a stage.').max(60, 'The stage must be at most 60 characters.').optional(),
  ardRemarks: z.string().trim().max(2000).nullable().optional(),
  ardRemarksStatus: z.enum(ARD_REMARKS_STATUSES).optional(),
  remarksStatus: z.enum(['Pending', 'Approved', 'Rejected']).optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const ardStatusSchema = z.object({
  status: z.enum(ArdWorkflowStatus),
  version: z.number().int().positive(),
  note: z.string().trim().max(500).nullable().optional(),
});

const statusSchema = z.object({
  status: z.enum(['Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed', 'Cancelled']),
  version: z.number().int().positive(),
  note: z.string().trim().max(500).nullable().optional(),
});

const assignSchema = z.object({
  assignedEmployeeId: z.number().int().positive().nullable().optional(),
  version: z.number().int().positive(),
  note: z.string().trim().max(500).nullable().optional(),
});


/**
 * A TRF whose ARD work has been approved is locked. Nobody, not even an
 * administrator, can change it until an administrator unlocks it, so a locked
 * TRF is always exactly what was approved.
 */
function assertNotLocked(row: { locked_at?: Date | string | null }): void {
  if (row.locked_at) {
    throw new AppError(409, 'TRF_LOCKED', 'This TRF is approved and locked. An administrator must unlock it before it can be changed.');
  }
}

interface Scope { employeeId: number; includeApproved?: boolean }

/** Roles without trf.viewAll only ever see their own TRFs, applied inside the query.
 *  ARD team members additionally see TRFs that Formulation has approved and locked_at
 *  is still NULL — i.e. waiting for ARD action — so they can pick up new work. */
function scopeFor(employee: EmployeeProfile): Scope | null {
  if (roleHasPermission(employee.role, 'trf.viewAll')) return null;
  return { employeeId: employee.id, includeApproved: canEditTrfPartB(employee) };
}

/**
 * Part A fields an ordinary edit may touch. The Formulation team owns all of
 * them, including "Sample Submitted By" and the Formulation Status.
 * The TRF number, the status and the ARD block are not in this list.
 */
const EDITABLE_FORMULATION = [
  'trfDate', 'customerId', 'productId', 'batchNumber', 'sampleQuantity',
  'requiredCompletionDate', 'requestedAnalysis', 'specialInstructions', 'remarks',
  'batchSize', 'dosageForm', 'manufacturingLocation', 'labelClaim', 'packSize',
  'packType', 'storageCondition', 'storagePeriod', 'manufacturingDate', 'expiryDate',
  'analysisPurpose', 'sampleGivenBy', 'sampleSubmittedById', 'signatureDate',
  'priority', 'remarksStatus',
  // New fields
  'genericName', 'testRequestedOptionIds', 'testRequestedOther', 'formulationApprovalStatus', 'ardApprovalStatus',
] as const;

/**
 * ARD block fields that ARD analysts may edit via PATCH.
 * These are: Analyst Name, Date of Analysis, Stage, ARD Remark, Sample Received By/Date
 */
const EDITABLE_ARD_ANALYST = [
  'ardAnalystId', 'analysisStartDate', 'ardRemarks',
  'ardStage', 'sampleReceivedById', 'sampleReceivedDate',
] as const;

/**
 * ARD block fields that only AGM/Admin may edit via PATCH.
 * These are: Reporting, COA, ARD Remarks Status, Final Status (workflowStatus)
 */
const EDITABLE_ARD_APPROVAL = [
  'reportingStatus', 'coaStatus', 'ardRemarksStatus', 'workflowStatus',
] as const;

const COLUMN: Record<string, string> = {
  trfDate: 'trf_date',
  customerId: 'customer_id',
  productId: 'product_id',
  batchNumber: 'batch_number',
  sampleQuantity: 'sample_quantity',
  requiredCompletionDate: 'required_completion_date',
  requestedAnalysis: 'requested_analysis',
  specialInstructions: 'special_instructions',
  remarks: 'remarks',
  batchSize: 'batch_size',
  dosageForm: 'dosage_form',
  dosageFormOther: 'dosage_form_other',
  manufacturingLocation: 'manufacturing_location',
  labelClaim: 'label_claim',
  packSize: 'pack_size',
  packType: 'pack_type',
  storageCondition: 'storage_condition',
  storagePeriod: 'storage_period',
  manufacturingDate: 'manufacturing_date',
  expiryDate: 'expiry_date',
  analysisPurpose: 'analysis_purpose',
  sampleGivenBy: 'sample_given_by',
  sampleSubmittedById: 'sample_submitted_by_id',
  signatureDate: 'signature_date',
  priority: 'priority',
  ardAnalystId: 'ard_analyst_id',
  analysisStartDate: 'analysis_start_date',
  workflowStatus: 'workflow_status',
  ardStage: 'ard_stage',
  reportingStatus: 'reporting_status',
  coaStatus: 'coa_status',
   ardRemarks: 'ard_remarks',
   remarksStatus: 'remarks_status',
   sampleReceivedDate: 'sample_received_date',
   sampleReceivedById: 'sample_received_by_id',
   ardRemarksStatus: 'ard_remarks_status',
  // New fields
  genericName: 'generic_name',
  testRequestedOptionIds: 'test_requested_option_ids',
  testRequestedOther: 'test_requested_other',
  formulationApprovalStatus: 'formulation_approval_status',
  ardApprovalStatus: 'ard_approval_status',
};

/** A blank text field is stored as NULL, so search and exports do not see empty strings. */
const normalise = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value ?? null;
};

function buildWhere(filters: ReturnType<typeof toFilters>, params: unknown[], scope: Scope | null): string {
  const clauses: string[] = [];

  // Soft-deleted rows are invisible.
  clauses.push('t.deleted_at IS NULL');

  // Applied in SQL, so a restricted user never receives rows they must not see.
  if (scope) {
    params.push(scope.employeeId);
    const own = `(t.assigned_employee_id = $${params.length} OR t.created_by = $${params.length})`;
    if (scope.includeApproved) {
      clauses.push(`(${own} OR (t.remarks_status = 'Approved' AND t.locked_at IS NULL))`);
    } else {
      clauses.push(own);
    }
  }

  if (filters.search) {
    // One parameter, nine comparisons: PostgreSQL can reuse the one plan.
    // Test Requested and Test Details are searched here too, so a user can find
    // a TRF by what it asks for.
    params.push(`%${filters.search.toLowerCase()}%`);
    const p = params.length;
    clauses.push(`(lower(t.trf_number) LIKE $${p} OR lower(COALESCE(t.batch_number, '')) LIKE $${p}
      OR lower(COALESCE(c.name, '')) LIKE $${p} OR lower(COALESCE(p.name, '')) LIKE $${p}
      OR lower(COALESCE(e.full_name, '')) LIKE $${p} OR lower(COALESCE(an.full_name, '')) LIKE $${p}
      OR lower(COALESCE(ssb.full_name, '')) LIKE $${p} OR lower(COALESCE(t.sample_given_by, '')) LIKE $${p}
      OR lower(COALESCE(t.requested_analysis, '')) LIKE $${p} OR lower(COALESCE(t.special_instructions, '')) LIKE $${p})`);
  }
  if (filters.status.length) {
    params.push(filters.status);
    clauses.push(`t.status = ANY($${params.length})`);
  }
  if (filters.priority.length) {
    params.push(filters.priority);
    clauses.push(`t.priority = ANY($${params.length})`);
  }
  if (filters.customerId) { params.push(filters.customerId); clauses.push(`t.customer_id = $${params.length}`); }
  if (filters.productId) { params.push(filters.productId); clauses.push(`t.product_id = $${params.length}`); }
  if (filters.assignedEmployeeId) { params.push(filters.assignedEmployeeId); clauses.push(`t.assigned_employee_id = $${params.length}`); }
  if (filters.departmentId) { params.push(filters.departmentId); clauses.push(`t.department_id = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); clauses.push(`t.trf_date >= $${params.length}::date`); }
  if (filters.dateTo) { params.push(filters.dateTo); clauses.push(`t.trf_date <= $${params.length}::date`); }
  if (filters.dueFrom) { params.push(filters.dueFrom); clauses.push(`t.required_completion_date >= $${params.length}::date`); }
  if (filters.dueTo) { params.push(filters.dueTo); clauses.push(`t.required_completion_date <= $${params.length}::date`); }
  if (filters.workflowStatus?.length) { params.push(filters.workflowStatus); clauses.push(`t.workflow_status = ANY($${params.length})`); }
  if (filters.analystId) { params.push(filters.analystId); clauses.push(`t.ard_analyst_id = $${params.length}`); }
  if (filters.overdueOnly) clauses.push(OVERDUE_SQL);
  if (filters.approvalPending) clauses.push(`(t.remarks_status = 'Pending' OR t.final_approval_status = 'Pending')`);

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

trfsRouter.get('/', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const filters = toFilters(trfListQuerySchema.parse(req.query));
    const params: unknown[] = [];
    const whereSql = buildWhere(filters, params, scopeFor(currentEmployee(req)));

    // Count query: needs the same JOINs as the main query for the search clause to work
    // (search references customer name, product name, employee names, etc.)
    const countFrom = `
      FROM trfs t
      LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN products p ON p.id = t.product_id
      LEFT JOIN employees e ON e.id = t.assigned_employee_id
      LEFT JOIN employees an ON an.id = t.ard_analyst_id
      LEFT JOIN employees ssb ON ssb.id = t.sample_submitted_by_id
    `;
    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count ${countFrom} ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0].count);

    const sortColumn = TRF_SORT_SQL[filters.sortBy];
    const dir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

    // List query: select only columns needed for the list view to reduce payload and JOIN overhead
    // The detail view uses a separate endpoint (/trfs/:id) which loads all columns
    const listSelect = `
      t.id, t.trf_number, t.trf_date, t.customer_id, c.name AS customer_name,
      t.product_id, p.name AS product_name, t.batch_number, t.priority, t.status,
      t.required_completion_date, t.assigned_employee_id, e.full_name AS assigned_employee_name,
      t.department_id, d.name AS department_name, t.created_at, t.updated_at, t.version,
      t.sample_quantity, t.sample_received_date, t.requested_analysis, t.special_instructions,
      t.remarks, t.created_by, cb.full_name AS created_by_name,
      t.batch_size, t.dosage_form, t.manufacturing_location, t.label_claim,
      t.pack_size, t.pack_type, t.storage_condition, t.storage_period,
      t.manufacturing_date, t.expiry_date, t.analysis_purpose, t.sample_given_by,
      t.sample_submitted_by_id, ssb.full_name AS sample_submitted_by_name,
      t.signature_date,
      t.ard_number, t.ard_stage, t.ard_analyst_id, an.full_name AS analyst_name,
      t.analysis_start_date, t.reporting_status, t.coa_status, t.workflow_status, t.ard_remarks,
      t.remarks_status, t.ard_remarks_status,
      t.formulation_decided_at, fmd.full_name AS formulation_decided_by_name,
      t.final_approval_status, t.final_decided_at, fnd.full_name AS final_decided_by_name,
      t.locked_at, t.locked_by, lkb.full_name AS locked_by_name,
      t.finalized_at, t.deleted_at
    `;

    const listFrom = `
      FROM trfs t
      LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN products p ON p.id = t.product_id
      LEFT JOIN employees e ON e.id = t.assigned_employee_id
      LEFT JOIN departments d ON d.id = t.department_id
      LEFT JOIN employees cb ON cb.id = t.created_by
      LEFT JOIN employees an ON an.id = t.ard_analyst_id
      LEFT JOIN employees ssb ON ssb.id = t.sample_submitted_by_id
      LEFT JOIN employees fmd ON fmd.id = t.formulation_decided_by
      LEFT JOIN employees fnd ON fnd.id = t.final_decided_by
      LEFT JOIN employees lkb ON lkb.id = t.locked_by
    `;

    const rows = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${listSelect}, (${ARD_TAT_SQL}) AS tat, (${OVERDUE_SQL}) AS is_overdue ${listFrom} ${whereSql}
        ORDER BY ${sortColumn} ${dir} NULLS LAST, t.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );

    const body: TrfListPage = {
      items: rows.rows.map((row) => toListItem(row, row.is_overdue)),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    };
    res.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    next(err);
  }
});

trfsRouter.get('/:id', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const row = await loadVisibleTrf(id, currentEmployee(req));
    res.json(toDetail(row, row.is_overdue));
  } catch (err) {
    next(err);
  }
});

/** Loads one TRF and enforces the same visibility rule as the list. */
async function loadVisibleTrf(id: number, employee: EmployeeProfile): Promise<TrfRow & { is_overdue: boolean }> {
  const result = await pool.query<TrfRow & { is_overdue: boolean }>(
    `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`, [id],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at) throw notFound();
  const scope = scopeFor(employee);
  if (scope === null) return row;
  if (row.assigned_employee_id === employee.id || row.created_by === employee.id) return row;
  if (scope.includeApproved && row.remarks_status === 'Approved' && !row.locked_at) return row;
  throw forbidden();
}

trfsRouter.get('/:id/history', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    await loadVisibleTrf(id, currentEmployee(req));

    const result = await pool.query<{
      id: number; old_status: TrfStatus | null; new_status: TrfStatus;
      changed_by_name: string | null; changed_at: Date; note: string | null;
    }>(
      `SELECT h.id, h.old_status, h.new_status, e.full_name AS changed_by_name, h.changed_at, h.note
       FROM trf_status_history h LEFT JOIN employees e ON e.id = h.changed_by
       WHERE h.trf_id = $1 ORDER BY h.changed_at DESC, h.id DESC`,
      [id],
    );
    const items: TrfStatusHistoryEntry[] = result.rows.map((r) => ({
      id: r.id, oldStatus: r.old_status, newStatus: r.new_status,
      changedByName: r.changed_by_name, changedAt: new Date(r.changed_at).toISOString(), note: r.note,
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

trfsRouter.post('/', requireTrfCreate(), validateBody(createSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const body = req.body as z.infer<typeof createSchema>;
    if (body.sampleReceivedDate && body.trfDate && body.sampleReceivedDate < body.trfDate) {
      throw badRequest('The sample received date cannot be earlier than the TRF date.', {
        sampleReceivedDate: 'The sample received date cannot be earlier than the TRF date.',
      });
    }
     if (body.expiryDate && body.manufacturingDate && body.expiryDate <= body.manufacturingDate) {
       throw badRequest('The expiry date must be after the manufacturing date.', {
         expiryDate: 'The expiry date must be later than the manufacturing date.',
       });
     }

    // Validate foreign keys before the INSERT so a missing customer or product
    // returns a 400 instead of a 500 from the database constraint.
    if (body.customerId) {
      const existing = await pool.query('SELECT 1 FROM customers WHERE id = $1', [body.customerId]);
      if (!existing.rowCount) throw badRequest('That customer does not exist.', { customerId: 'Select a customer from the list or create one first.' });
    }
     if (body.productId) {
       const existing = await pool.query('SELECT 1 FROM products WHERE id = $1', [body.productId]);
       if (!existing.rowCount) throw badRequest('That product does not exist.', { productId: 'Select a product from the list or create one first.' });
     }
  if (body.sampleSubmittedById) {
        const existing = await pool.query('SELECT 1 FROM employees WHERE id = $1 AND is_active = TRUE', [body.sampleSubmittedById]);
        if (!existing.rowCount) throw badRequest('That employee does not exist or is not active.', { sampleSubmittedById: 'Select a valid employee from the list.' });
      }
      // Mandatory validation: at least one Test Requested option
      const testOptionIds = (body as any).testRequestedOptionIds as number[] | undefined;
      if (!testOptionIds || testOptionIds.length === 0) {
        throw badRequest('Select at least one test requested.', { testRequestedOptionIds: 'Select at least one test requested.' });
      }
      // Mandatory validation: at least one Dosage Form option
      const dosageOptionIds = (body as any).dosageFormOptionIds as number[] | undefined;
      if (!dosageOptionIds || dosageOptionIds.length === 0) {
        throw badRequest('Select at least one dosage form.', { dosageFormOptionIds: 'Select at least one dosage form.' });
      }
      // Validate test requested option IDs exist
      if (testOptionIds.length > 0) {
        const testOptionCount = await pool.query('SELECT COUNT(*)::int AS count FROM test_requested_options WHERE id = ANY($1)', [testOptionIds]);
        if (testOptionCount.rows[0].count !== testOptionIds.length) {
          throw badRequest('One or more selected tests are not recognised.', { testRequestedOptionIds: 'Choose tests from the list.' });
        }
      }
      // Validate dosage form option IDs exist
      if (dosageOptionIds.length > 0) {
        const dosageOptionCount = await pool.query('SELECT COUNT(*)::int AS count FROM dosage_form_options WHERE id = ANY($1)', [dosageOptionIds]);
        if (dosageOptionCount.rows[0].count !== dosageOptionIds.length) {
          throw badRequest('One or more selected dosage forms are not recognised.', { dosageFormOptionIds: 'Choose dosage forms from the list.' });
        }
      }


    const created = await withTransaction(async (client) => {
      const trfNumber = await nextNumber(client, 'TRF', Number((body.trfDate as string).slice(0, 4)));
      const isArdUser = canEditTrfPartB(user) && !canEditTrfPartA(user);
      const initialLockedAt = isArdUser ? 'now()' : 'NULL';
      const initialLockedBy = isArdUser ? user.id : 'NULL';
      
      // Get generic_name from product if not provided
      let genericName = body.genericName ?? null;
      if (!genericName && body.productId) {
        const productResult = await client.query('SELECT generic_name FROM products WHERE id = $1', [body.productId]);
        if ((productResult.rowCount ?? 0) > 0) {
          genericName = productResult.rows[0].generic_name;
        }
      }
      
      const inserted = await client.query<{ id: number }>(
         `INSERT INTO trfs (trf_number, trf_date, customer_id, product_id, batch_number, sample_quantity,
             sample_received_date, required_completion_date, priority, requested_analysis,
             special_instructions, department_id, remarks, batch_size, dosage_form,
             manufacturing_location, label_claim, pack_size, pack_type, storage_condition,
             storage_period, manufacturing_date, expiry_date, analysis_purpose,
             sample_given_by, sample_submitted_by_id, signature_date, created_by, remarks_status, ard_remarks_status, locked_at, locked_by,
              generic_name, formulation_approval_status, ard_approval_status, test_requested_other, dosage_form_other)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
              $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, ${initialLockedAt}, ${initialLockedBy}, $31, $32, $33, $34, $35)
            RETURNING id`,
          [trfNumber, body.trfDate, body.customerId, body.productId,
            body.batchNumber ?? null, body.sampleQuantity ?? null, body.sampleReceivedDate ?? null,
            body.requiredCompletionDate ?? null, body.priority, body.requestedAnalysis ?? null,
            body.specialInstructions ?? null, body.departmentId ?? user.departmentId ?? null,
            body.remarks ?? null, body.batchSize ?? null, body.dosageForm ?? null,
            body.manufacturingLocation ?? null, body.labelClaim ?? null, body.packSize ?? null,
            body.packType ?? null, body.storageCondition ?? null, body.storagePeriod ?? null,
            body.manufacturingDate ?? null, body.expiryDate ?? null, body.analysisPurpose ?? null,
            body.sampleGivenBy ?? null, body.sampleSubmittedById ?? null, body.signatureDate ?? null, user.id,
            'Pending', body.ardRemarksStatus ?? 'Pending',
            genericName, body.formulationApprovalStatus ?? 'None', body.ardApprovalStatus ?? 'None', body.testRequestedOther ?? null, body.dosageFormOther ?? null],
       );
      const id = inserted.rows[0].id;

      // Insert test requested options if provided
      const testOptionIds = (body as any).testRequestedOptionIds as number[] | undefined;
      if (testOptionIds && testOptionIds.length > 0) {
        for (const optionId of testOptionIds) {
          await client.query(
            `INSERT INTO trf_test_requested (trf_id, test_requested_option_id, created_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (trf_id, test_requested_option_id) DO NOTHING`,
            [id, optionId, user.id],
          );
        }
      }

      // Insert dosage form options if provided
      const dosageOptionIds = (body as any).dosageFormOptionIds as number[] | undefined;
      if (dosageOptionIds && dosageOptionIds.length > 0) {
        for (const optionId of dosageOptionIds) {
          await client.query(
            `INSERT INTO trf_dosage_forms (trf_id, dosage_form_option_id)
             VALUES ($1, $2)
             ON CONFLICT (trf_id, dosage_form_option_id) DO NOTHING`,
            [id, optionId],
          );
        }
      }

      // ARD tracking starts automatically with status 'Received'. The ard_number
      // is generated here so it exists before the transaction commits.
      const ardNumber = await nextNumber(client, 'ARD', Number((body.trfDate as string).slice(0, 4)));
      await client.query(`UPDATE trfs SET ard_number = $2 WHERE id = $1`, [id, ardNumber]);

      await client.query(
        `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
         VALUES ($1, NULL, 'New', $2, 'TRF created')`,
        [id, user.id],
      );
      if (isArdUser) {
        await client.query(
          `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
             VALUES ($1, 'New', 'New', $2, 'TRF created by ARD user - status locked')`,
          [id, user.id],
        );
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'trf.locked', module: 'trf',
          recordType: 'TRF', recordRef: trfNumber, newValue: { lockedBy: user.fullName, reason: 'Created by ARD user' },
        });
      }
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.created', module: 'trf',
        recordType: 'TRF', recordRef: trfNumber,
        newValue: { trfNumber, priority: body.priority, customerId: body.customerId ?? null, productId: body.productId ?? null },
      });

      // Notify GMs that a new Formulation request is awaiting their approval.
      {
        const gmRows = await client.query<{ id: number }>('SELECT id FROM employees WHERE designation = $1 AND is_active = TRUE', ['GM']);
        for (const gm of gmRows.rows) {
          await notifyEmployee(client, gm.id, 'trf.awaiting_approval', 'New TRF needs your approval', `${user.fullName} created TRF ${trfNumber}.`, id);
        }
      }
      return { id, trfNumber };
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`,
      [created.id],
    );
    res.status(201).json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(trfDuplicateError(err) ?? err);
  }
});

trfsRouter.patch('/:id', requireTrfEdit(), validateBody(updateSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof updateSchema>;

    const updatedId = await withTransaction(async (client) => {
      // FOR UPDATE OF t locks the TRF row only: the joined lookup tables are shared
      // across TRFs and must never be locked here.
      const before = await client.query<TrfRow>(`SELECT ${TRF_SELECT} ${TRF_DETAIL_FROM} WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = before.rows[0];
      if (!current) throw notFound();
      if (current.deleted_at) throw notFound();
      assertNotLocked(current as unknown as { locked_at: Date | null });
      // Allow workflowStatus changes even on Completed TRFs (to move back to In Progress),
      // but block all other edits on Completed/Cancelled TRFs.
      const bodyKeys = Object.keys(body);
      const onlyWorkflowStatusChange = bodyKeys.length <= 2 && bodyKeys.every(k => k === 'workflowStatus' || k === 'version') && body.workflowStatus !== undefined;
      if ((current.status === 'Completed' || current.status === 'Cancelled') && !onlyWorkflowStatusChange) {
        throw conflict(`This TRF is ${current.status} and can no longer be edited.`);
      }

      // Formulation Approval Gate: ARD fields are locked until Formulation approves.
      // A TRF is "approved" when remarks_status = 'Approved'.
      const isApproved = current.remarks_status === 'Approved';
      const ardFieldsRequested = [...EDITABLE_ARD_ANALYST, ...EDITABLE_ARD_APPROVAL].filter((key) => body[key] !== undefined);
      if (ardFieldsRequested.length && !isApproved) {
        // Only Admin can bypass the gate (for reopen/re-edit scenarios).
        if (user.role !== 'Admin') {
          throw new AppError(409, 'ARD_LOCKED', 'ARD work opens once the Formulation team approves this TRF.');
        }
      }

      // Approving or rejecting is an administrator's decision. The team that made the request never makes it.
      if (body.remarksStatus !== undefined && body.remarksStatus !== current.remarks_status && user.role !== 'Admin') {
        throw forbidden('Only an administrator can approve or reject a TRF.');
      }

      // Prevent non-Admins from moving an Approved TRF back to Pending or Rejected.
      const nextRemarksStatus = body.remarksStatus ?? current.remarks_status;
      if (current.remarks_status === 'Approved' && nextRemarksStatus !== 'Approved' && user.role !== 'Admin') {
        throw new AppError(409, 'APPROVED_LOCKED', 'Approved TRFs can only be reopened by an Administrator.');
      }

// Split the incoming fields by part and enforce department-based access.
      const formFields = EDITABLE_FORMULATION.filter((key) => body[key] !== undefined);
      const ardAnalystFields = EDITABLE_ARD_ANALYST.filter((key) => body[key] !== undefined);
      const ardApprovalFields = EDITABLE_ARD_APPROVAL.filter((key) => body[key] !== undefined);

      if (formFields.length && !canEditTrfPartA(user)) {
        throw forbidden('You do not have formulation department access to edit these fields.');
      }
      // ARD Analyst fields: ARD department users (plus Admin/Manager) can edit
      if (ardAnalystFields.length && !canEditTrfPartB(user)) {
        throw forbidden('You do not have ARD department access to edit these fields.');
      }
      // workflowStatus: ARD users, Managers, and Admins can edit (via PATCH or /ard-status)
      const workflowStatusRequested = body.workflowStatus !== undefined;
      if (workflowStatusRequested && !canEditTrfPartB(user) && user.role !== 'Admin' && user.role !== 'Manager') {
        throw forbidden('You do not have ARD department access to edit the Final Status.');
      }
      // ARD Approval fields (reportingStatus, coaStatus, ardRemarksStatus): ARD users (via canEditTrfPartB) and Admin can edit
      const ardApprovalFieldsExceptWorkflow = ardApprovalFields.filter(key => key !== 'workflowStatus');
      if (ardApprovalFieldsExceptWorkflow.length && !canEditTrfPartB(user) && user.role !== 'Admin') {
        throw forbidden('You do not have ARD department access to edit Reporting, COA, or ARD Remarks Status.');
      }

      // After approval, Part A becomes read-only for everyone except Admin.
      if (isApproved && formFields.length && user.role !== 'Admin') {
        throw new AppError(409, 'PART_A_LOCKED', 'Approved by Formulation: Part A is locked.');
      }

      // A rejected remark must say why, whether the note is being set now or
      // was already there. A rejection with no explanation is not actionable.
      if (nextRemarksStatus === 'Rejected') {
        const nextRemarks = (body.remarks !== undefined ? body.remarks : current.remarks) as string | null | undefined;
        if (!nextRemarks?.trim()) {
          throw badRequest('A rejected remark needs a note explaining why.', {
            remarks: 'Explain why the remark is rejected.',
          });
        }
      }

      // Validate the employee references. An id that is not an active employee
      // is refused with a message on the field, not a database error.
      if (body.sampleSubmittedById !== undefined && body.sampleSubmittedById !== null) {
        const emp = await client.query('SELECT 1 FROM employees WHERE id = $1 AND is_active = TRUE', [body.sampleSubmittedById]);
        if (!emp.rowCount) throw badRequest('That employee does not exist or is not active.', {
          sampleSubmittedById: 'Select a valid employee from the list.',
        });
      }
      if (body.sampleReceivedById !== undefined && body.sampleReceivedById !== null) {
        const receiver = await client.query('SELECT 1 FROM employees WHERE id = $1 AND is_active = TRUE', [body.sampleReceivedById]);
        if (!receiver.rowCount) throw badRequest('That employee does not exist or is not active.', {
          sampleReceivedById: 'Select a valid employee from the list.',
        });
      }
      if (body.ardAnalystId !== undefined && body.ardAnalystId !== null) {
        const analyst = await client.query('SELECT 1 FROM employees WHERE id = $1 AND is_active = TRUE', [body.ardAnalystId]);
        if (!analyst.rowCount) throw badRequest('That employee does not exist or is not active.', {
          ardAnalystId: 'Select a valid employee from the list.',
        });
      }

      // Stage must be a known stage (active or inactive legacy). An unknown
      // stage is a 400 with a field message, never a 500 from the database.
      // A stage already on the row needs no validation; a new value must exist
      // in ard_stages. Only active stages are offered in the dropdown, but
      // existing legacy values remain valid so nothing is lost.
      if (body.ardStage !== undefined && body.ardStage !== null && body.ardStage !== current.ard_stage) {
        const known = await client.query('SELECT 1 FROM ard_stages WHERE name = $1', [body.ardStage]);
        if (!known.rowCount) throw badRequest('That stage is not known.', { stage: 'Choose a stage from the list.' });
      }

      // The sample cannot have been received before the request was made.
      if (body.sampleReceivedDate !== undefined && body.sampleReceivedDate !== null) {
        const storedDate: unknown = current.trf_date;
        const trfDate = body.trfDate
          ?? (typeof storedDate === 'string'
            ? storedDate.slice(0, 10)
            : storedDate instanceof Date ? storedDate.toISOString().slice(0, 10) : '');
        if (trfDate && body.sampleReceivedDate < trfDate) {
          throw badRequest('The sample received date cannot be earlier than the TRF date.', {
            sampleReceivedDate: 'The sample received date cannot be earlier than the TRF date.',
          });
        }
      }

      // ARD workflow status: setting Completed requires an Analyst Name and a
      // Date of Analysis. Moving back out of a terminal state clears
      // finalized_at so the TAT starts counting from today again.
      const workflowChanged = body.workflowStatus !== undefined && body.workflowStatus !== current.workflow_status;
      if (workflowChanged && body.workflowStatus === 'Completed') {
        const analystId = body.ardAnalystId ?? current.ard_analyst_id;
        if (!analystId) {
          throw badRequest('An analyst must be assigned before the workflow can be completed.', {
            ardAnalystId: 'Select an analyst first.',
          });
        }
        const startDate = body.analysisStartDate ?? current.analysis_start_date;
        if (!startDate) {
          throw badRequest('Analysis start date is required before the workflow can be completed.', {
            analysisStartDate: 'Set the analysis start date first.',
          });
        }
      }

      const fields = [...formFields, ...ardAnalystFields, ...ardApprovalFields];
      if (!fields.length) throw badRequest('There is nothing to update.');

      // Handle testRequestedOptionIds separately - it updates the junction table
      const hasTestRequestedOptionIds = body.testRequestedOptionIds !== undefined;
      const testRequestedOptionIds = hasTestRequestedOptionIds ? body.testRequestedOptionIds : null;

      // Build the SET clause: body fields plus any derived columns.
      // When the Final Status becomes terminal, finalized_at is stamped so the
      // TAT freezes. When it leaves a terminal state, finalized_at is cleared
      // so the TAT counts from today again.
      // Exclude testRequestedOptionIds from the regular UPDATE since it's handled separately
      const regularFields = fields.filter(key => key !== 'testRequestedOptionIds');
      const isTerminal = TERMINAL_ARD_STATUSES.includes(body.workflowStatus as ArdWorkflowStatus);
      const setClause = regularFields.map((key, i) => `${COLUMN[key]} = $${i + 1}`);
      const updateParams: unknown[] = regularFields.map((key) => normalise(body[key]));

if (workflowChanged) {
        setClause.push(`finalized_at = $${setClause.length + 1}`);
        updateParams.push(isTerminal ? new Date() : null);
        // Completing the ARD work puts it in front of an administrator for the final approval.
        // Taking it back out of Completed withdraws that request.
        if (body.workflowStatus === 'Completed') {
          setClause.push(`final_approval_status = 'Pending'`, 'final_decided_by = NULL', 'final_decided_at = NULL');
          // Also set main TRF status to Completed when ARD workflow is completed (pending final approval)
          setClause.push(`status = 'Completed'`);
        } else if (body.workflowStatus === 'Cancelled') {
          setClause.push(`status = 'Cancelled'`);
          setClause.push(`final_approval_status = 'None'`, 'final_decided_by = NULL', 'final_decided_at = NULL');
        } else if (body.workflowStatus === 'In Progress') {
          // Move New/Assigned to In Progress
          if (current.status === 'New' || current.status === 'Assigned') {
            setClause.push(`status = 'In Progress'`);
          }
          if (current.final_approval_status === 'Pending') {
            setClause.push(`final_approval_status = 'None'`);
          }
        } else if (current.final_approval_status === 'Pending') {
          setClause.push(`final_approval_status = 'None'`);
        }
      }
      // Who made the Formulation decision, and when.
      if (body.remarksStatus !== undefined && body.remarksStatus !== current.remarks_status) {
        const decided = body.remarksStatus !== 'Pending';
        setClause.push(`formulation_decided_by = $${setClause.length + 1}`);
        updateParams.push(decided ? user.id : null);
        setClause.push(`formulation_decided_at = $${setClause.length + 1}`);
        updateParams.push(decided ? new Date() : null);
      }

      const result = await client.query<{ id: number }>(
        `UPDATE trfs SET ${setClause.join(', ')},
           version = version + 1
         WHERE id = $${updateParams.length + 1} AND version = $${updateParams.length + 2}
         RETURNING id`,
        [...updateParams, id, body.version],
      );
      // Somebody else saved between the client reading the record and this save.
      if (result.rowCount === 0) throw versionConflict();

      // Update test requested options if provided
      if (hasTestRequestedOptionIds && testRequestedOptionIds !== null) {
        const optionIds = testRequestedOptionIds as number[];
        // Delete existing entries not in the new list
        await client.query(
          `DELETE FROM trf_test_requested WHERE trf_id = $1 AND test_requested_option_id NOT IN (SELECT unnest($2::int[]))`,
          [id, optionIds],
        );
        // Insert new entries
        for (const optionId of optionIds) {
          await client.query(
            `INSERT INTO trf_test_requested (trf_id, test_requested_option_id, created_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (trf_id, test_requested_option_id) DO NOTHING`,
            [id, optionId, user.id],
          );
        }
      }

      // Update dosage form options if provided
      if (body.dosageFormOptionIds !== undefined) {
        const dosageIds = body.dosageFormOptionIds;
        if (dosageIds.length > 0) {
          await client.query(
            `DELETE FROM trf_dosage_forms WHERE trf_id = $1 AND dosage_form_option_id NOT IN (SELECT unnest($2::int[]))`,
            [id, dosageIds],
          );
          for (const optionId of dosageIds) {
            await client.query(
              `INSERT INTO trf_dosage_forms (trf_id, dosage_form_option_id)
               VALUES ($1, $2)
               ON CONFLICT (trf_id, dosage_form_option_id) DO NOTHING`,
              [id, optionId],
            );
          }
        } else {
          await client.query(`DELETE FROM trf_dosage_forms WHERE trf_id = $1`, [id]);
        }
      }

      // One audit row per changed field. The comparison is against the locked row,
      // so it records what really changed.
      const auditFields = [...formFields, ...ardAnalystFields, ...ardApprovalFields];
      for (const key of auditFields) {
        const col = COLUMN[key];
        const oldRaw = (current as unknown as Record<string, unknown>)[col];
        const oldValue = oldRaw instanceof Date ? oldRaw.toISOString().slice(0, 10) : oldRaw ?? null;
        const newValue = body[key] ?? null;
        if (String(oldValue ?? '') === String(newValue ?? '')) continue;
        await writeAudit(client, {
          userId: user.id, userName: user.fullName,
          action: formFields.includes(key as (typeof EDITABLE_FORMULATION)[number]) ? 'trf.field_changed' : 'trf.ard_changed',
          module: 'trf',
          recordType: 'TRF', recordRef: current.trf_number,
          oldValue: { field: key, value: oldValue },
          newValue: { field: key, value: newValue },
});

      }

      // Every Final Status change is kept in the ARD history, whether it came
      // from this form or from the /ard-status endpoint.
      if (workflowChanged) {
        await client.query(
          `INSERT INTO ard_status_history (trf_id, old_status, new_status, changed_by, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, current.workflow_status, body.workflowStatus, user.id, body.note ?? null],
        );
        // When ARD work is completed, the final approval waits on an AGM.
        if (body.workflowStatus === 'Completed') {
          const agmRows = await client.query<{ id: number }>('SELECT id FROM employees WHERE designation = $1 AND is_active = TRUE', ['AGM']);
          for (const agm of agmRows.rows) {
            await notifyEmployee(client, agm.id, 'final_approval_needed', 'TRF ready for final approval', `${current.trf_number} is ready for final approval.`, id);
          }
        }
      }

      // Audit log for Formulation approval: when remarks_status becomes Approved.
      const remarksStatusChanged = body.remarksStatus !== undefined && body.remarksStatus !== current.remarks_status;
      if (remarksStatusChanged && body.remarksStatus === 'Approved') {
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'trf.approved', module: 'trf',
          recordType: 'TRF', recordRef: current.trf_number,
          oldValue: { remarksStatus: current.remarks_status },
          newValue: { remarksStatus: 'Approved', note: body.remarks ?? null },
        });
        // Notify the TRF creator that their request was approved and ARD can begin.
        if (current.created_by && current.created_by !== user.id) {
          await notifyEmployee(client, current.created_by, 'formulation_approved', 'Your TRF is approved', `${user.fullName} approved TRF ${current.trf_number}. ARD work can begin.`, id);
        }
        // Notify the ARD team that a new TRF is ready for analysis.
        const ardEmployees = await client.query<{ id: number }>(
          `SELECT e.id FROM employees e
           INNER JOIN departments d ON d.id = e.department_id
           WHERE d.name = 'ARD' AND e.is_active = TRUE`
        );
        for (const ard of ardEmployees.rows) {
          await notifyEmployee(client, ard.id, 'ard_work_ready', 'TRF ready for ARD analysis', `TRF ${current.trf_number} has been approved. ARD work can now begin.`, id);
        }
      }
      return id;
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`,
      [updatedId],
    );
    res.json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(err);
  }
});

trfsRouter.post('/:id/assign', requireTrfEdit(), validateBody(assignSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof assignSchema>;

    const updatedId = await withTransaction(async (client) => {
      const locked = await client.query<{ id: number; version: number; trf_number: string; assigned_employee_id: number | null; locked_at: Date | null; status: TrfStatus }>(
        `SELECT id, version, trf_number, assigned_employee_id, locked_at, status FROM trfs WHERE id = $1 FOR UPDATE`, [id],
      );
      const current = locked.rows[0];
      if (!current) throw notFound();
      assertNotLocked(current);
      if (current.version !== body.version) throw versionConflict();

      // Block assignment on Completed/Cancelled TRFs
      if (current.status === 'Completed' || current.status === 'Cancelled') {
        throw conflict(`This TRF is ${current.status} and can no longer be assigned.`);
      }

      const newAssignedEmployeeId = body.assignedEmployeeId ?? null;
      const oldAssignedEmployeeId = current.assigned_employee_id;

      if (newAssignedEmployeeId !== null) {
        // Verify the employee exists and is active
        const emp = await client.query<{ full_name: string; is_active: boolean; role: string }>(
          `SELECT full_name, is_active, role FROM employees WHERE id = $1`, [newAssignedEmployeeId],
        );
        if (!emp.rows[0]) throw badRequest('That employee does not exist.', { assignedEmployeeId: 'Select an employee from the list.' });
        if (!emp.rows[0].is_active) throw badRequest('That employee is not active.', { assignedEmployeeId: 'An inactive employee cannot be assigned work.' });
        if (emp.rows[0].role === 'Viewer') throw badRequest('A Viewer cannot be assigned a TRF.', { assignedEmployeeId: 'Choose an Analyst, Manager, or Admin.' });
      }

      await client.query(
        `UPDATE trfs SET assigned_employee_id = $2, version = version + 1 WHERE id = $1 AND version = $3 RETURNING id`,
        [id, newAssignedEmployeeId, body.version],
      );

      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.assigned', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { assignedEmployee: oldAssignedEmployeeId },
        newValue: { assignedEmployee: newAssignedEmployeeId, note: body.note ?? null },
      });

      return id;
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`,
      [updatedId],
    );
    res.json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(err);
  }
});

trfsRouter.post('/:id/status', requirePermission('trf.changeStatus'), validateBody(statusSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof statusSchema>;

    const result = await withTransaction(async (client) => {
      // FOR UPDATE makes the check and the update one atomic step: two managers
      // pressing the same button cannot both pass the transition test.
      const locked = await client.query<{ status: TrfStatus; version: number; trf_number: string; locked_at: Date | null }>(
        `SELECT status, version, trf_number, locked_at FROM trfs WHERE id = $1 FOR UPDATE`, [id],
      );
      const current = locked.rows[0];
      if (!current) throw notFound();
      assertNotLocked(current);

      if (current.version !== body.version) throw versionConflict();
      if (!canTransitionTrf(current.status, body.status)) {
        const allowed = TRF_STATUS_TRANSITIONS[current.status];
        throw conflict(allowed.length
          ? `A TRF that is ${current.status} can only change to: ${allowed.join(', ')}.`
          : `A TRF that is ${current.status} cannot change status any further.`);
      }
      if ((body.status === 'Completed' || body.status === 'Cancelled') && user.role !== 'Admin' && user.role !== 'Manager') {
        throw new AppError(403, 'FORBIDDEN', MESSAGES.NO_PERMISSION);
      }

      const updated = await client.query<{ id: number }>(
        `UPDATE trfs SET status = $2, version = version + 1 WHERE id = $1 AND version = $3 RETURNING id`,
        [id, body.status, body.version],
      );
      if (updated.rowCount === 0) throw versionConflict();

      await client.query(
        `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, current.status, body.status, user.id, body.note ?? null],
      );
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.status_changed', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { status: current.status }, newValue: { status: body.status, note: body.note ?? null },
      });
      return id;
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`,
      [result],
    );
    res.json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(err);
  }
});

trfsRouter.delete('/:id', requireTrfDelete(), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    const result = await withTransaction(async (client) => {
      const locked = await client.query<{
        status: TrfStatus; version: number; trf_number: string; deleted_at: Date | null;
        created_by: number | null; assigned_employee_id: number | null; locked_at: Date | null;
       }>(`SELECT status, version, trf_number, deleted_at, created_by, assigned_employee_id, locked_at FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = locked.rows[0];
      if (!current || current.deleted_at) throw notFound();
      assertNotLocked(current);

      // Check for dependent work before refusing. The status check is a fast
      // proxy, but the explicit count gives a precise message.
      const deps = await client.query<{ has_deps: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM analysis_tests WHERE trf_id = $1
            UNION
            SELECT 1 FROM coas WHERE trf_id = $1
          ) AS has_deps`,
        [id],
      );
      if (deps.rows[0].has_deps) {
        throw conflict('This TRF has analysis tests or certificates and cannot be deleted. Cancel or complete the dependent work first.');
      }

      // Only TRFs that are still "New" can be deleted; anything else has
      // dependent work (assignments, COAs) that must not be orphaned.
      if (current.status !== 'New') {
        throw conflict(`This TRF is ${current.status} and cannot be deleted. Only TRFs in "New" status can be deleted.`);
      }

      // Non-admins cannot delete Approved TRFs.
      const trfDetails = await client.query<{ remarks_status: string }>(
        `SELECT remarks_status FROM trfs WHERE id = $1`, [id]);
      const isApproved = trfDetails.rows[0]?.remarks_status === 'Approved';
      if (isApproved && user.role !== 'Admin') {
        throw new AppError(409, 'APPROVED_LOCKED', 'Approved TRFs can only be deleted by an Administrator.');
      }

      // Non-admins can only delete their own TRFs.
      if (user.role !== 'Admin' && current.created_by !== user.id) {
        throw forbidden('You can only delete TRFs you created.');
      }

      await client.query(
        `UPDATE trfs SET deleted_at = now(), deleted_by = $2, version = version + 1 WHERE id = $1 AND version = $3`,
        [id, user.id, current.version],
      );
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.deleted', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { status: current.status },
        newValue: { deletedBy: user.fullName, deletedAt: new Date().toISOString() },
      });
      return current.trf_number;
    });

    res.json({ trfNumber: result });
  } catch (err) {
    next(err);
  }
});

/**
 * ARD Final Status transition. ARD users, Managers, and Admins may drive it.
 * The route changes the Final Status only. The Stage is a separate dropdown
 * with its own column and is not touched here. Terminal states stamp
 * finalized_at so the TAT freezes at that date; leaving a terminal state
 * clears it again so the TAT counts from today.
 */
trfsRouter.post('/:id/ard-status', requireArdEdit(), validateBody(ardStatusSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof ardStatusSchema>;

    const result = await withTransaction(async (client) => {
      const locked = await client.query<{
        workflow_status: ArdWorkflowStatus; ard_stage: string; version: number;
        ard_analyst_id: number | null; analysis_start_date: string | null;
        ard_number: string | null; trf_number: string;
        remarks_status: string; locked_at: Date | null; final_approval_status: string;
        status: string;
      }>(`SELECT workflow_status, ard_stage, version, ard_analyst_id, analysis_start_date,
                   ard_number, t.trf_number, t.remarks_status, t.locked_at, t.final_approval_status, t.status
             FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = locked.rows[0];
      if (!current) throw notFound();
      assertNotLocked(current);
      if (current.version !== body.version) throw versionConflict();

      // Formulation Approval Gate: ARD workflow status changes are locked until Formulation approves.
      const isApproved = current.remarks_status === 'Approved';
      if (!isApproved && user.role !== 'Admin') {
        throw new AppError(409, 'ARD_LOCKED', 'ARD work opens once the Formulation team approves this TRF.');
      }

      // Completed needs an Analyst Name and a Date of Analysis, and the error
      // says which field is missing.
      if (body.status === 'Completed') {
        if (!current.ard_analyst_id) {
          throw badRequest('An analyst must be assigned before the workflow can be completed.', {
            ardAnalystId: 'Select an analyst first.',
          });
        }
        if (!current.analysis_start_date) {
          throw badRequest('Analysis start date is required before the workflow can be completed.', {
            analysisStartDate: 'Set the analysis start date first.',
          });
        }
      }

      const isTerminal = TERMINAL_ARD_STATUSES.includes(body.status);
      const finalizedAt = isTerminal ? new Date() : null;

      // Determine the new main TRF status based on ARD workflow status
      let newTrfStatus = current.status;
      if (body.status === 'Completed') {
        newTrfStatus = 'Completed';
      } else if (body.status === 'Cancelled') {
        newTrfStatus = 'Cancelled';
      } else if (body.status === 'In Progress' && (current.status === 'New' || current.status === 'Assigned')) {
        newTrfStatus = 'In Progress';
      }

      const updateResult = await client.query(
        `UPDATE trfs SET workflow_status = $2,
           finalized_at = $3::timestamp,
           final_approval_status = CASE WHEN $2 = 'Completed' THEN 'Pending'
                                        WHEN final_approval_status = 'Pending' THEN 'None'
                                        ELSE final_approval_status END,
           final_decided_by = CASE WHEN $2 = 'Completed' THEN NULL ELSE final_decided_by END,
           final_decided_at = CASE WHEN $2 = 'Completed' THEN NULL ELSE final_decided_at END,
           status = $5,
           version = version + 1
         WHERE id = $1 AND version = $4`,
        [id, body.status, finalizedAt, body.version, newTrfStatus],
      );
      if (updateResult.rowCount === 0) throw versionConflict();

      await client.query(
        `INSERT INTO ard_status_history (trf_id, old_status, new_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, current.workflow_status, body.status, user.id, body.note ?? null],
      );

      // If main TRF status changed, record in trf_status_history
      if (newTrfStatus !== current.status) {
        await client.query(
          `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, current.status, newTrfStatus, user.id, `ARD workflow status changed to ${body.status}`],
        );
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'trf.status_changed', module: 'trf',
          recordType: 'TRF', recordRef: current.trf_number,
          oldValue: { status: current.status }, newValue: { status: newTrfStatus, reason: `ARD workflow status changed to ${body.status}` },
        });
      }

      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.ard_status_changed', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { ardStatus: current.workflow_status, stage: current.ard_stage },
        newValue: { ardStatus: body.status, stage: current.ard_stage, note: body.note ?? null },
      });
      // When ARD work is completed via Final Status, notify all Admins for final approval
      if (body.status === 'Completed') {
        const adminRows = await client.query<{ id: number }>('SELECT id FROM employees WHERE role = $1 AND is_active = TRUE', ['Admin']);
        for (const admin of adminRows.rows) {
          await notifyEmployee(client, admin.id, 'final_approval_needed', 'TRF ready for final approval', `${current.trf_number} is ready for final approval.`, id);
        }
      }
      return id;
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`,
      [result],
    );
    res.json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(err);
  }
});

/**
 * Admin-only "Reopen Formulation" action.
 * Sets remarks_status back to Pending, unlocks Part A, keeps all ARD data,
 * and locks ARD again until re-approved.
 * Requires a reason (min 10 characters). Writes audit rows for trf.reopened.
 */
const reopenSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(10, 'The reason must be at least 10 characters.'),
});

trfsRouter.post('/:id/reopen', requireLockAdmin(), validateBody(reopenSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof reopenSchema>;

    const result = await withTransaction(async (client) => {
      const locked = await client.query<{
        version: number; trf_number: string; remarks_status: string;
        ard_analyst_id: number | null; analysis_start_date: string | null;
        ard_stage: string; workflow_status: ArdWorkflowStatus;
        ard_remarks: string | null; ard_remarks_status: string;
      }>(`SELECT version, trf_number, remarks_status, ard_analyst_id, analysis_start_date,
                   ard_stage, workflow_status, ard_remarks, ard_remarks_status
            FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = locked.rows[0];
      if (!current) throw notFound();
      if (current.version !== body.version) throw versionConflict();
      if (current.remarks_status !== 'Approved') {
        throw conflict('Only Approved TRFs can be reopened.');
      }

      // Store previous ARD data for audit
      const previousArdData = {
        ardAnalystId: current.ard_analyst_id,
        analysisStartDate: current.analysis_start_date,
        ardStage: current.ard_stage,
        workflowStatus: current.workflow_status,
        ardRemarks: current.ard_remarks,
        ardRemarksStatus: current.ard_remarks_status,
      };

      // Set remarks_status back to Pending
      await client.query(
        `UPDATE trfs SET remarks_status = 'Pending', formulation_decided_by = NULL, formulation_decided_at = NULL,
                final_approval_status = 'None', final_decided_by = NULL, final_decided_at = NULL,
                locked_at = NULL, locked_by = NULL, version = version + 1 WHERE id = $1`,
        [id],
      );

      // Audit log for reopen
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.reopened', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { remarksStatus: 'Approved', ardData: previousArdData },
        newValue: { remarksStatus: 'Pending', reason: body.reason },
      });

      return id;
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`,
      [result],
    );
    res.json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(err);
  }
});


/**
 * The administrator's decision on a TRF, for either approval:
 *  - FORMULATION: the Formulation request. Approving it opens the ARD block.
 *  - ARD: the final approval once ARD marks the work Completed. Approving it locks the TRF.
 * A rejection needs a reason. Every decision is kept in trf_approvals and in the audit trail
 * under the administrator's own name.
 */
const decisionSchema = z.object({
  track: z.enum(['FORMULATION', 'ARD']),
  decision: z.enum(['Approved', 'Rejected']),
  version: z.number().int().positive(),
  reason: z.string().trim().max(1000).nullable().optional(),
});

trfsRouter.post('/:id/decision', requireAnyApprover(), validateBody(decisionSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof decisionSchema>;
    if (body.decision === 'Rejected' && !body.reason?.trim()) {
      throw badRequest(MESSAGES.APPROVAL_REASON_REQUIRED, { reason: MESSAGES.APPROVAL_REASON_REQUIRED });
    }

    // Track-based approval: AGM may only approve/reject ARD, not FORMULATION.
    // GM and Admin may approve either track.
    if (body.track === 'FORMULATION' && admin.role === 'AGM') {
      throw forbidden('Only an Admin or GM can approve or reject a Formulation request.');
    }

    await withTransaction(async (client) => {
      const locked = await client.query<{
        version: number; trf_number: string; remarks_status: string; final_approval_status: string;
        workflow_status: string; locked_at: Date | null; created_by: number | null; ard_analyst_id: number | null; deleted_at: Date | null;
        status: string;
      }>(`SELECT version, trf_number, remarks_status, final_approval_status, workflow_status, locked_at,
                   created_by, ard_analyst_id, deleted_at, status
             FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = locked.rows[0];
      if (!current || current.deleted_at) throw notFound();
      if (current.version !== body.version) throw versionConflict();
      assertNotLocked(current);

      if (body.track === 'FORMULATION') {
        if (current.remarks_status === body.decision) throw conflict(MESSAGES.APPROVAL_ALREADY_DECIDED);
        await client.query(
          `UPDATE trfs SET remarks_status = $2, formulation_decided_by = $3, formulation_decided_at = now(),
                  version = version + 1 WHERE id = $1`,
          [id, body.decision, admin.id]);
      } else {
        if (current.final_approval_status !== 'Pending') {
          throw conflict('There is no final approval waiting on this TRF. ARD must mark the work Completed first.');
        }
        if (body.decision === 'Approved') {
          // Approve and lock: set main TRF status to Completed
          await client.query(
            `UPDATE trfs SET final_approval_status = 'Approved', final_decided_by = $2, final_decided_at = now(),
                    locked_at = now(), locked_by = $2, status = 'Completed', version = version + 1 WHERE id = $1`,
            [id, admin.id]);
          // Record status change to Completed
          await client.query(
            `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
             VALUES ($1, $2, 'Completed', $3, $4)`,
            [id, current.status, admin.id, `Final approval approved by ${admin.fullName}`],
          );
          await writeAudit(client, {
            userId: admin.id, userName: admin.fullName, action: 'trf.status_changed', module: 'trf',
            recordType: 'TRF', recordRef: current.trf_number,
            oldValue: { status: current.status }, newValue: { status: 'Completed', reason: 'Final approval approved' },
          });
        } else {
          // Sent back: ARD carries on working and completes again when it is ready.
          // Revert main TRF status to In Progress
          await client.query(
            `UPDATE trfs SET final_approval_status = 'Rejected', final_decided_by = $2, final_decided_at = now(),
                    workflow_status = 'In Progress', finalized_at = NULL, status = 'In Progress', version = version + 1 WHERE id = $1`,
            [id, admin.id]);
          await client.query(
            `INSERT INTO ard_status_history (trf_id, old_status, new_status, changed_by, note) VALUES ($1, $2, 'In Progress', $3, $4)`,
            [id, current.workflow_status, admin.id, `Final approval rejected: ${body.reason}`],
          );
          // Record status change to In Progress
          await client.query(
            `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
             VALUES ($1, $2, 'In Progress', $3, $4)`,
            [id, current.status, admin.id, `Final approval rejected: ${body.reason}`],
          );
          await writeAudit(client, {
            userId: admin.id, userName: admin.fullName, action: 'trf.status_changed', module: 'trf',
            recordType: 'TRF', recordRef: current.trf_number,
            oldValue: { status: current.status }, newValue: { status: 'In Progress', reason: `Final approval rejected: ${body.reason}` },
          });
        }
      }

      await client.query(
        `INSERT INTO trf_approvals (trf_id, track, status, requested_by_employee_id, decided_by, decided_at, reason, decided_by_account_id)
         VALUES ($1, $2, $3, $4, $5, now(), $6, NULL)`,
        [id, body.track, body.decision, (body.track === 'FORMULATION' ? current.created_by : current.ard_analyst_id) ?? admin.id,
         admin.id, body.reason ?? null]);

      const action = body.track === 'FORMULATION'
        ? (body.decision === 'Approved' ? 'trf.approved' : 'trf.rejected')
        : (body.decision === 'Approved' ? 'trf.final_approved' : 'trf.final_rejected');
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action, module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: body.track === 'FORMULATION' ? { remarksStatus: current.remarks_status } : { finalApprovalStatus: current.final_approval_status },
        newValue: { decision: body.decision, track: body.track, reason: body.reason ?? null },
      });
      if (body.track === 'ARD' && body.decision === 'Approved') {
        await writeAudit(client, {
          userId: admin.id, userName: admin.fullName, action: 'trf.locked', module: 'trf',
          recordType: 'TRF', recordRef: current.trf_number, newValue: { lockedBy: admin.fullName },
        });
      }

      // Notify the TRF creator about the decision.
      const creatorId = body.track === 'FORMULATION' ? current.created_by : current.ard_analyst_id;
      if (creatorId && creatorId !== admin.id) {
        const verb = body.decision === 'Approved' ? 'approved' : 'rejected';
        await notifyEmployee(
          client, creatorId,
          body.track === 'FORMULATION' ? 'formulation_decision' : 'final_decision',
          `Your TRF was ${verb}`,
          `${admin.fullName} ${verb} TRF ${current.trf_number}.`,
          id,
        );
      }
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`, [id]);
    res.json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(err);
  }
});

/**
 * Unlocks an approved TRF. Only an administrator can, and only with a stated reason, which is
 * kept in the audit trail. ARD work reopens at In Progress and needs a fresh final approval.
 */
const unlockSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(10, 'The reason must be at least 10 characters.'),
});

trfsRouter.post('/:id/unlock', requireLockAdmin(), validateBody(unlockSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof unlockSchema>;

    await withTransaction(async (client) => {
      const locked = await client.query<{ version: number; trf_number: string; locked_at: Date | null; workflow_status: string; deleted_at: Date | null }>(
        `SELECT version, trf_number, locked_at, workflow_status, deleted_at FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = locked.rows[0];
      if (!current || current.deleted_at) throw notFound();
      if (current.version !== body.version) throw versionConflict();
      if (!current.locked_at) throw conflict('This TRF is not locked.');

      await client.query(
        `UPDATE trfs SET locked_at = NULL, locked_by = NULL, final_approval_status = 'None',
                final_decided_by = NULL, final_decided_at = NULL, workflow_status = 'In Progress', finalized_at = NULL,
                status = 'In Progress', version = version + 1 WHERE id = $1`, [id]);
      await client.query(
        `INSERT INTO ard_status_history (trf_id, old_status, new_status, changed_by, note) VALUES ($1, $2, 'In Progress', $3, $4)`,
        [id, current.workflow_status, admin.id, `Unlocked: ${body.reason}`]);
      // Record status change to In Progress
      await client.query(
        `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
         VALUES ($1, $2, 'In Progress', $3, $4)`,
        [id, 'Completed', admin.id, `Unlocked: ${body.reason}`],
      );
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'trf.status_changed', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { status: 'Completed' }, newValue: { status: 'In Progress', reason: `Unlocked: ${body.reason}` },
      });
      await client.query(
        `INSERT INTO trf_approvals (trf_id, track, status, requested_by_employee_id, decided_by, decided_at, reason)
         VALUES ($1, 'ARD', 'Reopened', $2, $2, now(), $3)`, [id, admin.id, body.reason]);
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'trf.unlocked', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { lockedAt: current.locked_at }, newValue: { reason: body.reason },
      });
    });

    const detail = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_DETAIL_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} WHERE t.id = $1`, [id]);
    res.json(toDetail(detail.rows[0], detail.rows[0].is_overdue));
  } catch (err) {
    next(err);
  }
});

/** The approval history of a TRF: every request, decision, rejection and unlock, with who and why. */
trfsRouter.get('/:id/approvals', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const result = await pool.query<{ id: string; track: string; status: string; decided_at: Date | null; reason: string | null; decided_by_name: string | null }>(
      `SELECT a.id, a.track, a.status, a.decided_at, a.reason, d.full_name AS decided_by_name
         FROM trf_approvals a LEFT JOIN employees d ON d.id = a.decided_by
        WHERE a.trf_id = $1 ORDER BY a.id DESC`, [id]);
    res.json({ items: result.rows.map((r) => ({
      id: Number(r.id), track: r.track, status: r.status, reason: r.reason,
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null, decidedByName: r.decided_by_name,
    })) });
  } catch (err) {
    next(err);
  }
});

/** ARD workflow status history for the detail screen's timeline. */
trfsRouter.get('/:id/ard-history', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    await loadVisibleTrf(id, currentEmployee(req));

    const result = await pool.query<{
      id: number; old_status: ArdWorkflowStatus | null; new_status: ArdWorkflowStatus;
      changed_by_name: string | null; changed_at: Date; note: string | null;
    }>(
      `SELECT h.id, h.old_status, h.new_status, e.full_name AS changed_by_name, h.changed_at, h.note
       FROM ard_status_history h LEFT JOIN employees e ON e.id = h.changed_by
       WHERE h.trf_id = $1 ORDER BY h.changed_at DESC, h.id DESC`,
      [id],
    );
    const items: ArdStatusHistoryEntry[] = result.rows.map((r) => ({
      id: r.id, oldStatus: r.old_status, newStatus: r.new_status,
      changedByName: r.changed_by_name, changedAt: new Date(r.changed_at).toISOString(), note: r.note,
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const printLogSchema = z.object({
  printedBy: z.string().trim().min(1).max(200),
});

trfsRouter.post('/:id/print-log', requirePermission('trf.view'), validateBody(printLogSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    const trf = await pool.query<{ trf_number: string }>('SELECT trf_number FROM trfs WHERE id = $1', [id]);
    if (!trf.rows[0]) throw notFound();

    const body = req.body as z.infer<typeof printLogSchema>;
    await withTransaction(async (client) => {
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.printed', module: 'trf',
        recordType: 'TRF', recordRef: trf.rows[0].trf_number,
        newValue: { printedBy: body.printedBy, printedAt: new Date().toISOString() },
      });
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Get the generated PDF document for a TRF.
 */
trfsRouter.get('/:id/document', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    const doc = await pool.query<{
      id: number; trf_id: number; file_path: string; file_name: string; file_size: number | null;
      mime_type: string; version: number; generated_by: number | null; generated_at: string;
      status: string; error_message: string | null;
    }>(
      `SELECT * FROM trf_documents WHERE trf_id = $1 ORDER BY generated_at DESC LIMIT 1`,
      [id]
    );

    if (!doc.rows[0]) {
      throw notFound();
    }

    res.json(doc.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * Download the generated PDF for a TRF.
 */
trfsRouter.get('/:id/document/download', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    const doc = await pool.query<{ file_path: string; file_name: string; mime_type: string }>(
      `SELECT file_path, file_name, mime_type FROM trf_documents WHERE trf_id = $1 ORDER BY generated_at DESC LIMIT 1`,
      [id]
    );

    if (!doc.rows[0]) {
      throw notFound();
    }

    const filePath = doc.rows[0].file_path;
    const fileName = doc.rows[0].file_name;
    const mimeType = doc.rows[0].mime_type;

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw notFound();
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

/**
 * Record PDF generation from Electron client.
 * Called by the desktop app after generating PDF via Electron's printToPDF.
 */
const pdfGeneratedSchema = z.object({
  fileName: z.string().min(1),
  filePath: z.string().min(1),
  fileSize: z.number().int().positive(),
});

trfsRouter.post('/:id/pdf-generated', requirePermission('trf.view'), validateBody(pdfGeneratedSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof pdfGeneratedSchema>;

    const trf = await pool.query<{ version: number; trf_number: string }>(
      `SELECT version, trf_number FROM trfs WHERE id = $1`, [id]);
    if (!trf.rows[0]) throw notFound();

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO trf_documents (trf_id, file_path, file_name, file_size, mime_type, version, generated_by, status)
         VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, 'generated')
         ON CONFLICT (trf_id, version) WHERE status IN ('generated', 'regenerated')
         DO UPDATE SET file_path = $2, file_name = $3, file_size = $4, mime_type = 'application/pdf', generated_by = $5, generated_at = NOW(), status = 'generated', error_message = NULL`,
        [id, body.filePath, body.fileName, body.fileSize, trf.rows[0].version, user.id]
      );

      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.pdf_generated', module: 'trf',
        recordType: 'TRF', recordRef: trf.rows[0].trf_number,
        newValue: { fileName: body.fileName, fileSize: body.fileSize },
      });
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export { trfsRouter };
