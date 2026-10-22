import { Router } from 'express';
import type {
  AnalysisStatus, AnalystResultRow, CoaStatus, DashboardPayload, EmployeeProfile, StatusSlice, TrfStatus,
} from '@trf/shared';
import { ANALYSIS_STATUSES, COA_STATUSES, TRF_STATUSES, roleHasPermission } from '@trf/shared';
import { pool } from '../db';
import { OUTCOME_SQL } from '../lib/analysis-query';
import { authenticate, currentEmployee, requirePermission } from '../middleware/auth';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

/**
 * Everything a dashboard shows is counted here, in SQL, over the same scope the
 * matching list uses. A role that cannot see a record must not be able to count
 * it either, so the scope is applied to every query rather than to the result.
 */
interface Scope { employeeId: number }

function scopeFor(employee: EmployeeProfile): Scope | null {
  return roleHasPermission(employee.role, 'trf.viewAll') ? null : { employeeId: employee.id };
}

/** Same overdue expression the TRF list uses, so a card and a list always agree. */
const TRF_OVERDUE = `(t.required_completion_date IS NOT NULL AND t.required_completion_date < CURRENT_DATE
  AND t.status NOT IN ('Completed', 'Cancelled'))`;

/** Delayed is computed the same way as in the analysis list. */
const TEST_DELAYED = `(a.due_date IS NOT NULL AND a.due_date < CURRENT_DATE
  AND a.status NOT IN ('Completed', 'Cancelled'))`;

const TEST_OPEN = `(a.status NOT IN ('Completed', 'Cancelled'))`;

/**
 * Each helper returns the WHERE fragment together with the values it needs.
 * Returning them as a pair is deliberate: a fragment whose `$1` is never bound
 * fails at run time, not at compile time.
 */
type Fragment = { sql: string; params: unknown[] };

function whereTrf(scope: Scope | null): Fragment {
  // Deleted TRFs are hidden from the TRF list, so the dashboard must not count
  // them either: the headline number and the list always agree.
  if (!scope) return { sql: 'WHERE t.deleted_at IS NULL', params: [] };
  return { sql: 'WHERE t.deleted_at IS NULL AND (t.assigned_employee_id = $1 OR t.created_by = $1)', params: [scope.employeeId] };
}

function whereTest(scope: Scope | null): Fragment {
  if (!scope) return { sql: '', params: [] };
  return { sql: 'WHERE a.assigned_employee_id = $1', params: [scope.employeeId] };
}

function whereCoa(scope: Scope | null): Fragment {
  if (!scope) return { sql: '', params: [] };
  // A certificate is "mine" only if this person drafted or approved it.
  return {
    sql: 'WHERE (c.prepared_by = $1 OR c.approved_by = $1)',
    params: [scope.employeeId],
  };
}

/** Zero-filled so the client never has to fill gaps, and every status is present once. */
function fillSlices<T extends string>(
  rows: { status: T; count: string }[],
  statuses: readonly T[],
): StatusSlice<T>[] {
  const found = new Map(rows.map((r) => [r.status, Number(r.count)]));
  return statuses.map((status) => ({ status, count: found.get(status) ?? 0 }));
}

dashboardRouter.get('/', requirePermission('dashboard.view'), async (req, res, next) => {
  const employee = currentEmployee(req);
  try {
    const scope = scopeFor(employee);
    const trfScope = whereTrf(scope);
    const testScope = whereTest(scope);
    const coaScope = whereCoa(scope);

    const totalsResult = await pool.query<Record<string, string>>(
      `SELECT
         count(*)::text AS trf_total,
         count(*) FILTER (WHERE t.status = 'New')::text AS trf_new,
         count(*) FILTER (WHERE t.status = 'Assigned')::text AS trf_assigned,
         count(*) FILTER (WHERE t.status = 'In Progress')::text AS trf_in_progress,
         count(*) FILTER (WHERE t.status = 'Analysis Completed')::text AS trf_analysis_completed,
         count(*) FILTER (WHERE t.status = 'COA Pending')::text AS trf_coa_pending,
         count(*) FILTER (WHERE t.status = 'Completed')::text AS trf_completed,
         count(*) FILTER (WHERE t.status = 'Cancelled')::text AS trf_cancelled,
         count(*) FILTER (WHERE ${TRF_OVERDUE})::text AS trf_overdue
       FROM trfs t ${trfScope.sql}`, trfScope.params);

    const testResult = await pool.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE ${TEST_OPEN})::text AS open_tests,
         count(*) FILTER (WHERE ${TEST_DELAYED})::text AS delayed_tests
       FROM analysis_tests a ${testScope.sql}`, testScope.params);

    const coaResult = await pool.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE c.status IN ('Draft', 'Under Review', 'Approved'))::text AS awaiting_issue,
         count(*) FILTER (WHERE c.status = 'Issued')::text AS issued
       FROM coas c ${coaScope.sql}`, coaScope.params);

    // generate_series gives exactly twelve months including the ones with no work.
    // The scope sits in the JOIN, not the WHERE, so an empty month still appears.
    const monthlyResult = await pool.query<{ month: string; count: string }>(
      `SELECT to_char(m.month, 'YYYY-MM') AS month, count(t.id)::text AS count
       FROM generate_series(
         date_trunc('month', CURRENT_DATE) - INTERVAL '11 months',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month') AS m(month)
       LEFT JOIN trfs t ON date_trunc('month', t.trf_date) = m.month
         ${scope ? 'AND (t.assigned_employee_id = $1 OR t.created_by = $1)' : ''}
       GROUP BY m.month ORDER BY m.month ASC`, scope ? [scope.employeeId] : []);

    const trfSlices = await pool.query<{ status: TrfStatus; count: string }>(
      `SELECT t.status, count(*)::text AS count FROM trfs t
       ${trfScope.sql} GROUP BY t.status`, trfScope.params);

    const analysisSlices = await pool.query<{ status: AnalysisStatus; count: string }>(
      `SELECT a.status, count(*)::text AS count FROM analysis_tests a
       ${testScope.sql} GROUP BY a.status`, testScope.params);

    const coaSlices = await pool.query<{ status: CoaStatus; count: string }>(
      `SELECT c.status, count(*)::text AS count FROM coas c
       ${coaScope.sql} GROUP BY c.status`, coaScope.params);

    // Workload is per analyst. A scoped viewer sees only their own row rather
    // than the whole laboratory, which would otherwise leak what colleagues do.
    const workload = await pool.query<AnalystResultRow>(
      `SELECT e.id AS "employeeId", e.full_name AS "employeeName",
         count(*) FILTER (WHERE a.status = 'Assigned')::int AS assigned,
         count(*) FILTER (WHERE a.status = 'In Progress')::int AS "inProgress",
         count(*) FILTER (WHERE a.status = 'Completed' AND (${OUTCOME_SQL}) = 'Pass')::int AS passed,
         count(*) FILTER (WHERE a.status = 'Completed' AND (${OUTCOME_SQL}) = 'Fail')::int AS failed,
         count(*) FILTER (WHERE ${TEST_DELAYED})::int AS delayed
       FROM analysis_tests a
       JOIN employees e ON e.id = a.assigned_employee_id
       LEFT JOIN analysis_results r ON r.analysis_test_id = a.id
       ${testScope.sql}
       GROUP BY e.id, e.full_name
       ORDER BY count(*) FILTER (WHERE ${TEST_OPEN}) DESC, e.full_name ASC`, testScope.params);

    const trf = totalsResult.rows[0];
    const tests = testResult.rows[0];
    const coas = coaResult.rows[0];

    const payload: DashboardPayload = {
      scope: scope ? 'own' : 'all',
      totals: {
        trfTotal: Number(trf.trf_total),
        trfNew: Number(trf.trf_new),
        trfAssigned: Number(trf.trf_assigned),
        trfInProgress: Number(trf.trf_in_progress),
        trfAnalysisCompleted: Number(trf.trf_analysis_completed),
        trfCoaPending: Number(trf.trf_coa_pending),
        trfCompleted: Number(trf.trf_completed),
        trfCancelled: Number(trf.trf_cancelled),
        trfOverdue: Number(trf.trf_overdue),
        analysisOpenTests: Number(tests.open_tests),
        analysisDelayedTests: Number(tests.delayed_tests),
        coaAwaitingIssue: Number(coas.awaiting_issue),
        coaIssued: Number(coas.issued),
      },
      trfStatus: fillSlices(trfSlices.rows, TRF_STATUSES),
      analysisStatus: fillSlices(analysisSlices.rows, ANALYSIS_STATUSES),
      coaStatus: fillSlices(coaSlices.rows, COA_STATUSES),
      monthlyTrfs: monthlyResult.rows.map((r) => ({
        month: r.month,
        label: monthLabel(r.month),
        count: Number(r.count),
      })),
      workload: workload.rows,
      generatedAt: new Date().toISOString(),
    };

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/** `2026-03` becomes `Mar 2026`, so the chart axis needs no date library. */
function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m) - 1] ?? m} ${year}`;
}

