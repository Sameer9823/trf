import { Router } from 'express';
import type {
  AnalystResultRow, ArdTestAssignmentStatus, DashboardPayload, EmployeeProfile, StatusSlice, TrfEmployeeRow,
} from '@trf/shared';
import { ARD_TEST_ASSIGNMENT_STATUSES, ArdWorkflowStatus, COA_STATUSES, roleHasPermission } from '@trf/shared';
import { pool } from '../db.js';
import { today as todayLocal } from '../lib/dates.js';
import { OVERDUE_SQL } from '../lib/trf-query.js';
import { scopeFor, trfScopeClause } from '../lib/trf-scope.js';
import { ARD_IN_PROGRESS_SQL, ARD_OPEN_SQL, TEST_OVERDUE_SQL } from '../lib/ard-workload-sql.js';
import { authenticate, currentEmployee, requirePermission } from '../middleware/auth.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

/**
 * COA is not in use yet. The certificate code stays, but the dashboard hides the
 * Certificates card, the Certificate status panel and the COA Pending stage
 * behind this one constant.
 */
const SHOW_COA = false;

/**
 * Everything a dashboard shows is counted here, in SQL. TRF figures use exactly
 * the TRF list's scope (created/assigned, plus the ARD approved-remarks rule);
 * test and analyst figures use the ARD assignment scope (analyst_id = me). A
 * role that cannot see a record must not be able to count it either.
 */
interface Scope { employeeId: number }

function scopeForDashboard(employee: EmployeeProfile): Scope | null {
  return roleHasPermission(employee.role, 'trf.viewAll') ? null : { employeeId: employee.id };
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
    const scope = scopeForDashboard(employee);
    const trfScope = scopeFor(employee);

    // TRF figures: identical scope to the TRF list (buildWhere in routes/trfs.ts).
    const trfParams: unknown[] = [];
    const trfScopeSql = trfScopeClause(trfScope, trfParams);
    const trfWhere = `WHERE t.deleted_at IS NULL${trfScopeSql ? ` AND ${trfScopeSql}` : ''}`;

    const totalsResult = await pool.query<Record<string, string>>(
      `SELECT
         count(*)::text AS trf_total,
         count(*) FILTER (WHERE t.workflow_status = 'Completed')::text AS trf_completed,
         count(*) FILTER (WHERE ${OVERDUE_SQL})::text AS trf_overdue
       FROM trfs t ${trfWhere}`, trfParams);

    // ARD test figures: analyst scope only (never a colleague's tests).
    const testParams: unknown[] = [todayLocal()];
    const testScope = scope ? (testParams.push(scope.employeeId), `WHERE ataa.analyst_id = $${testParams.length}`) : '';
    const testFrom = `
      FROM ard_test_assignment_analysts ataa
      JOIN ard_test_assignments ata ON ata.id = ataa.assignment_id
      LEFT JOIN ard_assignment_results r ON r.assignment_id = ata.id`;

    const testResult = await pool.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE ${ARD_OPEN_SQL})::text AS open_tests,
         count(*) FILTER (WHERE ${TEST_OVERDUE_SQL})::text AS delayed_tests
       ${testFrom} ${testScope}`, testParams);

    // Certificate figures are zero while SHOW_COA is false; the code path stays.
    let coaAwaitingIssue = 0;
    let coaIssued = 0;
    let coaSlices: StatusSlice<(typeof COA_STATUSES)[number]>[] = [];
    if (SHOW_COA) {
      const coaParams: unknown[] = [];
      const coaScope = scope
        ? (coaParams.push(scope.employeeId), `WHERE (c.prepared_by = $${coaParams.length} OR c.approved_by = $${coaParams.length})`)
        : '';
      const coaResult = await pool.query<Record<string, string>>(
        `SELECT
           count(*) FILTER (WHERE c.status IN ('Draft', 'Under Review', 'Approved'))::text AS awaiting_issue,
           count(*) FILTER (WHERE c.status = 'Issued')::text AS issued
         FROM coas c ${coaScope}`, coaParams);
      coaAwaitingIssue = Number(coaResult.rows[0].awaiting_issue);
      coaIssued = Number(coaResult.rows[0].issued);
      const coaRows = await pool.query<{ status: (typeof COA_STATUSES)[number]; count: string }>(
        `SELECT c.status, count(*)::text AS count FROM coas c ${coaScope} GROUP BY c.status`, coaParams);
      coaSlices = fillSlices(coaRows.rows, COA_STATUSES);
    }

    // generate_series gives exactly twelve months including the ones with no work.
    // The scope sits in the JOIN, not the WHERE, so an empty month still appears.
    const monthParams: unknown[] = [];
    const monthScopeSql = trfScopeClause(trfScope, monthParams);
    const monthlyResult = await pool.query<{ month: string; count: string }>(
      `SELECT to_char(m.month, 'YYYY-MM') AS month, count(t.id)::text AS count
       FROM generate_series(
         date_trunc('month', CURRENT_DATE) - INTERVAL '11 months',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month') AS m(month)
       LEFT JOIN trfs t ON date_trunc('month', t.trf_date) = m.month
         AND t.deleted_at IS NULL${monthScopeSql ? ` AND ${monthScopeSql}` : ''}
       GROUP BY m.month ORDER BY m.month ASC`, monthParams);

    const trfSlices = await pool.query<{ status: ArdWorkflowStatus; count: string }>(
      `SELECT t.workflow_status AS status, count(*)::text AS count FROM trfs t
       ${trfWhere} GROUP BY t.workflow_status`, trfParams);

    // The status mix needs only the analyst scope, not today.
    const mixParams: unknown[] = [];
    const mixScope = scope ? (mixParams.push(scope.employeeId), `WHERE ataa.analyst_id = $${mixParams.length}`) : '';
    const analysisSlices = await pool.query<{ status: ArdTestAssignmentStatus; count: string }>(
      `SELECT ata.status AS status, count(*)::text AS count
       ${testFrom} ${mixScope} GROUP BY ata.status`, mixParams);

    // Workload is per analyst from the ARD tables. A scoped viewer sees only
    // their own row rather than the whole laboratory.
    const workload = await pool.query<AnalystResultRow>(
      `SELECT e.id AS "employeeId", e.full_name AS "employeeName",
         count(*) FILTER (WHERE ata.status = 'Assigned')::int AS assigned,
         count(*) FILTER (WHERE ${ARD_IN_PROGRESS_SQL})::int AS "inProgress",
         count(*) FILTER (WHERE r.review_status = 'Submitted')::int AS submitted,
         count(*) FILTER (WHERE r.review_status = 'Approved')::int AS approved,
         count(*) FILTER (WHERE r.review_status = 'Rejected')::int AS rejected,
         count(*) FILTER (WHERE r.review_status = 'Approved' AND r.outcome = 'Pass')::int AS passed,
         count(*) FILTER (WHERE r.review_status = 'Approved' AND r.outcome = 'Fail')::int AS failed,
         count(*) FILTER (WHERE ${TEST_OVERDUE_SQL})::int AS delayed
       FROM ard_test_assignment_analysts ataa
       JOIN employees e ON e.id = ataa.analyst_id
       JOIN ard_test_assignments ata ON ata.id = ataa.assignment_id
       LEFT JOIN ard_assignment_results r ON r.assignment_id = ata.id
       ${testScope}
       GROUP BY e.id, e.full_name
       ORDER BY count(*) FILTER (WHERE ${ARD_OPEN_SQL}) DESC, e.full_name ASC`, testParams);

    // Per-analyst TRF completion: distinct TRFs the analyst works on, and how
    // many of those reached Completed (ARD Final Status).
    const trfByEmployee = await pool.query<TrfEmployeeRow>(
      `SELECT e.id AS "employeeId", e.full_name AS "employeeName",
         count(DISTINCT ata.trf_id) FILTER (WHERE t.workflow_status = 'Completed')::int AS completed,
         count(DISTINCT ata.trf_id)::int AS total
       FROM ard_test_assignment_analysts ataa
       JOIN employees e ON e.id = ataa.analyst_id
       JOIN ard_test_assignments ata ON ata.id = ataa.assignment_id
       JOIN trfs t ON t.id = ata.trf_id
       WHERE ata.status <> 'Cancelled' AND t.deleted_at IS NULL${scope ? ` AND ataa.analyst_id = $${1}` : ''}
       GROUP BY e.id, e.full_name
       ORDER BY completed DESC, e.full_name ASC`, scope ? [scope.employeeId] : []);

    const trf = totalsResult.rows[0];
    const tests = testResult.rows[0];

    const payload: DashboardPayload = {
      scope: scope ? 'own' : 'all',
      totals: {
        trfTotal: Number(trf.trf_total),
        trfCompleted: Number(trf.trf_completed),
        trfOverdue: Number(trf.trf_overdue),
        analysisOpenTests: Number(tests.open_tests),
        analysisDelayedTests: Number(tests.delayed_tests),
        coaAwaitingIssue,
        coaIssued,
      },
      trfStatus: fillSlices(trfSlices.rows, ArdWorkflowStatus),
      analysisStatus: fillSlices(analysisSlices.rows, ARD_TEST_ASSIGNMENT_STATUSES),
      coaStatus: coaSlices,
      showCoa: SHOW_COA,
      monthlyTrfs: monthlyResult.rows.map((r) => ({
        month: r.month,
        label: monthLabel(r.month),
        count: Number(r.count),
      })),
      workload: workload.rows,
      trfByEmployee: trfByEmployee.rows,
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