import { Router } from 'express';
import { z } from 'zod';
import type { AnalysisFilters, AnalysisPage, AnalysisSummary, EmployeeProfile, TrfStatus } from '@trf/shared';
import {
  ANALYSIS_STATUS_TRANSITIONS, canTransitionAnalysis, canTransitionTrf, MESSAGES, roleHasPermission,
} from '@trf/shared';
import { pool, withTransaction } from '../db';
import { badRequest, conflict, forbidden, notFound, versionConflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  ANALYSIS_FROM, ANALYSIS_SELECT, ANALYSIS_SORT_SQL, AnalysisRow, OUTCOME_SQL,
  analysisListQuerySchema, buildAnalysisWhere, toAnalysisFilters, toAnalysisItem,
} from '../lib/analysis-query';
import { authenticate, currentEmployee, invalidateEmployeeCache, requirePermission, validateBody } from '../middleware/auth';

export const analysisRouter = Router();
analysisRouter.use(authenticate);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

/** A decimal the analyst typed: no exponent, no thousands separator, at most 4 decimals. */
const DECIMAL = z.string().trim()
  .regex(/^-?\d{1,10}(\.\d{1,4})?$/, 'Enter a number, for example 12.5');

const resultSchema = z.object({
  version: z.number().int().positive(),
  resultValue: DECIMAL.nullable().optional(),
  resultText: z.string().trim().max(200).nullable().optional(),
  unit: z.string().trim().max(30).nullable().optional(),
  methodUsed: z.string().trim().max(120).nullable().optional(),
  lowerLimit: DECIMAL.nullable().optional(),
  upperLimit: DECIMAL.nullable().optional(),
  remarks: z.string().trim().max(1000).nullable().optional(),
}).refine((b) => b.resultValue ?? b.resultText, {
  message: 'Enter the result: a number, or the reading as text.',
  path: ['resultValue'],
});

const actionSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().max(500).nullable().optional(),
});

/** Analysts see their own work; roles holding analysis.viewAll see everything. */
const scopeFor = (viewer: EmployeeProfile): { employeeId: number } | null =>
  roleHasPermission(viewer.role, 'analysis.viewAll') ? null : { employeeId: viewer.id };

analysisRouter.get('/', requirePermission('analysis.view'), async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const q = analysisListQuerySchema.parse(req.query);
    const filters: AnalysisFilters = toAnalysisFilters(q);

    const params: unknown[] = [];
    // An Analyst can only ever narrow to themselves, whatever the query says.
    const scope = filters.mineOnly
      ? { employeeId: viewer.id }
      : scopeFor(viewer);
    const whereSql = buildAnalysisWhere(filters, params, scope);

    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count ${ANALYSIS_FROM} ${whereSql}`, params);
    const total = Number(countResult.rows[0].count);

    const sortColumn = ANALYSIS_SORT_SQL[filters.sortBy];
    const dir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
    const rows = await pool.query<AnalysisRow>(
      `SELECT ${ANALYSIS_SELECT} ${ANALYSIS_FROM} ${whereSql}
       ORDER BY ${sortColumn} ${dir} NULLS LAST, a.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );

    const body: AnalysisPage = {
      items: rows.rows.map(toAnalysisItem),
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

/** Counts for the header, over the same scope as the list, in one pass. */
analysisRouter.get('/summary', requirePermission('analysis.view'), async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const q = analysisListQuerySchema.parse(req.query);
    const filters: AnalysisFilters = toAnalysisFilters(q);
    const params: unknown[] = [];
    const scope = filters.mineOnly ? { employeeId: viewer.id } : scopeFor(viewer);
    const whereSql = buildAnalysisWhere(filters, params, scope);

    const result = await pool.query<{
      total: string; in_progress: string; completed: string; re_test: string;
      delayed: string; passed: string; failed: string;
    }>(
      `SELECT count(*)::text AS total,
         count(*) FILTER (WHERE a.status = 'In Progress')::text AS in_progress,
         count(*) FILTER (WHERE a.status = 'Completed')::text AS completed,
         count(*) FILTER (WHERE a.status = 'Re-test Required')::text AS re_test,
         count(*) FILTER (WHERE a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE
                            AND a.status NOT IN ('Completed', 'Cancelled'))::text AS delayed,
         count(*) FILTER (WHERE (${OUTCOME_SQL}) = 'Pass')::text AS passed,
         count(*) FILTER (WHERE (${OUTCOME_SQL}) = 'Fail')::text AS failed
       ${ANALYSIS_FROM} ${whereSql}`,
      params,
    );
    const row = result.rows[0];
    const summary: AnalysisSummary = {
      total: Number(row.total), inProgress: Number(row.in_progress), completed: Number(row.completed),
      reTestRequired: Number(row.re_test), delayed: Number(row.delayed),
      passed: Number(row.passed), failed: Number(row.failed),
    };
    res.json(summary);
  } catch (err) {
    if (err instanceof z.ZodError) return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    next(err);
  }
});

async function loadItem(id: number): Promise<AnalysisRow> {
  const result = await pool.query<AnalysisRow>(
    `SELECT ${ANALYSIS_SELECT} ${ANALYSIS_FROM} WHERE a.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw notFound();
  return row;
}

analysisRouter.get('/tests/:id', requirePermission('analysis.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const viewer = currentEmployee(req);
    const row = await loadItem(id);
    if (!roleHasPermission(viewer.role, 'analysis.viewAll') && row.assigned_employee_id !== viewer.id) {
      throw forbidden();
    }
    res.json(toAnalysisItem(row));
  } catch (err) {
    next(err);
  }
});

/**
 * Only the analyst the test is assigned to may record work on it. A Manager may
 * reassign the test (Phase 4) but may not enter results on someone's behalf, so
 * the number always belongs to a named person.
 */
function assertCanRecord(row: AnalysisRow, viewer: EmployeeProfile): void {
  if (!roleHasPermission(viewer.role, 'analysis.enterResults')) throw forbidden();
  if (row.assigned_employee_id !== viewer.id) throw forbidden();
}

function assertTransitionAllowed(status: AnalysisRow['status'], to: AnalysisRow['status']): void {
  if (canTransitionAnalysis(status, to)) return;
  const allowed = ANALYSIS_STATUS_TRANSITIONS[status];
  throw conflict(allowed.length
    ? `A test that is ${status} can only change to: ${allowed.join(', ')}.`
    : `A test that is ${status} cannot change status any further.`);
}

/**
 * Locks the test row, then checks version, status and ownership before applying
 * anything. Locking first is what makes "read the current state, then write the
 * new one" a single step for two analysts pressing the same button.
 */
async function withLockedTest(
  id: number,
  version: number,
  viewer: EmployeeProfile,
  assertAllowed: (current: AnalysisRow) => void,
  apply: (client: import('pg').PoolClient, current: AnalysisRow) => Promise<unknown>,
): Promise<unknown> {
  const testId = Number(id);
  if (!Number.isInteger(testId) || testId <= 0) throw notFound();
  return withTransaction(async (client) => {
    const locked = await client.query<AnalysisRow>(
      `SELECT ${ANALYSIS_SELECT} ${ANALYSIS_FROM} WHERE a.id = $1 FOR UPDATE OF a`, [testId]);
    const current = locked.rows[0];
    if (!current) throw notFound();
    if (current.version !== version) throw versionConflict();
    assertAllowed(current);
    assertCanRecord(current, viewer);
    return apply(client, current);
  });
}

/** For a real status change: the transition table decides. */
const assertTransition = (to: AnalysisRow['status']) => (current: AnalysisRow) =>
  assertTransitionAllowed(current.status, to);

/** For recording a result, which does not move the status: only finished work is refused. */
const assertStillOpen = (current: AnalysisRow) => {
  if (current.status === 'Completed' || current.status === 'Cancelled') {
    throw conflict(`A test that is ${current.status} cannot be changed. Ask for a re-test instead.`);
  }
};

analysisRouter.post('/tests/:id/start', requirePermission('analysis.changeStatus'), validateBody(actionSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const { version, note } = req.body as z.infer<typeof actionSchema>;
    const id = Number(req.params.id);

    await withLockedTest(id, version, user, assertTransition('In Progress'), async (client, current) => {
      // Starting the same test again keeps the original start date, so the
      // turnaround time still measures the whole job.
      await client.query(
        `UPDATE analysis_tests
         SET status = 'In Progress', start_date = COALESCE(start_date, CURRENT_DATE),
             completion_date = NULL, version = version + 1
         WHERE id = $1`,
        [id],
      );
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'analysis.started', module: 'analysis',
        recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
        oldValue: { status: current.status }, newValue: { status: 'In Progress', note: note ?? null },
      });
      // Work actually starting is what moves the TRF on, the same way assigning
      // tests moved it to Assigned. Nobody has to remember a second step.
      await moveTrf(client, current, user, 'In Progress', `Analysis started: ${current.test_name}`);
      return true;
    });

    res.json(toAnalysisItem(await loadItem(id)));
  } catch (err) {
    next(err);
  }
});

analysisRouter.put('/tests/:id/result', requirePermission('analysis.enterResults'), validateBody(resultSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    const body = req.body as z.infer<typeof resultSchema>;

    if (body.lowerLimit && body.upperLimit && Number(body.lowerLimit) > Number(body.upperLimit)) {
      throw badRequest('The lower limit cannot be greater than the upper limit.', {
        lowerLimit: 'The lower limit cannot be greater than the upper limit.',
      });
    }
    if (!body.resultValue && (body.lowerLimit || body.upperLimit)) {
      throw badRequest('A numeric result is needed to compare against limits.', {
        resultValue: 'Enter the result as a number, or clear the limits.',
      });
    }

    await withLockedTest(id, body.version, user, assertStillOpen, async (client, current) => {
      const saved = await client.query<{ id: number }>(
        `INSERT INTO analysis_results (analysis_test_id, result_value, result_text, unit, method_used,
            lower_limit, upper_limit, remarks, entered_by, entered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (analysis_test_id) DO UPDATE SET
            result_value = EXCLUDED.result_value, result_text = EXCLUDED.result_text,
            unit = EXCLUDED.unit, method_used = EXCLUDED.method_used,
            lower_limit = EXCLUDED.lower_limit, upper_limit = EXCLUDED.upper_limit,
            remarks = EXCLUDED.remarks, entered_by = EXCLUDED.entered_by,
            entered_at = now(), version = analysis_results.version + 1
         RETURNING id`,
        [id, body.resultValue ?? null, body.resultText ?? null, body.unit ?? current.unit,
          body.methodUsed ?? current.test_method, body.lowerLimit ?? null, body.upperLimit ?? null,
          body.remarks ?? null, user.id],
      );
      if (saved.rowCount === 0) throw conflict(MESSAGES.CONFLICT);

      // Recording a result on an unstarted test starts it, so the dates stay honest.
      await client.query(
        `UPDATE analysis_tests SET start_date = COALESCE(start_date, CURRENT_DATE), version = version + 1 WHERE id = $1`,
        [id],
      );

      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'analysis.result_recorded', module: 'analysis',
        recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
        oldValue: {
          resultValue: current.result_value, resultText: current.result_text,
          lowerLimit: current.lower_limit, upperLimit: current.upper_limit,
        },
        newValue: {
          resultValue: body.resultValue ?? null, resultText: body.resultText ?? null,
          lowerLimit: body.lowerLimit ?? null, upperLimit: body.upperLimit ?? null,
          unit: body.unit ?? current.unit,
        },
      });
      return true;
    });

    res.json(toAnalysisItem(await loadItem(id)));
  } catch (err) {
    next(err);
  }
});

analysisRouter.post('/tests/:id/complete', requirePermission('analysis.changeStatus'), validateBody(actionSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    const { version, note } = req.body as z.infer<typeof actionSchema>;

    await withLockedTest(id, version, user, assertTransition('Completed'), async (client, current) => {
      if (!current.result_id) {
        throw conflict('Record the result before completing this test.');
      }
      await client.query(
        `UPDATE analysis_tests SET status = 'Completed', completion_date = CURRENT_DATE,
             remarks = COALESCE($2, remarks), version = version + 1 WHERE id = $1`,
        [id, note ?? null],
      );
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'analysis.completed', module: 'analysis',
        recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
        oldValue: { status: current.status }, newValue: { status: 'Completed', note: note ?? null },
      });
      await advanceTrfIfFinished(client, current, user);
      return true;
    });

    res.json(toAnalysisItem(await loadItem(id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Moves the TRF on when its tests say so: to In Progress when work starts, and to
 * Analysis Completed when the last test is done. Doing it here means the TRF
 * status can never lag behind the tests it is tracking.
 */
async function moveTrf(
  client: import('pg').PoolClient,
  current: AnalysisRow,
  user: EmployeeProfile,
  to: TrfStatus,
  note: string,
): Promise<void> {
  if (!canTransitionTrf(current.trf_status, to)) return;

  const updated = await client.query<{ version: number }>(
    `UPDATE trfs SET status = $2, version = version + 1
     WHERE id = $1 AND status = $3 RETURNING version`, [current.trf_id, to, current.trf_status]);
  if (updated.rowCount === 0) return;

  await client.query(
    `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [current.trf_id, current.trf_status, to, user.id, note],
  );
  await writeAudit(client, {
    userId: user.id, userName: user.fullName, action: 'trf.status_changed', module: 'trf',
    recordType: 'TRF', recordRef: current.trf_number,
    oldValue: { status: current.trf_status }, newValue: { status: to, reason: note },
  });
}

/** Only advances the TRF once nothing is left open on it. */
async function advanceTrfIfFinished(
  client: import('pg').PoolClient,
  current: AnalysisRow,
  user: EmployeeProfile,
): Promise<void> {
  const open = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM analysis_tests
     WHERE trf_id = $1 AND status NOT IN ('Completed', 'Cancelled')`, [current.trf_id]);
  if (Number(open.rows[0].count) > 0) return;
  await moveTrf(client, current, user, 'Analysis Completed', 'All assigned tests completed');
}

/** Sends a completed test back for a repeat, clearing the result so the next reading starts clean. */
analysisRouter.post('/tests/:id/re-test', requirePermission('analysis.changeStatus'), validateBody(actionSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    const { version, note } = req.body as z.infer<typeof actionSchema>;

    await withLockedTest(id, version, user, assertTransition('Re-test Required'), async (client, current) => {
      if (!note) {
        throw badRequest('Say why the test is being repeated.', { note: 'Say why the test is being repeated.' });
      }
      await client.query(
        `UPDATE analysis_tests SET status = 'Re-test Required', completion_date = NULL, version = version + 1 WHERE id = $1`,
        [id],
      );
      await client.query(`DELETE FROM analysis_results WHERE analysis_test_id = $1`, [id]);
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'analysis.re_test_requested', module: 'analysis',
        recordType: 'AnalysisTest', recordRef: `${current.trf_number} / ${current.test_name}`,
        oldValue: { status: 'Completed', resultValue: current.result_value, resultText: current.result_text },
        newValue: { status: 'Re-test Required', note },
      });
      return true;
    });

    res.json(toAnalysisItem(await loadItem(id)));
  } catch (err) {
    next(err);
  }
});

analysisRouter.get('/trfs/:trfId', requirePermission('analysis.view'), async (req, res, next) => {
  try {
    const trfId = Number(req.params.trfId);
    if (!Number.isInteger(trfId) || trfId <= 0) throw notFound();
    const viewer = currentEmployee(req);
    const params: unknown[] = [trfId];
    let whereSql = 'WHERE a.trf_id = $1';
    if (!roleHasPermission(viewer.role, 'analysis.viewAll')) {
      params.push(viewer.id);
      whereSql += ` AND a.assigned_employee_id = $${params.length}`;
    }
    const rows = await pool.query<AnalysisRow>(
      `SELECT ${ANALYSIS_SELECT} ${ANALYSIS_FROM} ${whereSql} ORDER BY a.test_name ASC`, params);
    res.json({ items: rows.rows.map(toAnalysisItem) });
  } catch (err) {
    next(err);
  }
});

/** What this analyst can still act on, for the "my work" default view. */
analysisRouter.get('/mine', requirePermission('analysis.view'), async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const rows = await pool.query<AnalysisRow>(
      `SELECT ${ANALYSIS_SELECT} ${ANALYSIS_FROM}
       WHERE a.assigned_employee_id = $1 AND a.status NOT IN ('Completed', 'Cancelled')
       ORDER BY a.due_date ASC NULLS LAST, a.test_name ASC`,
      [viewer.id],
    );
    const trfStatuses = new Set<TrfStatus>(rows.rows.map((r) => r.trf_status));
    res.json({ items: rows.rows.map(toAnalysisItem), trfCount: trfStatuses.size });
  } catch (err) {
    next(err);
  }
});
