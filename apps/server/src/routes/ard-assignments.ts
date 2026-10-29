import { Router } from 'express';
import { z } from 'zod';
import type {
  ArdTestAssignment,
  ArdTestAssignmentAnalyst,
  ArdTestAssignmentHistory,
  ArdTestAssignmentStatus,
  AnalystAssignedTest,
  ArdTestAssignmentOverview,
  EmployeeProfile,
  ANALYTICAL_DEPARTMENTS,
} from '@trf/shared';
import { ARD_TEST_ASSIGNMENT_STATUSES, roleHasPermission, canAccessAnalytical } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { badRequest, conflict, forbidden, notFound, versionConflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { createNotification } from '../lib/notifications';
import { authenticate, currentEmployee, requirePermission, requireAssignmentsManage, validateBody } from '../middleware/auth';

export const ardAssignmentsRouter = Router();
ardAssignmentsRouter.use(authenticate);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

const assignmentAnalystSchema = z.object({
  analystId: z.number().int().positive(),
});

const createAssignmentSchema = z.object({
  trfId: z.number().int().positive(),
  testRequestedOptionId: z.number().int().positive(),
  testName: z.string().trim().min(2, 'Enter the test name.').max(120),
  analystIds: z.array(z.number().int().positive()).default([]),
  dueDate: ISO_DATE.nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});

const bulkAssignmentSchema = z.object({
  trfId: z.number().int().positive(),
  assignments: z.array(z.object({
    testRequestedOptionId: z.number().int().positive(),
    testName: z.string().trim().min(2).max(120),
    analystIds: z.array(z.number().int().positive()).default([]),
    dueDate: ISO_DATE.nullable().optional(),
    reason: z.string().trim().max(500).nullable().optional(),
  })).min(1, 'At least one test assignment is required.'),
});

const updateAssignmentSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(ARD_TEST_ASSIGNMENT_STATUSES).optional(),
  analystIds: z.array(z.number().int().positive()).optional(),
  dueDate: ISO_DATE.nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});

const statusUpdateSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(ARD_TEST_ASSIGNMENT_STATUSES),
  reason: z.string().trim().max(500).nullable().optional(),
});

/** Verify analyst is active and not a Viewer */
async function assertValidAnalyst(analystId: number, client?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { full_name: string; is_active: boolean; role: string }[] }> }) {
  const runner = client ?? pool;
  const result = await runner.query<{ full_name: string; is_active: boolean; role: string }>(
    `SELECT full_name, is_active, role FROM employees WHERE id = $1`, [analystId],
  );
  const employee = result.rows[0];
  if (!employee) throw badRequest('That analyst does not exist.', { analystId: 'Select an analyst from the list.' });
  if (!employee.is_active) throw badRequest('That analyst is not active.', { analystId: 'An inactive analyst cannot be assigned work.' });
  if (employee.role === 'Viewer') throw badRequest('A Viewer cannot be assigned analysis work.', { analystId: 'Choose an Analyst or Manager.' });
  return employee.full_name;
}

/** Check if user can manage ARD assignments (Admin or Manager with assignments.manage) */
function canManageArdAssignments(role: string): boolean {
  return roleHasPermission(role as any, 'assignments.manage');
}

/** Map snake_case DB row to camelCase ArdTestAssignment */
function mapAssignment(row: any, analysts: any[] = []): ArdTestAssignment {
  return {
    id: row.id,
    trfId: row.trf_id,
    testRequestedOptionId: row.test_requested_option_id,
    testName: row.test_name,
    status: row.status,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at ? new Date(row.assigned_at).toISOString() : null,
    dueDate: row.due_date ? row.due_date.toISOString().slice(0, 10) : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: row.version,
    analysts: analysts.map(a => ({
      id: a.id,
      fullName: a.full_name,
      employeeCode: a.employee_code,
      departmentName: a.department_name,
      assignedAt: new Date(a.assigned_at).toISOString(),
    })),
    analystIds: analysts.map(a => a.id),
  };
}

/** Compute status based on analyst count */
function computeStatus(currentStatus: ArdTestAssignmentStatus, analystCount: number): ArdTestAssignmentStatus {
  if (currentStatus === 'Completed' || currentStatus === 'Cancelled') return currentStatus;
  if (analystCount > 0 && currentStatus === 'Pending Assignment') return 'Assigned';
  if (analystCount === 0 && currentStatus === 'Assigned') return 'Pending Assignment';
  return currentStatus;
}

/** GET /api/ard-assignments/trfs/:trfId - Get all test assignments for a TRF */
ardAssignmentsRouter.get('/trfs/:trfId', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const trfId = Number(req.params.trfId);
    if (!Number.isInteger(trfId) || trfId <= 0) throw notFound();

    const viewer = currentEmployee(req);
    const isArdManager = canManageArdAssignments(viewer.role);

    // Get TRF number for notifications
    const trfNumResult = await pool.query<{ trf_number: string }>(
      `SELECT trf_number FROM trfs WHERE id = $1`, [trfId],
    );
    const trfNumber = trfNumResult.rows[0]?.trf_number ?? String(trfId);

    const result = await pool.query<{
      id: number;
      trf_id: number;
      test_requested_option_id: number;
      test_name: string;
      status: ArdTestAssignmentStatus;
      assigned_by: number | null;
      assigned_at: string | null;
      due_date: string | null;
      created_at: string;
      updated_at: string;
      version: number;
      analysts: { id: number; full_name: string; employee_code: string; department_name: string | null; assigned_at: string }[];
    }>(`
      SELECT
        ata.id,
        ata.trf_id,
        ata.test_requested_option_id,
        ata.test_name,
        ata.status,
        ata.assigned_by,
        ata.assigned_at,
        ata.due_date,
        ata.created_at,
        ata.updated_at,
        ata.version,
        COALESCE(
          json_agg(
            json_build_object(
              'id', e.id,
              'full_name', e.full_name,
              'employee_code', e.employee_code,
              'department_name', d.name,
              'assigned_at', ataa.assigned_at
            )
          ) FILTER (WHERE e.id IS NOT NULL),
          '[]'::json
        ) AS analysts
      FROM ard_test_assignments ata
      LEFT JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
      LEFT JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ata.trf_id = $1
      GROUP BY ata.id
      ORDER BY ata.created_at ASC
    `, [trfId]);

    let items = result.rows.map(row => mapAssignment(row, row.analysts || []));

    // Filter for analysts - they only see their own assignments
    if (!isArdManager && viewer.role === 'Analyst') {
      items = items.filter(item =>
        item.analysts?.some(a => a.id === viewer.id)
      );
    }

    res.json({ items });
  } catch (err) { next(err); }
});

/** POST /api/ard-assignments - Create assignment from FRD test selection */
ardAssignmentsRouter.post('/', requireAssignmentsManage(), validateBody(createAssignmentSchema), async (req, res, next) => {
  const assigner = currentEmployee(req);
  try {
    const body = req.body as z.infer<typeof createAssignmentSchema>;

    const result = await withTransaction(async (client) => {
      const trfResult = await client.query<{ workflow_status: string; final_approval_status: string; locked_at: string | null; id: number; required_completion_date: string | null; trf_number: string }>(
        `SELECT id, workflow_status, final_approval_status, locked_at, required_completion_date, trf_number FROM trfs WHERE id = $1 FOR UPDATE`, [body.trfId],
      );
      const trf = trfResult.rows[0];
      if (!trf) throw notFound();
      if (trf.locked_at) throw conflict('This TRF is locked and cannot be edited.');

      const optionResult = await client.query<{ id: number }>(
        `SELECT id FROM test_requested_options WHERE id = $1`, [body.testRequestedOptionId],
      );
      if (!optionResult.rows[0]) throw badRequest('That test is not recognised.', { testRequestedOptionId: 'Choose a test from the list.' });

      // Validate analysts if any
      await Promise.all(body.analystIds.map((analystId) => assertValidAnalyst(analystId, client)));

      // UPSERT: try to insert, if conflict on unique constraint, update
      const upsertResult = await client.query<{ id: number; version: number }>(`
        INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status, assigned_by, due_date, version)
        VALUES ($1, $2, $3, 'Pending Assignment', $4, $5, 1)
        ON CONFLICT (trf_id, test_requested_option_id) DO UPDATE SET
          test_name = EXCLUDED.test_name,
          due_date = EXCLUDED.due_date,
          updated_at = now()
        RETURNING id, version
      `, [body.trfId, body.testRequestedOptionId, body.testName, assigner.id, body.dueDate ?? trf.required_completion_date]);
      const assignmentId = upsertResult.rows[0].id;
      const version = upsertResult.rows[0].version;

      // Get current analysts to determine added/removed
      const currentAnalysts = await client.query<{ analyst_id: number }>(
        `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId],
      );
      const currentAnalystIds = currentAnalysts.rows.map(r => r.analyst_id);
      const newAnalystIds = body.analystIds;
      const addedIds = newAnalystIds.filter(id => !currentAnalystIds.includes(id));
      const removedIds = currentAnalystIds.filter(id => !newAnalystIds.includes(id));

      if (addedIds.length > 0 || removedIds.length > 0) {
        // Replace analysts
        await client.query(`DELETE FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId]);
        for (const analystId of newAnalystIds) {
          await client.query(
            `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id, assigned_by) VALUES ($1, $2, $3)`,
            [assignmentId, analystId, assigner.id],
          );
        }

        // Write history with reason column
        const action = addedIds.length > 0 && removedIds.length === 0 ? 'ASSIGNED'
          : removedIds.length > 0 && addedIds.length === 0 ? 'UNASSIGNED'
          : 'REASSIGNED';
        await client.query(
          `INSERT INTO ard_test_assignment_history (assignment_id, action, old_analyst_ids, new_analyst_ids, changed_by, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
          [assignmentId, action, currentAnalystIds, newAnalystIds, assigner.id, body.reason ?? null],
        );

        // Create notifications for newly assigned analysts
        for (const analystId of addedIds) {
          await createNotification(client, {
            recipientEmployeeId: analystId,
            type: 'ARD_TEST_ASSIGNED',
            title: 'New ARD Test Assigned',
            body: `You have been assigned a new analysis test: ${body.testName} for TRF ${trf.trf_number}.`,
            trfId: body.trfId,
            link: `/trfs/${trf.trf_number}`,
          });
        }

        // Notify removed analysts
        for (const analystId of removedIds) {
          await createNotification(client, {
            recipientEmployeeId: analystId,
            type: 'ARD_TEST_REASSIGNED',
            title: 'ARD Test Reassigned',
            body: `You have been unassigned from the analysis test: ${body.testName} for TRF ${trf.trf_number}.`,
            trfId: body.trfId,
            link: `/trfs/${trf.trf_number}`,
          });
        }
      }

      // Audit
      await writeAudit(client, {
        userId: assigner.id, userName: assigner.fullName, action: 'assignment.upsert', module: 'assignments',
        recordType: 'ArdTestAssignment', recordRef: String(assignmentId), newValue: { testName: body.testName, analystIds: newAnalystIds },
      });

      return { assignmentId, version };
    });

    res.status(201).json({ assignmentId: result.assignmentId, version: result.version });
  } catch (err) { next(err); }
});

/** POST /api/ard-assignments/bulk - Upsert assignments for all tests on a TRF in one call */
ardAssignmentsRouter.post('/bulk', requireAssignmentsManage(), validateBody(bulkAssignmentSchema), async (req, res, next) => {
  const assigner = currentEmployee(req);
  try {
    const body = req.body as z.infer<typeof bulkAssignmentSchema>;

    const result = await withTransaction(async (client) => {
      const trfResult = await client.query<{ workflow_status: string; final_approval_status: string; locked_at: string | null; id: number; required_completion_date: string | null; trf_number: string }>(
        `SELECT id, workflow_status, final_approval_status, locked_at, required_completion_date, trf_number FROM trfs WHERE id = $1 FOR UPDATE`, [body.trfId],
      );
      const trf = trfResult.rows[0];
      if (!trf) throw notFound();
      if (trf.locked_at) throw conflict('This TRF is locked and cannot be edited.');

      // Get all test requests on this TRF
      const testRequestsResult = await client.query<{ test_requested_option_id: number; test_name: string }>(
        `SELECT tro.id AS test_requested_option_id, tro.name AS test_name
         FROM trf_test_requested ttr
         JOIN test_requested_options tro ON tro.id = ttr.test_requested_option_id
         WHERE ttr.trf_id = $1`, [body.trfId],
      );
      const existingTests = testRequestsResult.rows;

      if (existingTests.length === 0) {
        throw badRequest('This TRF has no test requests to assign.', { trfId: 'Add test requests first.' });
      }

      // Validate that all requested option IDs exist on this TRF
      const existingOptionIds = new Set(existingTests.map(t => t.test_requested_option_id));
      for (const a of body.assignments) {
        if (!existingOptionIds.has(a.testRequestedOptionId)) {
          throw badRequest(`Test option ${a.testRequestedOptionId} is not on this TRF.`);
        }
      }

      const results: { assignmentId: number; version: number; testName: string }[] = [];

      for (const assignment of body.assignments) {
        // Validate analysts if any
        await Promise.all(assignment.analystIds.map((analystId) => assertValidAnalyst(analystId, client)));

        // UPSERT assignment
        const upsertResult = await client.query<{ id: number; version: number }>(`
          INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status, assigned_by, due_date, version)
          VALUES ($1, $2, $3, 'Pending Assignment', $4, $5, 1)
          ON CONFLICT (trf_id, test_requested_option_id) DO UPDATE SET
            test_name = EXCLUDED.test_name,
            due_date = EXCLUDED.due_date,
            updated_at = now()
          RETURNING id, version
        `, [body.trfId, assignment.testRequestedOptionId, assignment.testName, assigner.id, assignment.dueDate ?? trf.required_completion_date]);
        const assignmentId = upsertResult.rows[0].id;
        const version = upsertResult.rows[0].version;

        // Get current analysts
        const currentAnalysts = await client.query<{ analyst_id: number }>(
          `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId],
        );
        const currentAnalystIds = currentAnalysts.rows.map(r => r.analyst_id);
        const newAnalystIds = assignment.analystIds;
        const addedIds = newAnalystIds.filter(id => !currentAnalystIds.includes(id));
        const removedIds = currentAnalystIds.filter(id => !newAnalystIds.includes(id));

        if (addedIds.length > 0 || removedIds.length > 0) {
          await client.query(`DELETE FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId]);
          for (const analystId of newAnalystIds) {
            await client.query(
              `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id, assigned_by) VALUES ($1, $2, $3)`,
              [assignmentId, analystId, assigner.id],
            );
          }

          const action = addedIds.length > 0 && removedIds.length === 0 ? 'ASSIGNED'
            : removedIds.length > 0 && addedIds.length === 0 ? 'UNASSIGNED'
            : 'REASSIGNED';
          await client.query(
            `INSERT INTO ard_test_assignment_history (assignment_id, action, old_analyst_ids, new_analyst_ids, changed_by, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
            [assignmentId, action, currentAnalystIds, newAnalystIds, assigner.id, assignment.reason ?? null],
          );

          // Notifications for added
          for (const analystId of addedIds) {
            await createNotification(client, {
              recipientEmployeeId: analystId,
              type: 'ARD_TEST_ASSIGNED',
              title: 'New ARD Test Assigned',
              body: `You have been assigned a new analysis test: ${assignment.testName} for TRF ${trf.trf_number}.`,
              trfId: body.trfId,
              link: `/trfs/${trf.trf_number}`,
            });
          }
          // Notifications for removed
          for (const analystId of removedIds) {
            await createNotification(client, {
              recipientEmployeeId: analystId,
              type: 'ARD_TEST_REASSIGNED',
              title: 'ARD Test Reassigned',
              body: `You have been unassigned from the analysis test: ${assignment.testName} for TRF ${trf.trf_number}.`,
              trfId: body.trfId,
              link: `/trfs/${trf.trf_number}`,
            });
          }
        }

        // Audit
        await writeAudit(client, {
          userId: assigner.id, userName: assigner.fullName, action: 'assignment.bulk_upsert', module: 'assignments',
          recordType: 'ArdTestAssignment', recordRef: String(assignmentId), newValue: { testName: assignment.testName, analystIds: newAnalystIds },
        });

        results.push({ assignmentId, version, testName: assignment.testName });
      }

      return results;
    });

    res.status(201).json({ items: result });
  } catch (err) { next(err); }
});

/** PATCH /api/ard-assignments/:id - Update status, reassign analysts, or add a reason */
ardAssignmentsRouter.patch('/:id', requireAssignmentsManage(), validateBody(updateAssignmentSchema), async (req, res, next) => {
  const assigner = currentEmployee(req);
  try {
    const assignmentId = Number(req.params.id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) throw notFound();

    const body = req.body as z.infer<typeof updateAssignmentSchema>;

    const result = await withTransaction(async (client) => {
      const existing = await client.query<{ id: number; version: number; trf_id: number; status: ArdTestAssignmentStatus; due_date: string | null; test_name: string }>(
        `SELECT id, version, trf_id, status, due_date, test_name FROM ard_test_assignments WHERE id = $1 FOR UPDATE`, [assignmentId],
      );
      if (!existing.rows[0]) throw notFound();
      const assignment = existing.rows[0];
      if (assignment.version !== body.version) throw versionConflict();

      // Check TRF lock
      const trfLock = await client.query<{ locked_at: string | null }>(`SELECT locked_at FROM trfs WHERE id = $1`, [assignment.trf_id]);
      if (trfLock.rows[0]?.locked_at) throw conflict('This TRF is locked and cannot be edited.');

      // Get TRF number for notifications
      const trfNumResult = await client.query<{ trf_number: string }>(`SELECT trf_number FROM trfs WHERE id = $1`, [assignment.trf_id]);
      const trfNumber = trfNumResult.rows[0]?.trf_number ?? String(assignment.trf_id);

      let newVersion = assignment.version;

      // Get current analysts before changes
      const currentAnalysts = await client.query<{ analyst_id: number }>(
        `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId],
      );
      const currentAnalystIds = currentAnalysts.rows.map(r => r.analyst_id);

      if (body.status !== undefined) {
        // Check rule BEFORE writing: Completed/Cancelled requires at least one analyst
        if ((body.status === 'Completed' || body.status === 'Cancelled') && currentAnalystIds.length === 0) {
          throw badRequest('Cannot complete: no analysts are assigned.', { status: 'Assign analysts first.' });
        }

        await client.query(
          `INSERT INTO ard_test_assignment_history (assignment_id, action, old_status, new_status, changed_by, reason) VALUES ($1, 'STATUS_CHANGED', $2, $3, $4, $5)`,
          [assignmentId, assignment.status, body.status, assigner.id, body.reason ?? null],
        );
        await client.query(
          `UPDATE ard_test_assignments SET status = $1, version = version + 1 WHERE id = $2`,
          [body.status, assignmentId],
        );
        newVersion++;
      }

      if (body.dueDate !== undefined) {
        await client.query(
          `UPDATE ard_test_assignments SET due_date = $1, version = version + 1 WHERE id = $2`,
          [body.dueDate, assignmentId],
        );
        newVersion++;
      }

      if (body.analystIds !== undefined) {
        const newAnalystIds = body.analystIds;
        const addedIds = newAnalystIds.filter(id => !currentAnalystIds.includes(id));
        const removedIds = currentAnalystIds.filter(id => !newAnalystIds.includes(id));

        if (addedIds.length > 0 || removedIds.length > 0) {
          // Validate new analysts
          await Promise.all(newAnalystIds.map(id => assertValidAnalyst(id, client)));

          await client.query(
            `INSERT INTO ard_test_assignment_history (assignment_id, action, old_analyst_ids, new_analyst_ids, changed_by, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
            [assignmentId, 'REASSIGNED', currentAnalystIds, newAnalystIds, assigner.id, body.reason ?? null],
          );

          await client.query(`DELETE FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId]);
          for (const analystId of newAnalystIds) {
            await client.query(
              `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id, assigned_by) VALUES ($1, $2, $3)`,
              [assignmentId, analystId, assigner.id],
            );
          }

          // Notifications for added
          for (const analystId of addedIds) {
            await createNotification(client, {
              recipientEmployeeId: analystId,
              type: 'ARD_TEST_ASSIGNED',
              title: 'New ARD Test Assigned',
              body: `You have been assigned a new analysis test: ${assignment.test_name} for TRF ${trfNumber}.`,
              trfId: assignment.trf_id,
              link: `/trfs/${trfNumber}`,
            });
          }
          // Notifications for removed
          for (const analystId of removedIds) {
            await createNotification(client, {
              recipientEmployeeId: analystId,
              type: 'ARD_TEST_REASSIGNED',
              title: 'ARD Test Reassigned',
              body: `You have been unassigned from the analysis test: ${assignment.test_name} for TRF ${trfNumber}.`,
              trfId: assignment.trf_id,
              link: `/trfs/${trfNumber}`,
            });
          }
          newVersion++;
        }
      }

      // Audit
      await writeAudit(client, {
        userId: assigner.id, userName: assigner.fullName, action: 'assignment.update', module: 'assignments',
        recordType: 'ArdTestAssignment', recordRef: String(assignmentId), newValue: body,
      });

      return { trfId: assignment.trf_id, version: newVersion };
    });

    // Return updated assignment in ArdTestAssignment shape
    const updated = await pool.query<{
      id: number; trf_id: number; test_requested_option_id: number; test_name: string;
      status: ArdTestAssignmentStatus; assigned_by: number | null; assigned_at: string | null;
      due_date: string | null; created_at: string; updated_at: string; version: number;
    }>(`SELECT * FROM ard_test_assignments WHERE id = $1`, [assignmentId]);
    const analysts = await pool.query<{ id: number; full_name: string; employee_code: string; department_name: string | null; assigned_at: string }>(`
      SELECT e.id, e.full_name, e.employee_code, d.name AS department_name, ataa.assigned_at
      FROM ard_test_assignment_analysts ataa
      JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ataa.assignment_id = $1
    `, [assignmentId]);

    res.json(mapAssignment(updated.rows[0], analysts.rows));
  } catch (err) { next(err); }
});

/** PATCH /api/ard-assignments/:id/status - Update only the status (for analysts) */
ardAssignmentsRouter.patch('/:id/status', validateBody(statusUpdateSchema), async (req, res, next) => {
  const viewer = currentEmployee(req);
  try {
    const assignmentId = Number(req.params.id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) throw notFound();

    const body = req.body as z.infer<typeof statusUpdateSchema>;

    const result = await withTransaction(async (client) => {
      const existing = await client.query<{ id: number; version: number; status: ArdTestAssignmentStatus; trf_id: number; test_name: string }>(
        `SELECT id, version, status, trf_id, test_name FROM ard_test_assignments WHERE id = $1 FOR UPDATE`, [assignmentId],
      );
      if (!existing.rows[0]) throw notFound();
      const assignment = existing.rows[0];
      if (assignment.version !== body.version) throw versionConflict();

      const isManager = canManageArdAssignments(viewer.role);
      if (!isManager) {
        const analystCheck = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ard_test_assignment_analysts WHERE assignment_id = $1 AND analyst_id = $2`,
          [assignmentId, viewer.id],
        );
        if (analystCheck.rows[0].count === 0) {
          throw forbidden('You can only update assignments you are part of.');
        }
      }

      // Check rule BEFORE writing
      if ((body.status === 'Completed' || body.status === 'Cancelled')) {
        const analystCount = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId],
        );
        if (analystCount.rows[0].count === 0) {
          throw badRequest('Cannot complete: no analysts are assigned.', { status: 'Assign analysts first.' });
        }
      }

      // Get TRF number for notifications
      const trfNumResult = await client.query<{ trf_number: string }>(`SELECT trf_number FROM trfs WHERE id = $1`, [assignment.trf_id]);
      const trfNumber = trfNumResult.rows[0]?.trf_number ?? String(assignment.trf_id);

      await client.query(
        `INSERT INTO ard_test_assignment_history (assignment_id, action, old_status, new_status, changed_by, reason) VALUES ($1, 'STATUS_CHANGED', $2, $3, $4, $5)`,
        [assignmentId, assignment.status, body.status, viewer.id, body.reason ?? null],
      );
      await client.query(
        `UPDATE ard_test_assignments SET status = $1, version = version + 1 WHERE id = $2`,
        [body.status, assignmentId],
      );

      // Notify assigned analysts of status change
      const analystRows = await client.query<{ analyst_id: number }>(
        `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId],
      );
      for (const a of analystRows.rows) {
        if (a.analyst_id !== viewer.id) {
          await createNotification(client, {
            recipientEmployeeId: a.analyst_id,
            type: 'ARD_TEST_STATUS_CHANGED',
            title: 'ARD Test Status Updated',
            body: `Test "${assignment.test_name}" for TRF ${trfNumber} status changed to ${body.status}.`,
            trfId: assignment.trf_id,
            link: `/trfs/${trfNumber}`,
          });
        }
      }

      return assignment.trf_id;
    });

    // Return updated assignment
    const updated = await pool.query<{
      id: number; trf_id: number; test_requested_option_id: number; test_name: string;
      status: ArdTestAssignmentStatus; assigned_by: number | null; assigned_at: string | null;
      due_date: string | null; created_at: string; updated_at: string; version: number;
    }>(`SELECT * FROM ard_test_assignments WHERE id = $1`, [assignmentId]);
    const analysts = await pool.query<{ id: number; full_name: string; employee_code: string; department_name: string | null; assigned_at: string }>(`
      SELECT e.id, e.full_name, e.employee_code, d.name AS department_name, ataa.assigned_at
      FROM ard_test_assignment_analysts ataa
      JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ataa.assignment_id = $1
    `, [assignmentId]);

    res.json(mapAssignment(updated.rows[0], analysts.rows));
  } catch (err) { next(err); }
});

/** GET /api/ard-assignments/employee-dashboard - Get assignments for the signed-in employee */
ardAssignmentsRouter.get('/employee-dashboard', async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const result = await pool.query<{
      id: number;
      trf_id: number;
      trf_number: string;
      ar_number: string | null;
      product_name: string | null;
      generic_name: string | null;
      batch_number: string | null;
      test_requested_option_id: number;
      test_name: string;
      status: ArdTestAssignmentStatus;
      assigned_at: string | null;
      due_date: string | null;
      created_at: string;
    }>(`
      SELECT
        ata.id,
        ata.trf_id,
        t.trf_number,
        t.ard_number,
        p.name AS product_name,
        t.generic_name,
        t.batch_number,
        ata.test_requested_option_id,
        ata.test_name,
        ata.status,
        ataa.assigned_at,
        ata.due_date,
        ata.created_at
      FROM ard_test_assignments ata
      JOIN trfs t ON t.id = ata.trf_id
      JOIN products p ON p.id = t.product_id
      JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id AND ataa.analyst_id = $1
      ORDER BY ata.created_at ASC
    `, [viewer.id]);

res.json({ items: result.rows.map(row => ({
      assignmentId: row.id,
      trfId: row.trf_id,
      trfNumber: row.trf_number,
      arNumber: row.ar_number,
      productName: row.product_name,
      genericName: row.generic_name,
      batchNumber: row.batch_number,
      testRequestedOptionId: row.test_requested_option_id,
      testName: row.test_name,
      testStatus: row.status,
      // assigned_at is TIMESTAMPTZ (Date), due_date is DATE (string YYYY-MM-DD)
      assignedAt: row.assigned_at ? new Date(row.assigned_at).toISOString() : null,
      assignedBy: null,
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
      analystId: viewer.id,
      analystName: viewer.fullName,
      analystCode: viewer.employeeCode,
      analystDepartment: viewer.departmentName,
    })) });
  } catch (err) { next(err); }
});