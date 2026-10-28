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
} from '@trf/shared';
import { ARD_TEST_ASSIGNMENT_STATUSES, roleHasPermission } from '@trf/shared';
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
  analystIds: z.array(z.number().int().positive()).min(1, 'Select at least one analyst.'),
});

/** Schema for bulk assignment: one TRF, multiple tests with their own analysts */
const bulkAssignmentSchema = z.object({
  trfId: z.number().int().positive(),
  assignments: z.array(z.object({
    testRequestedOptionId: z.number().int().positive(),
    testName: z.string().trim().min(2).max(120),
    analystIds: z.array(z.number().int().positive()).min(1),
  })).min(1, 'At least one test assignment is required.'),
});

const updateAssignmentSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(ARD_TEST_ASSIGNMENT_STATUSES).optional(),
  analystIds: z.array(z.number().int().positive()).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.').nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const statusUpdateSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(ARD_TEST_ASSIGNMENT_STATUSES),
  note: z.string().trim().max(500).nullable().optional(),
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

/** Check if user can manage ARD assignments (Admin, GM, or AGM) */
function canManageArdAssignments(role: string): boolean {
  return role === 'Admin' || role === 'GM' || role === 'AGM';
}

/** GET /api/ard-assignments/trfs/:trfId - Get all test assignments for a TRF */
ardAssignmentsRouter.get('/trfs/:trfId', requirePermission('trf.view'), async (req, res, next) => {
  try {
    const trfId = Number(req.params.trfId);
    if (!Number.isInteger(trfId) || trfId <= 0) throw notFound();

    const viewer = currentEmployee(req);
    const isArdManager = canManageArdAssignments(viewer.role);

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

    // Filter for analysts - they only see their own assignments
    let items = result.rows;
    if (!isArdManager && viewer.role === 'Analyst') {
      items = items.filter(item =>
        item.analysts.some(a => a.id === viewer.id)
      );
    }

    res.json({ items });
  } catch (err) { next(err); }
});

/** POST /api/ard-assignments - Create assignments from FRD test selections */
ardAssignmentsRouter.post('/', requireAssignmentsManage(), validateBody(createAssignmentSchema), async (req, res, next) => {
  const assigner = currentEmployee(req);
  try {
    const body = req.body as z.infer<typeof createAssignmentSchema>;

    const result = await withTransaction(async (client) => {
      const trfResult = await client.query<{ workflow_status: string; final_approval_status: string; locked_at: string | null; id: number; required_completion_date: string | null }>(
        `SELECT id, workflow_status, final_approval_status, locked_at, required_completion_date FROM trfs WHERE id = $1 FOR UPDATE`, [body.trfId],
      );
      const trf = trfResult.rows[0];
      if (!trf) throw notFound();
      if (trf.locked_at) throw conflict('This TRF is locked and cannot be edited.');

      const optionResult = await client.query<{ id: number }>(
        `SELECT id FROM test_requested_options WHERE id = $1`, [body.testRequestedOptionId],
      );
      if (!optionResult.rows[0]) throw badRequest('That test is not recognised.', { testRequestedOptionId: 'Choose a test from the list.' });

      await Promise.all(body.analystIds.map((analystId) => assertValidAnalyst(analystId, client)));

      const insertResult = await client.query<{ id: number }>(
        `INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status, assigned_by, due_date)
         VALUES ($1, $2, $3, 'Pending Assignment', $4, $5) RETURNING id`,
        [body.trfId, body.testRequestedOptionId, body.testName, assigner.id, trf.required_completion_date],
      );
      const assignmentId = insertResult.rows[0].id;

      for (const analystId of body.analystIds) {
        await client.query(
          `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id, assigned_by) VALUES ($1, $2, $3)`,
          [assignmentId, analystId, assigner.id],
        );
      }

      await client.query(
        `INSERT INTO ard_test_assignment_history (assignment_id, action, new_analyst_ids, new_status, changed_by, note) VALUES ($1, 'ASSIGNED', $2, 'Pending Assignment', $3, 'Assigned')`,
        [assignmentId, body.analystIds, assigner.id],
      );

      // Create notifications for each assigned analyst
      for (const analystId of body.analystIds) {
        await createNotification(client, {
          recipientEmployeeId: analystId,
          type: 'ARD_TEST_ASSIGNED',
          title: 'New ARD Test Assigned',
          body: `You have been assigned a new analysis test: ${body.testName} for TRF ${trfResult.rows[0]?.id}.`,
          trfId: body.trfId,
          link: `/trfs/${trfResult.rows[0]?.id}`,
        });
      }

      return assignmentId;
    });

    res.status(201).json({ assignmentId: result });
  } catch (err) { next(err); }
});

/** POST /api/ard-assignments/bulk - Create assignments for all tests on a TRF in one call */
ardAssignmentsRouter.post('/bulk', requireAssignmentsManage(), validateBody(bulkAssignmentSchema), async (req, res, next) => {
  const assigner = currentEmployee(req);
  try {
    const body = req.body as z.infer<typeof bulkAssignmentSchema>;

    const result = await withTransaction(async (client) => {
      const trfResult = await client.query<{ workflow_status: string; final_approval_status: string; locked_at: string | null; id: number; required_completion_date: string | null }>(
        `SELECT id, workflow_status, final_approval_status, locked_at, required_completion_date FROM trfs WHERE id = $1 FOR UPDATE`, [body.trfId],
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

      const createdIds: number[] = [];

      for (const assignment of body.assignments) {
        await Promise.all(assignment.analystIds.map((analystId) => assertValidAnalyst(analystId, client)));

        const insertResult = await client.query<{ id: number }>(
          `INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status, assigned_by, due_date)
           VALUES ($1, $2, $3, 'Pending Assignment', $4, $5) RETURNING id`,
          [body.trfId, assignment.testRequestedOptionId, assignment.testName, assigner.id, trf.required_completion_date],
        );
        const assignmentId = insertResult.rows[0].id;
        createdIds.push(assignmentId);

        for (const analystId of assignment.analystIds) {
          await client.query(
            `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id, assigned_by) VALUES ($1, $2, $3)`,
            [assignmentId, analystId, assigner.id],
          );
        }

        await client.query(
          `INSERT INTO ard_test_assignment_history (assignment_id, action, new_analyst_ids, new_status, changed_by, note) VALUES ($1, 'ASSIGNED', $2, 'Pending Assignment', $3, 'Assigned')`,
          [assignmentId, assignment.analystIds, assigner.id],
        );

        // Create notifications for each assigned analyst
        for (const analystId of assignment.analystIds) {
          await createNotification(client, {
            recipientEmployeeId: analystId,
            type: 'ARD_TEST_ASSIGNED',
            title: 'New ARD Test Assigned',
            body: `You have been assigned a new analysis test: ${assignment.testName} for TRF ${trfResult.rows[0]?.id}.`,
            trfId: body.trfId,
            link: `/trfs/${trfResult.rows[0]?.id}`,
          });
        }
      }

      return createdIds;
    });

    res.status(201).json({ assignmentIds: result });
  } catch (err) { next(err); }
});

/** PATCH /api/ard-assignments/:id - Update status, reassign analysts, or add a note */
ardAssignmentsRouter.patch('/:id', requireAssignmentsManage(), validateBody(updateAssignmentSchema), async (req, res, next) => {
  const assigner = currentEmployee(req);
  try {
    const assignmentId = Number(req.params.id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) throw notFound();

    const body = req.body as z.infer<typeof updateAssignmentSchema>;

    await withTransaction(async (client) => {
      const existing = await client.query<{ id: number; version: number; trf_id: number; status: ArdTestAssignmentStatus; due_date: string | null; test_name: string }>(
        `SELECT id, version, trf_id, status, due_date, test_name FROM ard_test_assignments WHERE id = $1 FOR UPDATE`, [assignmentId],
      );
      if (!existing.rows[0]) throw notFound();
      const assignment = existing.rows[0];
      if (assignment.version !== body.version) throw versionConflict();

      // Get current analysts before changes
      const currentAnalysts = await client.query<{ analyst_id: number }>(
        `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId],
      );
      const currentAnalystIds = currentAnalysts.rows.map(r => r.analyst_id);

      if (body.status !== undefined) {
        await client.query(
          `INSERT INTO ard_test_assignment_history (assignment_id, action, old_status, new_status, changed_by, note) VALUES ($1, 'STATUS_CHANGED', $2, $3, $4, COALESCE($5, ''))`,
          [assignmentId, assignment.status, body.status, assigner.id, body.note ?? null],
        );
        await client.query(
          `UPDATE ard_test_assignments SET status = $1, version = version + 1 WHERE id = $2`,
          [body.status, assignmentId],
        );

        if (body.status === 'Completed' || body.status === 'Cancelled') {
          const analystCheck = await client.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId],
          );
          if (analystCheck.rows[0].count === 0) {
            throw badRequest('Cannot complete: no analysts are assigned.', { status: 'Assign analysts first.' });
          }
        }
      }

      if (body.dueDate !== undefined) {
        await client.query(
          `UPDATE ard_test_assignments SET due_date = $1, version = version + 1 WHERE id = $2`,
          [body.dueDate, assignmentId],
        );
      }

      if (body.analystIds !== undefined) {
        // Determine added and removed analysts
        const newAnalystIds = body.analystIds;
        const addedIds = newAnalystIds.filter(id => !currentAnalystIds.includes(id));
        const removedIds = currentAnalystIds.filter(id => !newAnalystIds.includes(id));

        if (addedIds.length > 0 || removedIds.length > 0) {
          await client.query(
            `INSERT INTO ard_test_assignment_history (assignment_id, action, old_analyst_ids, new_analyst_ids, changed_by, note) VALUES ($1, 'REASSIGNED', $2, $3, $4, COALESCE($5, ''))`,
            [assignmentId, currentAnalystIds, newAnalystIds, assigner.id, body.note ?? null],
          );

          await client.query(`DELETE FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId]);
          for (const analystId of newAnalystIds) {
            await assertValidAnalyst(analystId, client);
            await client.query(
              `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id, assigned_by) VALUES ($1, $2, $3)`,
              [assignmentId, analystId, assigner.id],
            );
          }

          // Create notifications for newly assigned analysts
          for (const analystId of addedIds) {
            await createNotification(client, {
              recipientEmployeeId: analystId,
              type: 'ARD_TEST_ASSIGNED',
              title: 'New ARD Test Assigned',
              body: `You have been assigned a new analysis test: ${assignment.test_name} for TRF ${assignment.trf_id}.`,
              trfId: assignment.trf_id,
              link: `/trfs/${assignment.trf_id}`,
            });
          }

          // Notify removed analysts that they were unassigned
          for (const analystId of removedIds) {
            await createNotification(client, {
              recipientEmployeeId: analystId,
              type: 'ARD_TEST_REASSIGNED',
              title: 'ARD Test Reassigned',
              body: `You have been unassigned from the analysis test: ${assignment.test_name} for TRF ${assignment.trf_id}.`,
              trfId: assignment.trf_id,
              link: `/trfs/${assignment.trf_id}`,
            });
}
        }
      }
    });

    res.json({ ok: true });
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
      const existing = await client.query<{ id: number; version: number; status: ArdTestAssignmentStatus; trf_id: number }>(
        `SELECT id, version, status, trf_id FROM ard_test_assignments WHERE id = $1 FOR UPDATE`, [assignmentId],
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

      await client.query(
        `INSERT INTO ard_test_assignment_history (assignment_id, status, changed_by, note) VALUES ($1, $2, $3, COALESCE($4, ''))`,
        [assignmentId, body.status, viewer.id, body.note ?? null],
      );
      await client.query(
        `UPDATE ard_test_assignments SET status = $1, version = version + 1 WHERE id = $2`,
        [body.status, assignmentId],
      );

      return assignment.trf_id;
    });

    res.json({ ok: true, trfId: result });
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

    res.json({ items: result.rows });
  } catch (err) { next(err); }
});