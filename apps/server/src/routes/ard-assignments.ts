import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { ARD_TEST_ASSIGNMENT_STATUSES, ARD_RESULT_OUTCOMES, roleHasPermission, canAccessAnalytical, isAdminDesignation } from '@trf/shared';
import { pool, withTransaction } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, versionConflict } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { createNotification, notifyEmployee } from '../lib/notifications.js';
import { authenticate, currentEmployee, requirePermission, requireAssignmentsManage, validateBody } from '../middleware/auth.js';
import { DOCUMENT_DIR } from '../config.js';
import { readPdfBody } from '../lib/read-pdf-body.js';

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
    id: Number(row.id),
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
    ...mapResult(row),
  };
}

/** The result columns joined onto an assignment row (all null when no result has been submitted). */
function mapResult(row: any) {
  const iso = (v: any) => (v ? new Date(v).toISOString() : null);
  const day = (v: any) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
  return {
    resultValue: row.result_value ?? null,
    resultText: row.result_text ?? null,
    unit: row.unit ?? null,
    methodUsed: row.method_used ?? null,
    specification: row.specification ?? null,
    lowerLimit: row.lower_limit ?? null,
    upperLimit: row.upper_limit ?? null,
    outcome: row.outcome ?? null,
    remarks: row.result_remarks ?? null,
    enteredBy: row.entered_by ?? null,
    enteredByName: row.entered_by_name ?? null,
    enteredAt: iso(row.entered_at),
    reviewStatus: row.review_status ?? null,
    submittedAt: iso(row.submitted_at),
    reviewedBy: row.reviewed_by ?? null,
    reviewedByName: row.reviewed_by_name ?? null,
    reviewedAt: iso(row.reviewed_at),
    reviewReason: row.review_reason ?? null,
    resultMode: row.result_mode ?? null,
    fileName: row.file_name ?? null,
    fileSize: row.file_size ?? null,
    analysisStartDate: day(row.analysis_start_date),
    completionDate: day(row.completion_date),
    completedBy: row.completed_by ?? null,
    completedByName: row.completed_by_name ?? null,
  };
}

/** The columns and joins that put a test's result next to its assignment. */
const RESULT_COLUMNS = `
        r.result_value, r.result_text, r.unit, r.method_used, r.specification, r.lower_limit, r.upper_limit,
        r.outcome, r.remarks AS result_remarks, r.entered_by, eb.full_name AS entered_by_name, r.entered_at,
        r.review_status, r.submitted_at, r.reviewed_by, rb.full_name AS reviewed_by_name, r.reviewed_at, r.review_reason,
        r.result_mode, r.file_name, r.file_size,
        ata.analysis_start_date, ata.completion_date, ata.completed_by, cb.full_name AS completed_by_name`;
const RESULT_JOINS = `
      LEFT JOIN ard_assignment_results r ON r.assignment_id = ata.id
      LEFT JOIN employees eb ON eb.id = r.entered_by
      LEFT JOIN employees rb ON rb.id = r.reviewed_by
      LEFT JOIN employees cb ON cb.id = ata.completed_by`;

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
        ata.version,${RESULT_COLUMNS},
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
      FROM ard_test_assignments ata${RESULT_JOINS}
      LEFT JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
      LEFT JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ata.trf_id = $1
      GROUP BY ata.id, r.id, eb.full_name, rb.full_name, cb.full_name
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

      // A test is completed by its approved result, not by a click: the AGM's approval is what completes it.
      if (body.status === 'Completed') {
        const approved = await client.query(
          `SELECT 1 FROM ard_assignment_results WHERE assignment_id = $1 AND review_status = 'Approved'`, [assignmentId],
        );
        if (!approved.rowCount) {
          throw new AppError(409, 'RESULT_NOT_APPROVED',
            'A test can be completed only after its result has been submitted and approved by an AGM.');
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


/* ---------------------------------------------------------------------------
 * Test results: the assigned employee submits, an AGM approves or rejects.
 *
 *   assigned employee --submit result--> [Submitted] --AGM approves--> [Approved] test Completed
 *                                              \--AGM rejects--> [Rejected] test "Re-test Required",
 *                                                                  the employee corrects and submits again
 *
 * When every test on a TRF is Completed with an approved result, the TRF is put in front of the AGM for completion
 * (final approval), exactly as if it had been submitted for it.
 * ------------------------------------------------------------------------- */

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const submitResultSchema = z.object({
  version: z.number().int().positive(),
  resultMode: z.enum(['text', 'pdf']).default('text'),
  resultValue: optionalText(200),
  resultText: optionalText(2000),
  unit: optionalText(50),
  methodUsed: optionalText(200),
  specification: optionalText(500),
  lowerLimit: optionalText(100),
  upperLimit: optionalText(100),
  outcome: z.enum(ARD_RESULT_OUTCOMES),
  remarks: optionalText(2000),
  analysisStartDate: ISO_DATE.nullable().optional(),
  completionDate: ISO_DATE.nullable().optional(),
}).superRefine((b, ctx) => {
  if (b.resultMode === 'text' && !(b.resultValue?.trim() || b.resultText?.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter the result value or the result text.', path: ['resultValue'] });
  }
});

const reviewResultSchema = z.object({
  version: z.number().int().positive(),
  decision: z.enum(['Approved', 'Rejected']),
  reason: optionalText(2000),
}).superRefine((b, ctx) => {
  if (b.decision === 'Rejected' && !b.reason?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A written reason is required when rejecting a result.', path: ['reason'] });
  }
});

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** The active administrators who hold an AGM-level designation: the people who review results and complete a TRF. */
async function agmReviewers(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { id: number }[] }> }) {
  const rows = await client.query(
    `SELECT id FROM employees WHERE role = 'Admin' AND designation IN ('AGM','GM','COO') AND is_active = TRUE`);
  return rows.rows.map((r) => r.id);
}

/** POST /api/ard-assignments/:id/result - the assigned employee submits the result of a test for AGM review. */
ardAssignmentsRouter.post('/:id/result', validateBody(submitResultSchema), async (req, res, next) => {
  const viewer = currentEmployee(req);
  try {
    const assignmentId = Number(req.params.id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) throw notFound('This test assignment could not be found.');
    const body = req.body as z.infer<typeof submitResultSchema>;

    if (viewer.role === 'Viewer') throw forbidden('A Viewer cannot submit test results.');

    const trfId = await withTransaction(async (client) => {
      const found = await client.query<{
        id: number; version: number; status: ArdTestAssignmentStatus; trf_id: number; test_name: string;
        analysis_start_date: Date | string | null;
      }>(`SELECT id, version, status, trf_id, test_name, analysis_start_date FROM ard_test_assignments WHERE id = $1 FOR UPDATE`, [assignmentId]);
      const assignment = found.rows[0];
      if (!assignment) throw notFound('This test assignment no longer exists. It may have been deleted or reassigned.');
      if (assignment.version !== body.version) throw versionConflict();

      // Only the employee the test was assigned to submits its result.
      const mine = await client.query(
        `SELECT 1 FROM ard_test_assignment_analysts WHERE assignment_id = $1 AND analyst_id = $2`, [assignmentId, viewer.id]);
      if (!mine.rowCount) throw forbidden('Only the employee this test is assigned to can submit its result.');

      const trf = (await client.query<{ trf_number: string; locked_at: Date | null; deleted_at: Date | null; remarks_status: string }>(
        `SELECT trf_number, locked_at, deleted_at, remarks_status FROM trfs WHERE id = $1 FOR UPDATE`, [assignment.trf_id])).rows[0];
      if (!trf || trf.deleted_at) throw notFound('The TRF for this test no longer exists. It may have been deleted.');
      if (trf.locked_at) throw conflict('This TRF is locked, so its results can no longer change.');
      if (trf.remarks_status !== 'Approved') {
        throw new AppError(409, 'FORMULATION_NOT_APPROVED', 'Results can be submitted only after the Formulation request is approved.');
      }

      // An assignment stays "Pending Assignment" until somebody moves it, so being on the test is what counts.
      if (assignment.status === 'Completed' || assignment.status === 'Cancelled') {
        throw new AppError(409, 'TEST_NOT_OPEN', assignment.status === 'Completed'
          ? 'This test is already completed: its result was approved.'
          : 'This test was cancelled, so no result can be submitted.');
      }

      const existing = (await client.query<{ review_status: string; file_relative_path: string | null; file_name: string | null; file_size: number | null }>(
        `SELECT review_status, file_relative_path, file_name, file_size FROM ard_assignment_results WHERE assignment_id = $1 FOR UPDATE`, [assignmentId])).rows[0];
      if (existing?.review_status === 'Submitted') {
        throw new AppError(409, 'RESULT_AWAITING_REVIEW', 'A result for this test is already waiting for AGM review.');
      }

      // In pdf mode a PDF file must already be attached to this assignment.
      const isPdf = body.resultMode === 'pdf';
      if (isPdf && !existing?.file_relative_path) {
        throw badRequest('Upload a PDF file first, then submit the result.', { resultFile: 'Upload a PDF file first.' });
      }

      const today = new Date().toISOString().slice(0, 10);
      const existingStart = assignment.analysis_start_date
        ? (assignment.analysis_start_date instanceof Date ? assignment.analysis_start_date.toISOString().slice(0, 10) : String(assignment.analysis_start_date).slice(0, 10))
        : null;
      const start = body.analysisStartDate ?? existingStart ?? today;
      const completion = body.completionDate ?? today;
      if (completion < start) {
        throw badRequest('The completion date cannot be before the analysis start date.', { completionDate: 'Choose a date on or after the start date.' });
      }

      // Text mode replaces the file with text; pdf mode replaces the text with the file.
      const resultValue = isPdf ? null : blank(body.resultValue);
      const resultText = isPdf ? null : blank(body.resultText);
      const fileRelPath = isPdf ? existing!.file_relative_path : null;
      const fileName = isPdf ? existing!.file_name : null;
      const fileSize = isPdf ? existing!.file_size : null;

      await client.query(
        `INSERT INTO ard_assignment_results
           (assignment_id, result_value, result_text, unit, method_used, specification, lower_limit, upper_limit,
            outcome, remarks, entered_by, entered_at, review_status, submitted_at, reviewed_by, reviewed_at, review_reason,
            result_mode, file_relative_path, file_name, file_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), 'Submitted', now(), NULL, NULL, NULL,
                 $12, $13, $14, $15)
         ON CONFLICT (assignment_id) DO UPDATE SET
           result_value = EXCLUDED.result_value, result_text = EXCLUDED.result_text, unit = EXCLUDED.unit,
           method_used = EXCLUDED.method_used, specification = EXCLUDED.specification,
           lower_limit = EXCLUDED.lower_limit, upper_limit = EXCLUDED.upper_limit, outcome = EXCLUDED.outcome,
           remarks = EXCLUDED.remarks, entered_by = EXCLUDED.entered_by, entered_at = now(),
           review_status = 'Submitted', submitted_at = now(), reviewed_by = NULL, reviewed_at = NULL, review_reason = NULL,
           result_mode = EXCLUDED.result_mode,
           file_relative_path = EXCLUDED.file_relative_path, file_name = EXCLUDED.file_name, file_size = EXCLUDED.file_size`,
        [assignmentId, resultValue, resultText, blank(body.unit), blank(body.methodUsed),
         blank(body.specification), blank(body.lowerLimit), blank(body.upperLimit), body.outcome, blank(body.remarks), viewer.id,
         body.resultMode, fileRelPath, fileName, fileSize],
      );

      await client.query(
        `UPDATE ard_test_assignments
            SET status = 'In Progress', analysis_start_date = $2, completion_date = $3, completed_by = $4, version = version + 1
          WHERE id = $1`,
        [assignmentId, start, completion, viewer.id],
      );

      await client.query(
        `INSERT INTO ard_test_assignment_history (assignment_id, action, old_status, new_status, changed_by, reason)
         VALUES ($1, $2, $3, 'In Progress', $4, $5)`,
        [assignmentId, existing ? 'RESULT_CHANGED' : 'RESULT_ENTERED', assignment.status, viewer.id, body.remarks ?? null],
      );

      await writeAudit(client, {
        userId: viewer.id, userName: viewer.fullName, action: 'ard_assignment.result_submitted', module: 'trf',
        recordType: 'TRF', recordRef: trf.trf_number,
        oldValue: { testStatus: assignment.status, resultReview: existing?.review_status ?? null },
        newValue: {
          test: assignment.test_name, outcome: body.outcome, resultValue: blank(body.resultValue), unit: blank(body.unit),
          resultMode: body.resultMode, fileName: isPdf ? fileName : null, resubmission: !!existing,
        },
      });

      for (const agmId of await agmReviewers(client)) {
        if (agmId === viewer.id) continue;
        await notifyEmployee(client, agmId, 'result_review_needed', 'Test result waiting for your review',
          `${viewer.fullName} submitted the result of "${assignment.test_name}" for TRF ${trf.trf_number}.`, assignment.trf_id);
      }
      return assignment.trf_id;
    });

    res.json(await loadAssignment(assignmentId, trfId));
  } catch (err) { next(err); }
});

/**
 * POST /api/ard-assignments/:id/result-file - the assigned employee uploads a PDF
 * result file. The server generates the filename and stores it under
 * DOCUMENT_DIR/ard-results/. Only while the assignment is not Completed/Cancelled
 * and no result is currently awaiting review.
 */
ardAssignmentsRouter.post('/:id/result-file', async (req, res, next) => {
  const viewer = currentEmployee(req);
  try {
    const assignmentId = Number(req.params.id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) throw notFound('This test assignment could not be found.');

    if (viewer.role === 'Viewer') throw forbidden('A Viewer cannot upload test result files.');

    // Quick assignee check before reading the (potentially large) body.
    const quickCheck = await pool.query(
      `SELECT 1 FROM ard_test_assignment_analysts WHERE assignment_id = $1 AND analyst_id = $2`, [assignmentId, viewer.id]);
    if (!quickCheck.rowCount) throw forbidden('Only the employee this test is assigned to can upload its result file.');

    // Read the PDF body (rejects on Content-Length and while reading).
    const MAX_SIZE = 10 * 1024 * 1024;
    const pdfBuffer = await readPdfBody(req, MAX_SIZE);

    const trfId = await withTransaction(async (client) => {
      const found = await client.query<{ id: number; status: ArdTestAssignmentStatus; trf_id: number; test_name: string }>(
        `SELECT id, status, trf_id, test_name FROM ard_test_assignments WHERE id = $1 FOR UPDATE`, [assignmentId]);
      const assignment = found.rows[0];
      if (!assignment) throw notFound();

      // Re-check assignee inside the transaction for consistency.
      const mine = await client.query(
        `SELECT 1 FROM ard_test_assignment_analysts WHERE assignment_id = $1 AND analyst_id = $2`, [assignmentId, viewer.id]);
      if (!mine.rowCount) throw forbidden('Only the employee this test is assigned to can upload its result file.');

      const trf = (await client.query<{ locked_at: Date | null; deleted_at: Date | null; trf_number: string }>(
        `SELECT locked_at, deleted_at, trf_number FROM trfs WHERE id = $1 FOR UPDATE`, [assignment.trf_id])).rows[0];
      if (!trf || trf.deleted_at) throw notFound();
      if (trf.locked_at) throw conflict('This TRF is locked, so its results can no longer change.');

      if (assignment.status === 'Completed' || assignment.status === 'Cancelled') {
        throw new AppError(409, 'TEST_NOT_OPEN', 'This test is not open for file upload.');
      }

      // A result waiting for review cannot have its file replaced.
      const existing = (await client.query<{ review_status: string }>(
        `SELECT review_status FROM ard_assignment_results WHERE assignment_id = $1 FOR UPDATE`, [assignmentId])).rows[0];
      if (existing?.review_status === 'Submitted') {
        throw new AppError(409, 'RESULT_AWAITING_REVIEW', 'A result for this test is already waiting for AGM review.');
      }

      // Save file under DOCUMENT_DIR/ard-results/ with a server-generated name.
      const ardResultsDir = path.join(DOCUMENT_DIR, 'ard-results');
      await fs.promises.mkdir(ardResultsDir, { recursive: true });
      const randomSuffix = crypto.randomBytes(8).toString('hex');
      const generatedFileName = `${assignmentId}-${randomSuffix}.pdf`;
      const relativePath = path.join('ard-results', generatedFileName);
      const absolutePath = path.join(DOCUMENT_DIR, relativePath);
      const resolvedPath = path.resolve(absolutePath);
      const resolvedDir = path.resolve(ardResultsDir);
      if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Generated path escapes document directory.');
      }
      await fs.promises.writeFile(resolvedPath, pdfBuffer);

      // Store file info in ard_assignment_results (UPSERT).
      await client.query(
        `INSERT INTO ard_assignment_results (assignment_id, result_mode, file_relative_path, file_name, file_size)
         VALUES ($1, 'pdf', $2, $3, $4)
         ON CONFLICT (assignment_id) DO UPDATE SET
           result_mode = 'pdf', file_relative_path = $2, file_name = $3, file_size = $4`,
        [assignmentId, relativePath, generatedFileName, pdfBuffer.length],
      );

      await client.query(
        `INSERT INTO ard_test_assignment_history (assignment_id, action, changed_by)
         VALUES ($1, 'RESULT_FILE_UPLOADED', $2)`,
        [assignmentId, viewer.id],
      );

      await writeAudit(client, {
        userId: viewer.id, userName: viewer.fullName, action: 'ard_assignment.result_file_uploaded', module: 'trf',
        recordType: 'TRF', recordRef: trf.trf_number,
        newValue: { test: assignment.test_name, fileName: generatedFileName, fileSize: pdfBuffer.length },
      });

      return assignment.trf_id;
    });

    res.status(201).json({ ok: true, assignmentId, trfId });
  } catch (err) { next(err); }
});

/**
 * GET /api/ard-assignments/:id/result-file - stream the PDF result file.
 * Allowed for: the assigned analyst(s), users holding assignments.viewAll, and
 * AGM-level reviewers (Admin with designation AGM/GM/COO). Everyone else gets 404.
 */
ardAssignmentsRouter.get('/:id/result-file', async (req, res, next) => {
  const viewer = currentEmployee(req);
  try {
    const assignmentId = Number(req.params.id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) throw notFound();

    const row = (await pool.query<{ trf_id: number; trf_number: string; file_relative_path: string; file_name: string }>(
      `SELECT ata.trf_id, t.trf_number, r.file_relative_path, r.file_name
         FROM ard_assignment_results r
         JOIN ard_test_assignments ata ON ata.id = r.assignment_id
         JOIN trfs t ON t.id = ata.trf_id
        WHERE r.assignment_id = $1 AND r.file_relative_path IS NOT NULL`, [assignmentId])).rows[0];
    if (!row) throw notFound();

    // Check access: assigned analyst, assignments.viewAll, or AGM reviewer.
    const isAgm = viewer.role === 'Admin' && isAdminDesignation(viewer.designation);
    const canViewAll = roleHasPermission(viewer.role, 'assignments.viewAll');
    if (!isAgm && !canViewAll) {
      const mine = await pool.query(
        `SELECT 1 FROM ard_test_assignment_analysts WHERE assignment_id = $1 AND analyst_id = $2`, [assignmentId, viewer.id]);
      if (!mine.rowCount) throw notFound();
    }

    // Resolve path and verify it stays inside DOCUMENT_DIR/ard-results/.
    const ardResultsDir = path.join(DOCUMENT_DIR, 'ard-results');
    const absolutePath = path.join(DOCUMENT_DIR, row.file_relative_path);
    const resolvedPath = path.resolve(absolutePath);
    const resolvedDir = path.resolve(ardResultsDir);
    if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
      throw notFound();
    }

    try {
      await fs.promises.access(resolvedPath, fs.constants.R_OK);
    } catch {
      throw notFound();
    }

    // Sanitize filename for Content-Disposition (RFC 5987).
    const sanitizedName = row.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const encodedName = encodeURIComponent(sanitizedName).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedName}"; filename*=UTF-8''${encodedName}`);

    // Audit the download.
    await withTransaction(async (client) => {
      await writeAudit(client, {
        userId: viewer.id, userName: viewer.fullName, action: 'ard_assignment.result_file_downloaded', module: 'trf',
        recordType: 'TRF', recordRef: row.trf_number,
        newValue: { fileName: row.file_name },
      });
    });

    const fileStream = fs.createReadStream(resolvedPath);
    fileStream.on('error', (err) => next(err));
    fileStream.pipe(res);
  } catch (err) { next(err); }
});

/** POST /api/ard-assignments/:id/result/review - an AGM approves or rejects a submitted result. */
ardAssignmentsRouter.post('/:id/result/review', validateBody(reviewResultSchema), async (req, res, next) => {
  const reviewer = currentEmployee(req);
  try {
    const assignmentId = Number(req.params.id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) throw notFound();
    const body = req.body as z.infer<typeof reviewResultSchema>;

    if (req.accountId) throw forbidden('Team accounts cannot review test results.');
    if (reviewer.role !== 'Admin' || !isAdminDesignation(reviewer.designation)) {
      throw forbidden('Only an Admin with AGM, GM, or COO designation can approve or reject a test result.');
    }
    const reason = body.reason?.trim() ?? '';
    if (body.decision === 'Rejected' && reason.length < 10) {
      throw badRequest('A rejection needs a reason of at least 10 characters.', { reason: 'Enter a reason of at least 10 characters.' });
    }

    const { trfId, readyForCompletion } = await withTransaction(async (client) => {
      const found = await client.query<{ id: number; version: number; status: ArdTestAssignmentStatus; trf_id: number; test_name: string }>(
        `SELECT id, version, status, trf_id, test_name FROM ard_test_assignments WHERE id = $1 FOR UPDATE`, [assignmentId]);
      const assignment = found.rows[0];
      if (!assignment) throw notFound();
      if (assignment.version !== body.version) throw versionConflict();

      const trf = (await client.query<{
        id: number; version: number; trf_number: string; locked_at: Date | null; deleted_at: Date | null; remarks_status: string;
        workflow_status: string; final_approval_status: string; created_by: number | null;
      }>(`SELECT id, version, trf_number, locked_at, deleted_at, remarks_status, workflow_status, final_approval_status, created_by
            FROM trfs WHERE id = $1 FOR UPDATE`, [assignment.trf_id])).rows[0];
      if (!trf || trf.deleted_at) throw notFound();
      if (trf.locked_at) throw conflict('This TRF is locked, so its results can no longer change.');

      const result = (await client.query<{ review_status: string; entered_by: number | null }>(
        `SELECT review_status, entered_by FROM ard_assignment_results WHERE assignment_id = $1 FOR UPDATE`, [assignmentId])).rows[0];
      if (!result) throw new AppError(409, 'NO_RESULT', 'No result has been submitted for this test.');
      if (result.review_status !== 'Submitted') {
        throw new AppError(409, 'RESULT_NOT_AWAITING_REVIEW', `This result is already ${result.review_status.toLowerCase()}.`);
      }

      const approved = body.decision === 'Approved';
      const newStatus: ArdTestAssignmentStatus = approved ? 'Completed' : 'Re-test Required';

      await client.query(
        `UPDATE ard_assignment_results
            SET review_status = $2, reviewed_by = $3, reviewed_at = now(), review_reason = $4
          WHERE assignment_id = $1`,
        [assignmentId, body.decision, reviewer.id, reason || null]);
      await client.query(
        `UPDATE ard_test_assignments SET status = $2, version = version + 1 WHERE id = $1`, [assignmentId, newStatus]);
      await client.query(
        `INSERT INTO ard_test_assignment_history (assignment_id, action, old_status, new_status, changed_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [assignmentId, approved ? 'RESULT_APPROVED' : 'RESULT_REJECTED', assignment.status, newStatus, reviewer.id, reason || null]);

      await writeAudit(client, {
        userId: reviewer.id, userName: reviewer.fullName,
        action: approved ? 'ard_assignment.result_approved' : 'ard_assignment.result_rejected', module: 'trf',
        recordType: 'TRF', recordRef: trf.trf_number,
        oldValue: { testStatus: assignment.status, resultReview: 'Submitted' },
        newValue: { test: assignment.test_name, decision: body.decision, testStatus: newStatus, reason: reason || null },
      });

      // Tell the people who did the work.
      const analystRows = await client.query<{ analyst_id: number }>(
        `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1`, [assignmentId]);
      const toTell = new Set<number>(analystRows.rows.map((r) => r.analyst_id));
      if (result.entered_by) toTell.add(result.entered_by);
      toTell.delete(reviewer.id);
      for (const id of toTell) {
        await notifyEmployee(client, id,
          approved ? 'result_approved' : 'result_rejected',
          approved ? 'Your test result was approved' : 'Your test result was rejected',
          approved
            ? `${reviewer.fullName} approved the result of "${assignment.test_name}" for TRF ${trf.trf_number}.`
            : `${reviewer.fullName} rejected the result of "${assignment.test_name}" for TRF ${trf.trf_number}. Reason: ${reason}`,
          assignment.trf_id);
      }

      // The last approval puts the TRF in front of the AGM for completion.
      let ready = false;
      if (approved) {
        const open = await client.query<{ blocking: number; total: number }>(
          `SELECT COUNT(*) FILTER (WHERE ata.status <> 'Completed' OR COALESCE(r.review_status, '') <> 'Approved')::int AS blocking,
                  COUNT(*)::int AS total
             FROM ard_test_assignments ata
             LEFT JOIN ard_assignment_results r ON r.assignment_id = ata.id
            WHERE ata.trf_id = $1 AND ata.status <> 'Cancelled'`, [assignment.trf_id]);
        const canSubmit = open.rows[0].total > 0 && open.rows[0].blocking === 0
          && trf.remarks_status === 'Approved'
          && trf.final_approval_status !== 'Pending' && trf.final_approval_status !== 'Approved';
        if (canSubmit) {
          const submittedBy = result.entered_by ?? reviewer.id;
          const note = 'All test results approved';
          await client.query(
            `UPDATE trfs SET workflow_status = 'Completed', final_approval_status = 'Pending',
                    ard_submitted_at = now(), ard_submitted_by = $2, ard_submit_note = $3, version = version + 1
              WHERE id = $1`, [assignment.trf_id, submittedBy, note]);
          await client.query(
            `INSERT INTO trf_approvals (trf_id, track, status, requested_by_employee_id, requested_by_account_id, decided_by, decided_at, reason, version)
             VALUES ($1, 'ARD', 'Pending', $2, NULL, NULL, NULL, $3, $4)`,
            [assignment.trf_id, submittedBy, note, trf.version + 1]);
          await client.query(
            `INSERT INTO ard_status_history (trf_id, old_status, new_status, changed_by, note) VALUES ($1, $2, 'Completed', $3, $4)`,
            [assignment.trf_id, trf.workflow_status, reviewer.id, note]);
          await writeAudit(client, {
            userId: reviewer.id, userName: reviewer.fullName, action: 'trf.ard_submitted', module: 'trf',
            recordType: 'TRF', recordRef: trf.trf_number,
            oldValue: { finalApprovalStatus: trf.final_approval_status, workflowStatus: trf.workflow_status },
            newValue: { finalApprovalStatus: 'Pending', workflowStatus: 'Completed', note },
          });
          for (const agmId of await agmReviewers(client)) {
            await notifyEmployee(client, agmId, 'final_approval_needed', 'TRF ready to complete',
              `Every test result on TRF ${trf.trf_number} is approved. It is ready for you to complete.`, assignment.trf_id);
          }
          ready = true;
        }
      }
      return { trfId: assignment.trf_id, readyForCompletion: ready };
    });

    res.json({ assignment: await loadAssignment(assignmentId, trfId), readyForCompletion });
  } catch (err) { next(err); }
});

/** GET /api/ard-assignments/result-reviews - submitted results waiting for the signed-in AGM, oldest first. */
ardAssignmentsRouter.get('/result-reviews', async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    if (req.accountId || viewer.role !== 'Admin' || !isAdminDesignation(viewer.designation)) {
      throw forbidden('Only an Admin with AGM, GM, or COO designation can review test results.');
    }
    const rows = await pool.query<{
      assignment_id: number; assignment_version: number; trf_id: number; trf_number: string; product_name: string | null;
      batch_number: string | null; test_name: string; result_value: string | null; result_text: string | null;
      unit: string | null; outcome: 'Pass' | 'Fail' | 'NA' | null; submitted_at: Date | null; submitted_by_name: string | null;
      result_mode: string | null; file_name: string | null;
    }>(`
      SELECT ata.id AS assignment_id, ata.version AS assignment_version, t.id AS trf_id, t.trf_number,
             p.name AS product_name, t.batch_number, ata.test_name, r.result_value, r.result_text, r.unit, r.outcome,
             r.submitted_at, eb.full_name AS submitted_by_name, r.result_mode, r.file_name
        FROM ard_assignment_results r
        JOIN ard_test_assignments ata ON ata.id = r.assignment_id
        JOIN trfs t ON t.id = ata.trf_id AND t.deleted_at IS NULL AND t.locked_at IS NULL
        LEFT JOIN products p ON p.id = t.product_id
        LEFT JOIN employees eb ON eb.id = r.entered_by
       WHERE r.review_status = 'Submitted' AND ata.status <> 'Cancelled'
       ORDER BY r.submitted_at ASC`);
    res.json({ items: rows.rows.map((r) => ({
      assignmentId: Number(r.assignment_id), assignmentVersion: r.assignment_version, trfId: r.trf_id, trfNumber: r.trf_number,
      productName: r.product_name, batchNumber: r.batch_number, testName: r.test_name,
      resultValue: r.result_value, resultText: r.result_text, unit: r.unit, outcome: r.outcome,
      submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, submittedByName: r.submitted_by_name,
      resultMode: r.result_mode, fileName: r.file_name,
    })) });
  } catch (err) { next(err); }
});

/** One assignment with its analysts and its result, in the shape the screens use. */
async function loadAssignment(assignmentId: number, _trfId: number) {
  const updated = await pool.query(
    `SELECT ata.*,${RESULT_COLUMNS}
       FROM ard_test_assignments ata${RESULT_JOINS}
      WHERE ata.id = $1`, [assignmentId]);
  const analysts = await pool.query(`
    SELECT e.id, e.full_name, e.employee_code, d.name AS department_name, ataa.assigned_at
      FROM ard_test_assignment_analysts ataa
      JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
      LEFT JOIN departments d ON d.id = e.department_id
     WHERE ataa.assignment_id = $1`, [assignmentId]);
  return mapAssignment(updated.rows[0], analysts.rows);
}

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
      version: number;
    } & Record<string, any>>(`
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
        ata.created_at,
        ata.version,${RESULT_COLUMNS}
      FROM ard_test_assignments ata
      JOIN trfs t ON t.id = ata.trf_id
      JOIN products p ON p.id = t.product_id
      JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id AND ataa.analyst_id = $1${RESULT_JOINS}
      ORDER BY ata.created_at ASC
    `, [viewer.id]);

res.json({ items: result.rows.map(row => ({
      assignmentId: Number(row.id),
      trfId: row.trf_id,
      trfNumber: row.trf_number,
      arNumber: row.ard_number,
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
      assignmentVersion: row.version,
      ...mapResult(row),
    })) });
  } catch (err) { next(err); }
});

/**
 * GET /api/ard-assignments/team-workload - per-employee assignment counts for
 * the ARD team. Only users with assignments.manage (Manager/Admin) may call it.
 */
ardAssignmentsRouter.get('/team-workload', async (req, res, next) => {
  try {
    if (!roleHasPermission(currentEmployee(req).role, 'assignments.manage')) {
      throw forbidden('Only a Manager or Admin may view team workload.');
    }
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query<{
      employee_id: number;
      full_name: string;
      employee_code: string;
      assigned: string;
      in_progress: string;
      submitted: string;
      approved: string;
      rejected: string;
      overdue: string;
    }>(`
      SELECT e.id AS employee_id, e.full_name, e.employee_code,
        COUNT(*) FILTER (WHERE ata.status = 'Assigned') AS assigned,
        COUNT(*) FILTER (WHERE ata.status = 'In Progress' OR ata.status = 'Re-test Required') AS in_progress,
        COUNT(*) FILTER (WHERE r.review_status = 'Submitted') AS submitted,
        COUNT(*) FILTER (WHERE r.review_status = 'Approved') AS approved,
        COUNT(*) FILTER (WHERE r.review_status = 'Rejected') AS rejected,
        COUNT(*) FILTER (WHERE ata.due_date IS NOT NULL AND ata.due_date < $1 AND ata.status <> 'Completed' AND ata.status <> 'Cancelled') AS overdue
      FROM ard_test_assignment_analysts ataa
      JOIN employees e ON e.id = ataa.analyst_id
      JOIN ard_test_assignments ata ON ata.id = ataa.assignment_id
      LEFT JOIN ard_assignment_results r ON r.assignment_id = ata.id
      WHERE ata.status <> 'Cancelled'
      GROUP BY e.id, e.full_name, e.employee_code
      ORDER BY e.full_name
    `, [today]);
    res.json({ items: result.rows.map((r) => ({
      employeeId: Number(r.employee_id),
      fullName: r.full_name,
      employeeCode: r.employee_code,
      assigned: Number(r.assigned),
      inProgress: Number(r.in_progress),
      submitted: Number(r.submitted),
      approved: Number(r.approved),
      rejected: Number(r.rejected),
      overdue: Number(r.overdue),
    })) });
  } catch (err) { next(err); }
});