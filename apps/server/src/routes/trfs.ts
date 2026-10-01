import { Router } from 'express';
import { z } from 'zod';
import type { EmployeeProfile, TrfListPage, TrfStatus, TrfStatusHistoryEntry } from '@trf/shared';
import {
  MESSAGES, PRIORITIES, TRF_STATUS_TRANSITIONS, canTransitionTrf, roleHasPermission,
} from '@trf/shared';
import { pool, withTransaction } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound, versionConflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { nextNumber, trfDuplicateError } from '../lib/numbers';
import {
  OVERDUE_SQL, TRF_DETAIL_FROM, TRF_DETAIL_SELECT, TRF_FROM, TRF_SELECT, TRF_SORT_SQL,
  TrfRow, toDetail, toListItem, trfListQuerySchema, toFilters,
} from '../lib/trf-query';
import { authenticate, currentEmployee, requirePermission, validateBody } from '../middleware/auth';

export const trfsRouter = Router();
trfsRouter.use(authenticate);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

const createSchema = z.object({
  trfDate: ISO_DATE,
  customerId: z.number().int().positive().nullable().optional(),
  productId: z.number().int().positive().nullable().optional(),
  batchNumber: z.string().trim().max(60).nullable().optional(),
  sampleQuantity: z.string().trim().max(60).nullable().optional(),
  sampleReceivedDate: ISO_DATE.nullable().optional(),
  requiredCompletionDate: ISO_DATE.nullable().optional(),
  priority: z.enum(PRIORITIES).default('Normal'),
  requestedAnalysis: z.string().trim().max(4000).nullable().optional(),
  specialInstructions: z.string().trim().max(2000).nullable().optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  remarks: z.string().trim().max(2000).nullable().optional(),
});

const updateSchema = createSchema.partial().extend({
  version: z.number().int().positive(),
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

/** Only fields an ordinary edit may touch. Status and the TRF number are not editable. */
const EDITABLE = [
  'trfDate', 'customerId', 'productId', 'batchNumber', 'sampleQuantity', 'sampleReceivedDate',
  'requiredCompletionDate', 'priority', 'requestedAnalysis', 'specialInstructions',
  'departmentId', 'remarks',
] as const;

const COLUMN: Record<(typeof EDITABLE)[number], string> = {
  trfDate: 'trf_date',
  customerId: 'customer_id',
  productId: 'product_id',
  batchNumber: 'batch_number',
  sampleQuantity: 'sample_quantity',
  sampleReceivedDate: 'sample_received_date',
  requiredCompletionDate: 'required_completion_date',
  priority: 'priority',
  requestedAnalysis: 'requested_analysis',
  specialInstructions: 'special_instructions',
  departmentId: 'department_id',
  remarks: 'remarks',
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

  // Applied in SQL, so a restricted user never receives rows they must not see.
  if (scope) {
    params.push(scope.employeeId);
    clauses.push(`(t.assigned_employee_id = $${params.length} OR t.created_by = $${params.length})`);
  }

  if (filters.search) {
    // One parameter, five comparisons: PostgreSQL can reuse the one plan.
    params.push(`%${filters.search.toLowerCase()}%`);
    const p = params.length;
    clauses.push(`(lower(t.trf_number) LIKE $${p} OR lower(COALESCE(t.batch_number, '')) LIKE $${p}
      OR lower(COALESCE(c.name, '')) LIKE $${p} OR lower(COALESCE(p.name, '')) LIKE $${p}
      OR lower(COALESCE(e.full_name, '')) LIKE $${p})`);
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
       LEFT JOIN employees e ON e.id = t.assigned_employee_id ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0].count);

    const sortColumn = TRF_SORT_SQL[filters.sortBy];
    const dir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
    // Overdue is selected as a column and filtered on in SQL, never in the client.
    const rows = await pool.query<TrfRow & { is_overdue: boolean }>(
      `SELECT ${TRF_SELECT}, (${OVERDUE_SQL}) AS is_overdue ${TRF_FROM} ${whereSql}
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
  if (!row) throw notFound();
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

trfsRouter.post('/', requirePermission('trf.create'), validateBody(createSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const body = req.body as z.infer<typeof createSchema>;
    if (body.sampleReceivedDate && body.trfDate && body.sampleReceivedDate < body.trfDate) {
      throw badRequest('The sample received date cannot be earlier than the TRF date.', {
        sampleReceivedDate: 'The sample received date cannot be earlier than the TRF date.',
      });
    }

    const created = await withTransaction(async (client) => {
      // The number and the TRF row are committed together, so a rollback never burns a number.
      const trfNumber = await nextNumber(client, 'TRF', Number(body.trfDate.slice(0, 4)));
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO trfs (trf_number, trf_date, customer_id, product_id, batch_number, sample_quantity,
           sample_received_date, required_completion_date, priority, requested_analysis,
           special_instructions, department_id, remarks, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [trfNumber, body.trfDate, normalise(body.customerId), normalise(body.productId),
         normalise(body.batchNumber), normalise(body.sampleQuantity), body.sampleReceivedDate ?? null,
         body.requiredCompletionDate ?? null, body.priority, normalise(body.requestedAnalysis),
         normalise(body.specialInstructions), normalise(body.departmentId ?? user.departmentId),
         normalise(body.remarks), user.id],
      );
      const id = inserted.rows[0].id;
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

trfsRouter.patch('/:id', requirePermission('trf.edit'), validateBody(updateSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof updateSchema>;

    const updatedId = await withTransaction(async (client) => {
      // FOR UPDATE OF t locks the TRF row only: the joined lookup tables are shared
      // across TRFs and must never be locked here.
      const before = await client.query<TrfRow>(`SELECT ${TRF_SELECT} ${TRF_FROM} WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      const current = before.rows[0];
      if (!current) throw notFound();
      if (current.status === 'Completed' || current.status === 'Cancelled') {
        throw conflict(`This TRF is ${current.status} and can no longer be edited.`);
      }

      const fields = EDITABLE.filter((key) => body[key] !== undefined);
      if (!fields.length) throw badRequest('There is nothing to update.');

      const params: unknown[] = fields.map((key) => normalise(body[key]));
      const result = await client.query<{ id: number }>(
        `UPDATE trfs SET ${fields.map((key, i) => `${COLUMN[key]} = $${i + 1}`).join(', ')},
           version = version + 1
         WHERE id = $${fields.length + 1} AND version = $${fields.length + 2}
         RETURNING id`,
        [...params, id, body.version],
      );
      // Somebody else saved between the client reading the record and this save.
      if (result.rowCount === 0) throw versionConflict();

      // One audit row per changed field, old value to new value. The comparison
      // is against the locked row, so it records what really changed.
      for (const key of fields) {
        const oldRaw = (current as unknown as Record<string, unknown>)[COLUMN[key]];
        const oldValue = oldRaw instanceof Date ? oldRaw.toISOString().slice(0, 10) : oldRaw ?? null;
        const newValue = body[key] ?? null;
        if (String(oldValue ?? '') === String(newValue ?? '')) continue;
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'trf.field_changed', module: 'trf',
          recordType: 'TRF', recordRef: current.trf_number,
          oldValue: { field: key, value: oldValue },
          newValue: { field: key, value: newValue },
        });
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

trfsRouter.post('/:id/assign', requirePermission('trf.assign'), validateBody(assignSchema), async (req, res, next) => {
  const user = currentEmployee(req);
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
