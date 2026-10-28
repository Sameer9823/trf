import { Router } from 'express';
import { z } from 'zod';
import type {
  Assignment, AssignmentFilters, AssignmentGroup, AssignmentGroupPage, AssignmentInput,
  AssignmentListPage, EmployeeProfile, TestCatalogItem, TrfStatus, WorkloadRow,
} from '@trf/shared';
import { canTransitionAnalysis, canTransitionTrf, roleHasPermission } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { badRequest, conflict, duplicateError, forbidden, notFound, versionConflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  ASSIGNMENT_FROM, ASSIGNMENT_SELECT, ASSIGNMENT_SORT_SQL, DELAYED_SQL, AssignmentRow,
  assignmentListQuerySchema, buildAssignmentWhere, toAssignment, toAssignmentFilters,
} from '../lib/assignment-query';
import { authenticate, currentEmployee, invalidateEmployeeCache, requirePermission, validateBody } from '../middleware/auth';

export const assignmentsRouter = Router();
assignmentsRouter.use(authenticate);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

const assignmentInput = z.object({
  testName: z.string().trim().min(2, 'Enter the test name.').max(120),
  testMethod: z.string().trim().max(120).nullable().optional(),
  specification: z.string().trim().max(200).nullable().optional(),
  assignedEmployeeId: z.number().int().positive(),
  dueDate: ISO_DATE.nullable().optional(),
});

const createSchema = z.object({
  // Several tests at once, each with its own employee and due date.
  assignments: z.array(assignmentInput).min(1, 'Assign at least one test.').max(100),
});

const updateSchema = z.object({
  version: z.number().int().positive(),
  assignedEmployeeId: z.number().int().positive().nullable().optional(),
  dueDate: ISO_DATE.nullable().optional(),
  testMethod: z.string().trim().max(120).nullable().optional(),
  specification: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

/** Test names are compared case-insensitively, so "Moisture" and "moisture" are one test. */
const normaliseTestName = (name: string) => name.trim().replace(/\s+/g, ' ');

/** Only active staff who can hold work. A Viewer cannot be assigned anything. */
async function assertAssignable(employeeId: number, client?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { full_name: string; is_active: boolean; role: string }[] }> }) {
  const runner = client ?? pool;
  const result = await runner.query<{ full_name: string; is_active: boolean; role: string }>(
    `SELECT full_name, is_active, role FROM employees WHERE id = $1`, [employeeId],
  );
  const employee = result.rows[0];
  if (!employee) throw badRequest('That employee does not exist.', { assignedEmployeeId: 'Select an employee from the list.' });
  if (!employee.is_active) throw badRequest('That employee is not active.', { assignedEmployeeId: 'An inactive employee cannot be assigned work.' });
  if (employee.role === 'Viewer') throw badRequest('A Viewer cannot be assigned analysis work.', { assignedEmployeeId: 'Choose an Analyst or Manager.' });
  return employee.full_name;
}

assignmentsRouter.get('/', requirePermission('assignments.viewOwn'), async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const q = assignmentListQuerySchema.parse(req.query);
    const filters: AssignmentFilters = toAssignmentFilters(q);
    // Analysts see only their own work; roles with viewAll see everything.
    const scope = roleHasPermission(viewer.role, 'assignments.viewAll') ? null : { employeeId: viewer.id };

    const params: unknown[] = [];
    const whereSql = buildAssignmentWhere(filters, params, scope);

    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count ${ASSIGNMENT_FROM} ${whereSql}`, params);
    const total = Number(countResult.rows[0].count);

    const sortColumn = ASSIGNMENT_SORT_SQL[filters.sortBy];
    const dir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

    if (q.groupByTrf === 'true') {
      // The Manager's by-TRF view: one row per TRF, then its tests.
      const rows = await pool.query<AssignmentRow & { is_delayed: boolean }>(
        `SELECT ${ASSIGNMENT_SELECT}, (${DELAYED_SQL}) AS is_delayed ${ASSIGNMENT_FROM} ${whereSql}
         ORDER BY ${sortColumn} ${dir} NULLS LAST, a.id ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
      );
      const groups = new Map<number, AssignmentGroup>();
      for (const row of rows.rows) {
        let group = groups.get(row.trf_id);
        if (!group) {
          group = {
            trfId: row.trf_id,
            trfNumber: row.trf_number,
            trfStatus: row.trf_status,
            productName: row.product_name,
            batchNumber: row.batch_number,
            customerName: row.customer_name,
            priority: row.priority,
            requiredCompletionDate: dateOnly(row.required_completion_date),
            trfVersion: 0,
            tests: [],
          };
          groups.set(row.trf_id, group);
        }
        group.tests.push(toAssignment(row));
      }
const body: AssignmentGroupPage = {
        items: [...groups.values()].map((group) => ({
          ...group,
          trfVersion: rows.rows.find((r) => r.trf_id === group.trfId)?.trf_version ?? 0,
        })),
        total, page: filters.page, pageSize: filters.pageSize,
        pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
      };
      return res.json(body);
    }

    const rows = await pool.query<AssignmentRow & { is_delayed: boolean }>(
      `SELECT ${ASSIGNMENT_SELECT}, (${DELAYED_SQL}) AS is_delayed ${ASSIGNMENT_FROM} ${whereSql}
       ORDER BY ${sortColumn} ${dir} NULLS LAST, a.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );

    const body: AssignmentListPage = {
      items: rows.rows.map((row) => toAssignment(row)),
      total, page: filters.page, pageSize: filters.pageSize,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    };
    res.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    next(err);
  }
});

const dateOnly = (value: Date | string | null): string | null => {
  if (!value) return null;
  return (typeof value === 'string' ? value : value.toISOString()).slice(0, 10);
};

assignmentsRouter.get('/workload', requirePermission('assignments.viewAll'), async (_req, res, next) => {
  try {
    // Aggregate in SQL: open tests per employee, never counted in the client.
    const result = await pool.query<{
      employee_id: number; full_name: string; department_name: string | null;
      pending: string; in_progress: string; delayed: string; completed: string;
    }>(
      `SELECT e.id AS employee_id, e.full_name, d.name AS department_name,
         count(*) FILTER (WHERE a.status IN ('Pending', 'Assigned'))::text AS pending,
         count(*) FILTER (WHERE a.status = 'In Progress')::text AS in_progress,
         count(*) FILTER (WHERE ${DELAYED_SQL})::text AS delayed,
         count(*) FILTER (WHERE a.status = 'Completed')::text AS completed
       FROM analysis_tests a
       JOIN employees e ON e.id = a.assigned_employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active = TRUE AND a.status <> 'Cancelled'
       GROUP BY e.id, e.full_name, d.name
       ORDER BY count(*) FILTER (WHERE a.status <> 'Completed') DESC, e.full_name ASC`,
    );
    const rows: WorkloadRow[] = result.rows.map((r) => {
      const pending = Number(r.pending);
      const inProgress = Number(r.in_progress);
      const delayed = Number(r.delayed);
      return {
        employeeId: r.employee_id,
        employeeName: r.full_name,
        departmentName: r.department_name,
        pending,
        inProgress,
        delayed,
        completed: Number(r.completed),
        openTotal: pending + inProgress,
      };
    });
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

assignmentsRouter.get('/tests/:id', requirePermission('assignments.viewOwn'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const viewer = currentEmployee(req);
    const result = await pool.query<AssignmentRow & { is_delayed: boolean }>(
      `SELECT ${ASSIGNMENT_SELECT}, (${DELAYED_SQL}) AS is_delayed ${ASSIGNMENT_FROM} WHERE a.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw notFound();
    assertCanSee(row, viewer);
    res.json(toAssignment(row));
  } catch (err) {
    next(err);
  }
});

function assertCanSee(row: AssignmentRow, viewer: EmployeeProfile): void {
  if (roleHasPermission(viewer.role, 'assignments.viewAll')) return;
  if (row.assigned_employee_id !== viewer.id) throw forbidden();
}

/**
 * Assigns several tests to one TRF in a single transaction. Either all of them
 * are created or none are: two managers assigning at the same time can never
 * produce a half-created set or a duplicate test.
 */
assignmentsRouter.post('/trfs/:trfId/assignments', requirePermission('assignments.manage'), validateBody(createSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const trfId = Number(req.params.trfId);
    if (!Number.isInteger(trfId) || trfId <= 0) throw notFound();
    const { assignments } = req.body as z.infer<typeof createSchema>;

    // A duplicate inside one request would only be caught by the database, so check here first.
    const seen = new Set<string>();
    for (const item of assignments) {
      const key = normaliseTestName(item.testName).toLowerCase();
      if (seen.has(key)) {
        throw conflict(`â€œ${item.testName.trim()}â€ is listed twice. Each test can only be assigned once per TRF.`);
      }
      seen.add(key);
    }

    const created = await withTransaction(async (client) => {
      const trf = await client.query<{ id: number; trf_number: string; status: TrfStatus; version: number }>(
        `SELECT id, trf_number, status, version FROM trfs WHERE id = $1 FOR UPDATE`, [trfId],
      );
      const record = trf.rows[0];
      if (!record) throw notFound();
      if (record.status === 'Completed' || record.status === 'Cancelled') {
        throw conflict(`This TRF is ${record.status} and can no longer receive assignments.`);
      }

      // Which of these tests are already on the TRF? Checked in one round trip.
      const names = assignments.map((a) => normaliseTestName(a.testName));
      const existing = await client.query<{ test_name: string }>(
        `SELECT test_name FROM analysis_tests
         WHERE trf_id = $1 AND lower(test_name) IN (SELECT lower(n) FROM unnest($2::text[]) AS n)`,
        [trfId, names],
      );
      if (existing.rows.length) {
        throw conflict(`â€œ${existing.rows[0].test_name}â€ is already assigned on ${record.trf_number}. Each test can only be assigned once per TRF.`);
      }

      // Method and specification fall back to the admin-managed catalogue.
      const catalogue = await client.query<{ name: string; default_method: string | null; specification: string | null }>(
        `SELECT name, default_method, specification FROM test_catalog
         WHERE lower(name) IN (SELECT lower(n) FROM unnest($1::text[]) AS n)`,
        [names],
      );
      const byName = new Map(catalogue.rows.map((c) => [c.name.toLowerCase(), c]));

      const inserted: Assignment[] = [];
      for (const item of assignments) {
        const catalog = byName.get(normaliseTestName(item.testName).toLowerCase());
        const employeeName = await assertAssignable(item.assignedEmployeeId, client as never);
        const testMethod = item.testMethod ?? catalog?.default_method ?? null;
        const specification = item.specification ?? catalog?.specification ?? null;

        const result = await client.query<{ id: number; version: number; assigned_date: string | null; created_at: Date; updated_at: Date }>(
          `INSERT INTO analysis_tests (trf_id, test_name, test_method, specification,
             assigned_employee_id, assigned_date, due_date, status)
           VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, 'Assigned')
           RETURNING id, version, assigned_date, created_at, updated_at`,
          [trfId, normaliseTestName(item.testName), testMethod, specification, item.assignedEmployeeId, item.dueDate ?? null],
        );
        const row = result.rows[0];
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'assignment.created', module: 'assignments',
          recordType: 'AnalysisTest', recordRef: `${record.trf_number} / ${normaliseTestName(item.testName)}`,
          newValue: { testName: normaliseTestName(item.testName), assignedEmployee: employeeName, dueDate: item.dueDate ?? null, status: 'Assigned' },
        });
        inserted.push({
          id: row.id, trfId, trfNumber: record.trf_number, productName: null, batchNumber: null,
          customerName: null, trfStatus: record.status, priority: 'Normal',
          testName: normaliseTestName(item.testName), testMethod, specification,
          assignedEmployeeId: item.assignedEmployeeId, assignedEmployeeName: employeeName,
          assignedDate: dateOnly(row.assigned_date), dueDate: item.dueDate ?? null,
          status: 'Assigned', isDelayed: false, version: row.version,
          createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
        });
      }

      // The TRF is Assigned once it has at least one test, using the same
      // transition table as the manual status endpoint.
      let trfStatus = record.status;
      if (canTransitionTrf(record.status, 'Assigned')) {
        await client.query(
          `UPDATE trfs SET status = 'Assigned', version = version + 1 WHERE id = $1 AND version = $2`,
          [trfId, record.version],
        );
        await client.query(
          `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
           VALUES ($1, $2, 'Assigned', $3, $4)`,
          [trfId, record.status, user.id, `Tests assigned: ${inserted.map((i) => i.testName).join(', ')}`],
        );
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'trf.status_changed', module: 'trf',
          recordType: 'TRF', recordRef: record.trf_number,
          oldValue: { status: record.status }, newValue: { status: 'Assigned', reason: 'tests assigned' },
        });
        trfStatus = 'Assigned';
      }

      return { items: inserted, trfStatus };
    });

    res.status(201).json(created);
  } catch (err) {
    // The unique constraint is the last line of defence against a duplicate test.
    const dup = duplicateError(err, { uq_analysis_tests_trf_name: 'That test is already assigned on this TRF. Each test can only be assigned once per TRF.' });
    next(dup ?? err);
  }
});

assignmentsRouter.get('/trfs/:trfId', requirePermission('assignments.viewOwn'), async (req, res, next) => {
  try {
    const trfId = Number(req.params.trfId);
    if (!Number.isInteger(trfId) || trfId <= 0) throw notFound();
    const viewer = currentEmployee(req);
    const rows = await pool.query<AssignmentRow & { is_delayed: boolean }>(
      `SELECT ${ASSIGNMENT_SELECT}, (${DELAYED_SQL}) AS is_delayed ${ASSIGNMENT_FROM}
       WHERE a.trf_id = $1 ORDER BY a.test_name ASC`, [trfId]);
    const items = rows.rows.filter((row) => {
      if (roleHasPermission(viewer.role, 'assignments.viewAll')) return true;
      return row.assigned_employee_id === viewer.id;
    });
    res.json({ items: items.map((row) => toAssignment(row)) });
  } catch (err) {
    next(err);
  }
});

assignmentsRouter.patch('/tests/:id', requirePermission('assignments.manage'), validateBody(updateSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof updateSchema>;

    const updated = await withTransaction(async (client) => {
      // FOR UPDATE makes "read the current owner, then write the new one" atomic.
      const locked = await client.query<{
        version: number; status: string; test_name: string; trf_number: string; trf_id: number;
        assigned_employee_id: number | null; assigned_employee_name: string | null; due_date: string | null;
      }>(
        `SELECT a.version, a.status, a.test_name, a.assigned_employee_id, a.due_date, a.trf_id,
                t.trf_number, e.full_name AS assigned_employee_name
         FROM analysis_tests a
         JOIN trfs t ON t.id = a.trf_id
         LEFT JOIN employees e ON e.id = a.assigned_employee_id
         WHERE a.id = $1 FOR UPDATE OF a`, [id],
      );
      const current = locked.rows[0];
      if (!current) throw notFound();
      if (current.version !== body.version) throw versionConflict();
      if (current.status === 'Cancelled') throw conflict('This test assignment has been cancelled and cannot be changed.');

      const fields: Record<string, unknown> = {
        assigned_employee_id: body.assignedEmployeeId,
        due_date: body.dueDate,
        test_method: body.testMethod,
        specification: body.specification,
      };
      const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
      if (!keys.length) throw badRequest('There is nothing to update.');

      let newEmployeeName: string | null = current.assigned_employee_name;
      if (body.assignedEmployeeId !== undefined && body.assignedEmployeeId !== null) {
        newEmployeeName = await assertAssignable(body.assignedEmployeeId, client as never);
      }

      const result = await client.query(
        `UPDATE analysis_tests SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, version = version + 1
         WHERE id = $${keys.length + 1} AND version = $${keys.length + 2}`,
        [...keys.map((k) => fields[k]), id, body.version],
      );
      if (result.rowCount === 0) throw versionConflict();

      // Reassignment is recorded as "Assigned Employee: A -> C".
      if (body.assignedEmployeeId !== undefined && body.assignedEmployeeId !== current.assigned_employee_id) {
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'assignment.reassigned', module: 'assignments',
          recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
          oldValue: { assignedEmployee: current.assigned_employee_name },
          newValue: { assignedEmployee: newEmployeeName },
        });
      }
      if (body.dueDate !== undefined && dateOnly(body.dueDate) !== dateOnly(current.due_date)) {
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'assignment.due_date_changed', module: 'assignments',
          recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
          oldValue: { dueDate: dateOnly(current.due_date) }, newValue: { dueDate: body.dueDate },
        });
      }
      if (body.note) {
        await writeAudit(client, {
          userId: user.id, userName: user.fullName, action: 'assignment.note', module: 'assignments',
          recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
          newValue: { note: body.note },
        });
      }
      return id;
    });

    invalidateEmployeeCache(user.id);
    const row = await pool.query<AssignmentRow & { is_delayed: boolean }>(
      `SELECT ${ASSIGNMENT_SELECT}, (${DELAYED_SQL}) AS is_delayed ${ASSIGNMENT_FROM} WHERE a.id = $1`, [updated]);
    res.json(toAssignment(row.rows[0]));
  } catch (err) {
    next(err);
  }
});

assignmentsRouter.post('/tests/:id/cancel', requirePermission('assignments.manage'), validateBody(z.object({
  version: z.number().int().positive(),
  note: z.string().trim().max(500).nullable().optional(),
})), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as { version: number; note?: string | null };

    await withTransaction(async (client) => {
      const locked = await client.query<{ version: number; status: string; test_name: string; trf_number: string }>(
        `SELECT a.version, a.status, a.test_name, t.trf_number
         FROM analysis_tests a JOIN trfs t ON t.id = a.trf_id
         WHERE a.id = $1 FOR UPDATE OF a`, [id],
      );
      const current = locked.rows[0];
      if (!current) throw notFound();
      if (current.version !== body.version) throw versionConflict();
      if (!canTransitionAnalysis(current.status as never, 'Cancelled')) {
        throw conflict(`A test that is ${current.status} cannot be cancelled.`);
      }
      const result = await client.query(
        `UPDATE analysis_tests SET status = 'Cancelled', version = version + 1 WHERE id = $1 AND version = $2`,
        [id, body.version],
      );
      if (result.rowCount === 0) throw versionConflict();
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'assignment.cancelled', module: 'assignments',
        recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
        oldValue: { status: current.status }, newValue: { status: 'Cancelled', note: body.note ?? null },
      });
    });

    const row = await pool.query<AssignmentRow & { is_delayed: boolean }>(
      `SELECT ${ASSIGNMENT_SELECT}, (${DELAYED_SQL}) AS is_delayed ${ASSIGNMENT_FROM} WHERE a.id = $1`, [id]);
    res.json(toAssignment(row.rows[0]));
  } catch (err) {
    next(err);
  }
});

// --- Test catalogue -------------------------------------------------------

export const catalogRouter = Router();
catalogRouter.use(authenticate);

interface CatalogRow { id: number; name: string; default_method: string | null; specification: string | null; unit: string | null; is_active: boolean }

const catalogSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(120),
  defaultMethod: z.string().trim().max(120).nullable().optional(),
  specification: z.string().trim().max(200).nullable().optional(),
  unit: z.string().trim().max(30).nullable().optional(),
});

const toCatalogItem = (r: CatalogRow): TestCatalogItem => ({
  id: r.id, name: r.name, defaultMethod: r.default_method, specification: r.specification,
  unit: r.unit, isActive: r.is_active,
});

catalogRouter.get('/', requirePermission('assignments.viewOwn'), async (req, res, next) => {
  try {
    // Everyone who assigns work needs the catalogue to fill the form.
    const includeInactive = req.query.includeInactive === 'true';
    const result = await pool.query<CatalogRow>(
      `SELECT id, name, default_method, specification, unit, is_active FROM test_catalog
       ${includeInactive ? '' : 'WHERE is_active = TRUE'} ORDER BY name ASC`,
    );
    res.json({ items: result.rows.map(toCatalogItem) });
  } catch (err) { next(err); }
});

catalogRouter.post('/', requirePermission('employees.manage'), validateBody(catalogSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const b = req.body as z.infer<typeof catalogSchema>;
    const created = await withTransaction(async (client) => {
      const result = await client.query<CatalogRow>(
        `INSERT INTO test_catalog (name, default_method, specification, unit)
         VALUES ($1, $2, $3, $4) RETURNING id, name, default_method, specification, unit, is_active`,
        [normaliseTestName(b.name), b.defaultMethod ?? null, b.specification ?? null, b.unit ?? null]);
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'test_catalog.created', module: 'assignments',
        recordType: 'TestCatalog', recordRef: result.rows[0].name, newValue: { name: result.rows[0].name },
      });
      return result.rows[0];
    });
    res.status(201).json(toCatalogItem(created));
  } catch (err) {
    next(duplicateError(err, { uq_test_catalog_name_lower: 'That test is already in the catalogue.' }) ?? err);
  }
});

catalogRouter.patch('/:id', requirePermission('employees.manage'), validateBody(catalogSchema.partial().extend({
  isActive: z.boolean().optional(),
})), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    const b = req.body as { name?: string; defaultMethod?: string | null; specification?: string | null; unit?: string | null; isActive?: boolean };
    const result = await pool.query<CatalogRow>(
      `UPDATE test_catalog SET name = COALESCE($2, name), default_method = COALESCE($3, default_method),
         specification = COALESCE($4, specification), unit = COALESCE($5, unit), is_active = COALESCE($6, is_active)
       WHERE id = $1 RETURNING id, name, default_method, specification, unit, is_active`,
      [id, b.name ? normaliseTestName(b.name) : null, b.defaultMethod ?? null, b.specification ?? null, b.unit ?? null, b.isActive ?? null],
    );
    if (!result.rows[0]) throw notFound();
    // The update and its audit row commit together, or not at all.
    await withTransaction(async (client) => {
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'test_catalog.updated', module: 'assignments',
        recordType: 'TestCatalog', recordRef: result.rows[0].name, newValue: b,
      });
    });
    res.json(toCatalogItem(result.rows[0]));
  } catch (err) {
    next(duplicateError(err, { uq_test_catalog_name_lower: 'That test is already in the catalogue.' }) ?? err);
  }
});