import { Router } from 'express';
import { z } from 'zod';
import type { EmployeeProfile, TrfListPage, TrfStatus, TrfStatusHistoryEntry, ArdStatusHistoryEntry } from '@trf/shared';
import {
   MESSAGES, PRIORITIES, TRF_STATUS_TRANSITIONS, canTransitionTrf,
   TERMINAL_ARD_STATUSES, roleHasPermission, canEditTrfPartA, canEditTrfPartB,
   ArdWorkflowStatus, ArdRemarksStatus, ARD_REMARKS_STATUSES,
} from '@trf/shared';
import { pool, withTransaction } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound, versionConflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { nextNumber, trfDuplicateError } from '../lib/numbers';
import {
  OVERDUE_SQL, ARD_TAT_SQL, TRF_DETAIL_FROM, TRF_DETAIL_SELECT, TRF_FROM, TRF_SELECT, TRF_SORT_SQL,
  TrfRow, toDetail, toListItem, trfListQuerySchema, toFilters,
} from '../lib/trf-query';
import { authenticate, currentEmployee, requirePermission, requireTrfCreate, requireTrfEdit, requireArdEdit, requireTrfDelete, validateBody } from '../middleware/auth';

export const trfsRouter = Router();
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
    remarksStatus: z.enum(['Pending', 'Approved', 'Rejected']).optional(),
    sampleReceivedBy: z.number().int().positive().nullable().optional(),
    ardRemarksStatus: z.enum(ARD_REMARKS_STATUSES).optional(),
});

const updateSchema = createSchema.partial().extend({
  version: z.number().int().positive(),
  // The ARD block: Stage, Analyst Name, Date of Analysis, Reporting, COA,
  // the ARD remark Status and note, and the Final Status.
  ardAnalystId: z.number().int().positive().nullable().optional(),
  analysisStartDate: ISO_DATE.nullable().optional(),
  reportingStatus: z.enum(['Pending', 'Draft', 'Submitted', 'Reviewed', 'Approved', 'Rejected']).optional(),
  coaStatus: z.enum(['Pending', 'Draft', 'Under Review', 'Approved', 'Issued']).optional(),
  workflowStatus: z.enum(ArdWorkflowStatus).optional(),
  ardStage: z.string().trim().min(1, 'Enter a stage.').max(60, 'The stage must be at most 60 characters.').optional(),
  ardRemarks: z.string().trim().max(2000).nullable().optional(),
  ardRemarksStatus: z.enum(ARD_REMARKS_STATUSES).optional(),
  remarksStatus: z.enum(['Pending', 'Approved', 'Rejected']).optional(),
  sampleReceivedBy: z.number().int().positive().nullable().optional(),
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
  assignedEmployeeId: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
  note: z.string().trim().max(500).nullable().optional(),
});

interface Scope { employeeId: number }

/** Roles without trf.viewAll only ever see their own TRFs, applied inside the query. */
function scopeFor(employee: EmployeeProfile): Scope | null {
  return roleHasPermission(employee.role, 'trf.viewAll') ? null : { employeeId: employee.id };
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
  'priority', 'sampleReceivedBy', 'sampleReceivedDate', 'remarksStatus',
] as const;

/**
 * ARD block fields that only the ARD team may edit via PATCH. This is exactly
 * the ARD block items 2, 5, 6, 7, 8, 9 and 11. Items 1 (A.R. No.), 3 and 4
 * (the carried-forward test details) and 10 (TAT) are read-only for everybody,
 * so they are not listed here and can never be written.
 */
const EDITABLE_ARD = [
  'ardAnalystId', 'analysisStartDate', 'reportingStatus',
  'coaStatus', 'ardRemarks', 'ardRemarksStatus', 'workflowStatus',
  'ardStage',
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
   sampleReceivedBy: 'sample_received_by',
   sampleReceivedDate: 'sample_received_date',
   ardRemarksStatus: 'ard_remarks_status',
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
    clauses.push(`(t.assigned_employee_id = $${params.length} OR t.created_by = $${params.length})`);
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

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

trfsRouter.get('/', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const filters = toFilters(trfListQuerySchema.parse(req.query));
    const params: unknown[] = [];
    const whereSql = buildWhere(filters, params, scopeFor(currentEmployee(req)));

    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
        FROM trfs t
        LEFT JOIN customers c ON c.id = t.customer_id
        LEFT JOIN products p ON p.id = t.product_id
        LEFT JOIN employees e ON e.id = t.assigned_employee_id
        LEFT JOIN employees an ON an.id = t.ard_analyst_id
        LEFT JOIN employees ssb ON ssb.id = t.sample_submitted_by_id ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0].count);

    const sortColumn = TRF_SORT_SQL[filters.sortBy];
    const dir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
    // Overdue is selected as a column and filtered on in SQL, never in the client.
     const rows = await pool.query<TrfRow & { is_overdue: boolean }>(
       `SELECT ${TRF_SELECT}, (${ARD_TAT_SQL}) AS tat, (${OVERDUE_SQL}) AS is_overdue ${TRF_DETAIL_FROM} ${whereSql}
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
  if (!roleHasPermission(employee.role, 'trf.viewAll')
    && row.assigned_employee_id !== employee.id && row.created_by !== employee.id) {
    throw forbidden();
  }
  return row;
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
     // A rejected remark must say why. A rejection with no explanation is not
     // actionable, so it is refused with a message on the note field.
     if (body.remarksStatus === 'Rejected' && !body.remarks?.trim()) {
       throw badRequest('A rejected remark needs a note explaining why.', {
         remarks: 'Explain why the remark is rejected.',
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


    const created = await withTransaction(async (client) => {
      const trfNumber = await nextNumber(client, 'TRF', Number(body.trfDate.slice(0, 4)));
      const inserted = await client.query<{ id: number }>(
         `INSERT INTO trfs (trf_number, trf_date, customer_id, product_id, batch_number, sample_quantity,
             sample_received_date, required_completion_date, priority, requested_analysis,
             special_instructions, department_id, remarks, batch_size, dosage_form,
             manufacturing_location, label_claim, pack_size, pack_type, storage_condition,
             storage_period, manufacturing_date, expiry_date, analysis_purpose,
             sample_given_by, sample_submitted_by_id, signature_date, created_by, remarks_status, ard_remarks_status, sample_received_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
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
           body.remarksStatus ?? 'Pending', body.ardRemarksStatus ?? 'Pending', body.sampleReceivedBy ?? null],
      );
      const id = inserted.rows[0].id;

      // ARD tracking starts automatically with status 'Received'. The ard_number
      // is generated here so it exists before the transaction commits.
      const ardNumber = await nextNumber(client, 'ARD', Number(body.trfDate.slice(0, 4)));
      await client.query(`UPDATE trfs SET ard_number = $2 WHERE id = $1`, [id, ardNumber]);

      await client.query(
        `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
         VALUES ($1, NULL, 'New', $2, 'TRF created')`,
        [id, user.id],
      );
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.created', module: 'trf',
        recordType: 'TRF', recordRef: trfNumber,
        newValue: { trfNumber, priority: body.priority, customerId: body.customerId ?? null, productId: body.productId ?? null },
      });
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
      if (current.status === 'Completed' || current.status === 'Cancelled') {
        throw conflict(`This TRF is ${current.status} and can no longer be edited.`);
      }

      // Split the incoming fields by part and enforce department-based access.
      const formFields = EDITABLE_FORMULATION.filter((key) => body[key] !== undefined);
      const ardFields = EDITABLE_ARD.filter((key) => body[key] !== undefined);

      if (formFields.length && !canEditTrfPartA(user)) {
        throw forbidden('You do not have formulation department access to edit these fields.');
      }
      if (ardFields.length && !canEditTrfPartB(user)) {
        throw forbidden('You do not have ARD department access to edit these fields.');
      }

      // A rejected remark must say why, whether the note is being set now or
      // was already there. A rejection with no explanation is not actionable.
      const nextRemarksStatus = body.remarksStatus ?? current.remarks_status;
      if (nextRemarksStatus === 'Rejected') {
        const nextRemarks = body.remarks !== undefined ? body.remarks : current.remarks;
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

      const fields = [...formFields, ...ardFields];
      if (!fields.length) throw badRequest('There is nothing to update.');

      // Build the SET clause: body fields plus any derived columns.
      // When the Final Status becomes terminal, finalized_at is stamped so the
      // TAT freezes. When it leaves a terminal state, finalized_at is cleared
      // so the TAT counts from today again.
      const isTerminal = TERMINAL_ARD_STATUSES.includes(body.workflowStatus as ArdWorkflowStatus);
      const setClause = fields.map((key, i) => `${COLUMN[key]} = $${i + 1}`);
      const updateParams: unknown[] = fields.map((key) => normalise(body[key]));

      if (workflowChanged) {
        setClause.push(`finalized_at = $${setClause.length + 1}`);
        updateParams.push(isTerminal ? new Date() : null);
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

      // One audit row per changed field. The comparison is against the locked row,
      // so it records what really changed.
      const auditFields = [...formFields, ...ardFields];
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

trfsRouter.post('/:id/status', requirePermission('trf.changeStatus'), validateBody(statusSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof statusSchema>;

    const result = await withTransaction(async (client) => {
      // FOR UPDATE makes the check and the update one atomic step: two managers
      // pressing the same button cannot both pass the transition test.
      const locked = await client.query<{ status: TrfStatus; version: number; trf_number: string }>(
        `SELECT status, version, trf_number FROM trfs WHERE id = $1 FOR UPDATE`, [id],
      );
      const current = locked.rows[0];
      if (!current) throw notFound();

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
        created_by: number | null; assigned_employee_id: number | null;
       }>(`SELECT status, version, trf_number, deleted_at, created_by, assigned_employee_id FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = locked.rows[0];
      if (!current || current.deleted_at) throw notFound();

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
 * ARD Final Status transition. Only ARD department users (plus Admin and
 * Manager) may drive it: the route never asks for the trf.changeStatus
 * permission, so an ARD Analyst can set the Final Status of a TRF.
 *
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
      }>(`SELECT workflow_status, ard_stage, version, ard_analyst_id, analysis_start_date,
                 ard_number, t.trf_number FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = locked.rows[0];
      if (!current) throw notFound();
      if (current.version !== body.version) throw versionConflict();

      // Completed needs an Analyst Name and a Date of Analysis, and the error
      // says which field is missing.
      if (body.status === 'Completed') {        if (!current.ard_analyst_id) {
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

      await client.query(
        `UPDATE trfs SET workflow_status = $2,
           finalized_at = $3::timestamp,
           version = version + 1
         WHERE id = $1 AND version = $4`,
        [id, body.status, finalizedAt, body.version],
      );

      await client.query(
        `INSERT INTO ard_status_history (trf_id, old_status, new_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, current.workflow_status, body.status, user.id, body.note ?? null],
      );

      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'trf.ard_status_changed', module: 'trf',
        recordType: 'TRF', recordRef: current.trf_number,
        oldValue: { ardStatus: current.workflow_status, stage: current.ard_stage },
        newValue: { ardStatus: body.status, stage: current.ard_stage, note: body.note ?? null },
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

trfsRouter.post('/:id/assign', requirePermission('trf.assign'), validateBody(assignSchema), async (req, res, next) => {  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof assignSchema>;

    const result = await withTransaction(async (client) => {
      const locked = await client.query<{ version: number; trf_number: string; assigned_employee_id: number | null; status: TrfStatus; assigned_employee_name: string | null }>(
        `SELECT t.version, t.trf_number, t.assigned_employee_id, t.status,
                e.full_name AS assigned_employee_name
         FROM trfs t LEFT JOIN employees e ON e.id = t.assigned_employee_id
         WHERE t.id = $1 FOR UPDATE OF t`,
        [id],
      );
      const current = locked.rows[0];
      if (!current) throw notFound();
      if (current.version !== body.version) throw versionConflict();
      if (current.status === 'Completed' || current.status === 'Cancelled') {
        throw conflict(`This TRF is ${current.status} and can no longer be assigned.`);
      }

      let newName: string | null = null;
      if (body.assignedEmployeeId !== null) {
        const target = await client.query<{ id: number; full_name: string; is_active: boolean; role: string }>(
          `SELECT id, full_name, is_active, role FROM employees WHERE id = $1`, [body.assignedEmployeeId],
        );
        const employee = target.rows[0];
        if (!employee) throw badRequest('That employee does not exist.', { assignedEmployeeId: 'Select an employee from the list.' });
        if (!employee.is_active) throw badRequest('That employee is not active.', { assignedEmployeeId: 'An inactive employee cannot be assigned.' });
        if (employee.role === 'Viewer') throw badRequest('A Viewer cannot be assigned analysis work.', { assignedEmployeeId: 'Choose an Analyst or Manager.' });
        newName = employee.full_name;
      }

      const updated = await client.query<{ id: number }>(
        `UPDATE trfs SET assigned_employee_id = $2, version = version + 1 WHERE id = $1 AND version = $3 RETURNING id`,
        [id, body.assignedEmployeeId, body.version],
      );
      if (updated.rowCount === 0) throw versionConflict();

      if (current.assigned_employee_id !== body.assignedEmployeeId) {
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'trf.assigned', module: 'trf',
          recordType: 'TRF', recordRef: current.trf_number,
          oldValue: { assignedEmployee: current.assigned_employee_name },
          newValue: { assignedEmployee: newName },
        });
      }
      if (body.note) {
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'trf.assignment_note', module: 'trf',
          recordType: 'TRF', recordRef: current.trf_number, newValue: { note: body.note },
        });
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
