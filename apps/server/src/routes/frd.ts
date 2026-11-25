import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { notFound } from '../lib/errors.js';
import { authenticate, requireHigherAuthority } from '../middleware/auth.js';

/**
 * FRD (Formulation) team views for higher authorities only (Admin, GM, AGM).
 * An FRD employee is one whose team is 'FRD' or whose department is
 * 'Formulation' (the same rule canEditTrfPartA uses). Every figure is computed
 * in SQL; the browser never totals anything.
 */
export const frdRouter = Router();
frdRouter.use(authenticate);

/** The per-employee Formulation aggregates, shared by the list and the detail
 *  summary so the two can never disagree. */
const FRD_EMPLOYEE_AGGREGATES = `
  SELECT e.id AS employee_id, e.full_name, e.employee_code, e.designation,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL) AS trfs_created,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'New') AS new,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'Assigned') AS assigned,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'In Progress') AS in_progress,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'Analysis Completed') AS analysis_completed,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'COA Pending') AS coa_pending,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'Completed') AS completed,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'Cancelled') AS cancelled,
    COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.trf_date >= date_trunc('month', CURRENT_DATE)::date) AS created_this_month,
    MAX(t.created_at) FILTER (WHERE t.deleted_at IS NULL) AS last_created_at
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN trfs t ON t.created_by = e.id
  WHERE e.is_active = TRUE AND (e.team = 'FRD' OR d.name = 'Formulation')`;

interface FrdEmployeeAggregateRow {
  employee_id: number; full_name: string; employee_code: string; designation: string | null;
  trfs_created: string; new: string; assigned: string; in_progress: string;
  analysis_completed: string; coa_pending: string; completed: string; cancelled: string;
  created_this_month: string; last_created_at: Date | string | null;
}

function mapFrdEmployeeAggregate(r: FrdEmployeeAggregateRow) {
  return {
    employeeId: Number(r.employee_id),
    fullName: r.full_name,
    employeeCode: r.employee_code,
    designation: r.designation,
    trfsCreated: Number(r.trfs_created),
    new: Number(r.new),
    assigned: Number(r.assigned),
    inProgress: Number(r.in_progress),
    analysisCompleted: Number(r.analysis_completed),
    coaPending: Number(r.coa_pending),
    completed: Number(r.completed),
    cancelled: Number(r.cancelled),
    createdThisMonth: Number(r.created_this_month),
    lastCreatedAt: r.last_created_at ? new Date(r.last_created_at).toISOString() : null,
  };
}

/**
 * GET /api/frd/employees - every ACTIVE FRD employee, including those who have
 * created no TRFs. Higher authorities only.
 */
frdRouter.get('/employees', requireHigherAuthority(), async (_req, res, next) => {
  try {
    const result = await pool.query<FrdEmployeeAggregateRow>(
      `${FRD_EMPLOYEE_AGGREGATES} GROUP BY e.id, e.full_name, e.employee_code, e.designation ORDER BY e.full_name`,
    );
    res.json({ items: result.rows.map(mapFrdEmployeeAggregate) });
  } catch (err) { next(err); }
});

const frdEmployeeDetailQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  status: z.string().default(''),
  search: z.string().trim().max(120).default(''),
});

/**
 * GET /api/frd/employees/:id - one FRD employee's summary (counts over the
 * whole set) and a paginated list of the TRFs they created.
 */
frdRouter.get('/employees/:id', requireHigherAuthority(), async (req, res, next) => {
  try {
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) throw notFound('That FRD employee could not be found.');
    const q = frdEmployeeDetailQuerySchema.parse(req.query);

    const summaryResult = await pool.query<FrdEmployeeAggregateRow>(
      `${FRD_EMPLOYEE_AGGREGATES} AND e.id = $1 GROUP BY e.id, e.full_name, e.employee_code, e.designation`,
      [employeeId],
    );
    if (!summaryResult.rows[0]) throw notFound('That FRD employee could not be found.');
    const summary = mapFrdEmployeeAggregate(summaryResult.rows[0]);

    const params: unknown[] = [employeeId];
    const clauses = ['t.created_by = $1', 't.deleted_at IS NULL'];
    if (q.status) {
      params.push(q.status);
      clauses.push(`t.status = $${params.length}`);
    }
    if (q.search) {
      params.push(`%${q.search.toLowerCase()}%`);
      const p = params.length;
      clauses.push(`(lower(t.trf_number) LIKE $${p} OR lower(COALESCE(p.name, '')) LIKE $${p}
        OR lower(COALESCE(c.name, '')) LIKE $${p} OR lower(COALESCE(t.batch_number, '')) LIKE $${p})`);
    }
    const whereSql = `WHERE ${clauses.join(' AND ')}`;
    const fromSql = `
      FROM trfs t
      LEFT JOIN products p ON p.id = t.product_id
      LEFT JOIN customers c ON c.id = t.customer_id`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count ${fromSql} ${whereSql}`, params,
    );
    const total = Number(countResult.rows[0].count);
    const pageSize = q.pageSize;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const offset = (q.page - 1) * pageSize;

    const listResult = await pool.query<{
      id: number; trf_number: string; trf_date: string; product_name: string | null;
      customer_name: string | null; batch_number: string | null; status: string; priority: string;
      required_completion_date: string | null; assigned_analyst_names: string | null;
    }>(
      `SELECT t.id, t.trf_number, t.trf_date, p.name AS product_name, c.name AS customer_name,
        t.batch_number, t.status, t.priority, t.required_completion_date,
        (SELECT string_agg(DISTINCT ae.full_name, ', ')
           FROM ard_test_assignments ata
           JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
           JOIN employees ae ON ae.id = ataa.analyst_id AND ae.is_active = TRUE
          WHERE ata.trf_id = t.id) AS assigned_analyst_names
       ${fromSql} ${whereSql}
       ORDER BY t.trf_date DESC, t.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    res.json({
      summary,
      items: listResult.rows.map((row) => ({
        trfId: row.id,
        trfNumber: row.trf_number,
        trfDate: row.trf_date ? String(row.trf_date).slice(0, 10) : null,
        productName: row.product_name,
        customerName: row.customer_name,
        batchNumber: row.batch_number,
        status: row.status,
        priority: row.priority,
        assignedAnalystNames: row.assigned_analyst_names,
        dueDate: row.required_completion_date ? String(row.required_completion_date).slice(0, 10) : null,
      })),
      total,
      page: q.page,
      pageSize,
      pageCount,
    });
  } catch (err) { next(err); }
});