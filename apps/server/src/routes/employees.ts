import { Router } from 'express';
import { z } from 'zod';
import { QueryResult, QueryResultRow } from 'pg';
import { EmployeeOption, EmployeeProfile, MESSAGES, Paginated, ROLES } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { AppError, badRequest, conflict, duplicateError, forbidden, notFound } from '../lib/errors';
import { EMPLOYEE_FROM, EMPLOYEE_SELECT, EmployeeRow, toProfile } from '../lib/employees';
import { hashPassword } from '../lib/password';
import { diffFields, writeAudit } from '../lib/audit';
import { authenticate, currentEmployee, invalidateEmployeeCache, requirePermission, validateBody } from '../middleware/auth';

export const employeesRouter = Router();
employeesRouter.use(authenticate);

const EMAIL = z.string().trim().toLowerCase().email('Enter a valid email address.');
const NAME = z.string().trim().min(2, 'Enter at least 2 characters.').max(120);

const createSchema = z.object({
  employeeCode: z.string().trim().min(1, 'Employee code is required.').max(40),
  fullName: NAME,
  email: EMAIL,
  username: z.string().trim().min(3, 'Username must be at least 3 characters.').max(60)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore only.'),
  role: z.enum(ROLES),
  departmentId: z.number().int().positive().nullable().optional(),
  designation: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  password: z.string().min(10, 'The password must be at least 10 characters.')
    .regex(/[A-Za-z]/, 'The password must contain a letter.')
    .regex(/[0-9]/, 'The password must contain a number.'),
});

const updateSchema = z.object({
  version: z.number().int().positive(),
  employeeCode: z.string().trim().min(1).max(40).optional(),
  fullName: NAME.optional(),
  email: EMAIL.optional(),
  username: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9._-]+$/).optional(),
  role: z.enum(ROLES).optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  designation: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(10).regex(/[A-Za-z]/).regex(/[0-9]/),
  mustChangePassword: z.boolean().default(true),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  role: z.enum(ROLES).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  isActive: z.enum(['true', 'false', 'all']).optional(),
  sortBy: z.enum(['fullName', 'employeeCode', 'role', 'createdAt']).default('fullName'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});

const SORT_COLUMNS: Record<string, string> = {
  fullName: 'e.full_name',
  employeeCode: 'e.employee_code',
  role: 'e.role',
  createdAt: 'e.created_at',
};

/** Anything that can run a query: the pool or a transaction client. */
interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/** Database column -> profile field, so audit rows compare like with like. */
const COLUMN_TO_FIELD: Record<string, string> = {
  employee_code: 'employeeCode',
  full_name: 'fullName',
  email: 'email',
  username: 'username',
  role: 'role',
  department_id: 'departmentId',
  designation: 'designation',
  phone: 'phone',
  is_active: 'isActive',
  must_change_password: 'mustChangePassword',
};

/** Admin-only guard for the last active administrator. Used before role changes and deactivation. */
async function assertNotLastAdmin(client: Queryable, target: EmployeeRow) {
  if (target.role !== 'Admin' || !target.is_active) return;
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM employees WHERE role = 'Admin' AND is_active = TRUE AND id <> $1`,
    [target.id],
  );
  if (Number(result.rows[0].count) === 0) throw conflict(MESSAGES.LAST_ADMIN);
}

async function loadEmployee(id: number, client?: Queryable) {
  const runner = client ?? pool;
  const result = await runner.query<EmployeeRow>(`SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [id]);
  return result.rows[0] ?? null;
}

employeesRouter.get('/', requirePermission('employees.view'), async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.search) {
      params.push(`%${q.search.toLowerCase()}%`);
      where.push(`(lower(e.full_name) LIKE $${params.length} OR lower(e.employee_code) LIKE $${params.length}
                   OR lower(e.email) LIKE $${params.length} OR lower(e.username) LIKE $${params.length}
                   OR lower(COALESCE(e.designation, '')) LIKE $${params.length})`);
    }
    if (q.role) { params.push(q.role); where.push(`e.role = $${params.length}`); }
    if (q.departmentId) { params.push(q.departmentId); where.push(`e.department_id = $${params.length}`); }
    if (q.isActive && q.isActive !== 'all') { params.push(q.isActive === 'true'); where.push(`e.is_active = $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortColumn = SORT_COLUMNS[q.sortBy];
    const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';

    const countResult = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM employees e ${whereSql}`, params);
    const total = Number(countResult.rows[0].count);

    const rows = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} ${whereSql}
       ORDER BY ${sortColumn} ${dir}, e.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );

    const body: Paginated<EmployeeProfile> = {
      items: rows.rows.map(toProfile),
      total,
      page: q.page,
      pageSize: q.pageSize,
      pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
    };
    res.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    next(err);
  }
});

employeesRouter.get('/assignable', requirePermission('employees.view'), async (_req, res, next) => {
  try {
    // Only active staff who can hold a test: used by the assignment screens.
    const result = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM}
       WHERE e.is_active = TRUE AND e.role IN ('Admin', 'Manager', 'Analyst')
       ORDER BY e.full_name ASC`,
    );
    res.json({ items: result.rows.map(toProfile) });
  } catch (err) {
    next(err);
  }
});

/**
 * Active employees with just enough info to populate a dropdown: id, full
 * name, designation and department. Anyone who can see a TRF may call this,
 * so the form's "Sample Submitted By" control is not limited to the
 * employees.manage permission. The password hash is never selected.
 */
employeesRouter.get('/for-select', requirePermission('trf.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<{
      id: number; employee_code: string; full_name: string; designation: string | null; department_name: string | null;
    }>(
      `SELECT e.id, e.employee_code, e.full_name, e.designation, d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active = TRUE
       ORDER BY e.full_name ASC`,
    );
    const items: EmployeeOption[] = result.rows.map((row) => ({
      id: row.id,
      employeeCode: row.employee_code,
      fullName: row.full_name,
      designation: row.designation,
      departmentName: row.department_name,
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

employeesRouter.get('/:id', requirePermission('employees.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const row = await loadEmployee(id);
    if (!row) throw notFound();
    res.json(toProfile(row));
  } catch (err) {
    next(err);
  }
});

employeesRouter.post('/', requirePermission('employees.manage'), validateBody(createSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const body = req.body as z.infer<typeof createSchema>;
    const passwordHash = await hashPassword(body.password);

    const created = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO employees (employee_code, full_name, designation, department_id, email, phone,
                                username, password_hash, role, must_change_password, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10)
         RETURNING id`,
        [body.employeeCode, body.fullName, body.designation ?? null, body.departmentId ?? null, body.email,
         body.phone ?? null, body.username, passwordHash, body.role, admin.id],
      );
      const id = inserted.rows[0].id;
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'employee.created', module: 'employees',
        recordType: 'Employee', recordRef: body.employeeCode,
        newValue: { fullName: body.fullName, role: body.role, email: body.email, departmentId: body.departmentId ?? null },
      });
      return loadEmployee(id, client);
    });

    res.status(201).json(toProfile(created!));
  } catch (err) {
    const dup = duplicateError(err, {
      employees_username_key: MESSAGES.USERNAME_EXISTS,
      employees_email_key: MESSAGES.EMAIL_EXISTS,
      employees_employee_code_key: MESSAGES.EMPLOYEE_CODE_EXISTS,
    });
    next(dup ?? err);
  }
});

employeesRouter.patch('/:id', requirePermission('employees.manage'), validateBody(updateSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof updateSchema>;

    const updated = await withTransaction(async (client) => {
      const before = await loadEmployee(id, client);
      if (!before) throw notFound();
      await assertNotLastAdmin(client, before);

      const fields: Record<string, unknown> = {
        employee_code: body.employeeCode,
        full_name: body.fullName,
        email: body.email,
        username: body.username,
        role: body.role,
        department_id: body.departmentId,
        designation: body.designation,
        phone: body.phone,
        is_active: body.isActive,
        must_change_password: body.mustChangePassword,
      };
      const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
      if (!keys.length) throw badRequest('There is nothing to update.');

      const params: unknown[] = keys.map((k) => fields[k]);
      params.push(id, body.version);
      const result = await client.query<EmployeeRow>(
        `UPDATE employees SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, version = version + 1
         WHERE id = $${keys.length + 1} AND version = $${keys.length + 2}
         RETURNING id`,
        params,
      );
      if (result.rowCount === 0) throw new AppError(409, 'VERSION_CONFLICT', MESSAGES.CONFLICT);

      const after = await loadEmployee(id, client);
      // diffFields works on the camelCase profile, so map each column to its profile field.
      const changes = diffFields(
        toProfile(before) as unknown as Record<string, unknown>,
        toProfile(after!) as unknown as Record<string, unknown>,
        keys.map((column) => COLUMN_TO_FIELD[column]).filter((f): f is string => Boolean(f)),
      );
      for (const change of changes) {
        // The action name uses the database column, which is what later phases
        // filter the audit log on.
        const column = Object.keys(COLUMN_TO_FIELD).find((c) => COLUMN_TO_FIELD[c] === change.field) ?? change.field;
        await writeAudit(client, {
          userId: admin.id, userName: admin.fullName, action: `employee.${column}_changed`, module: 'employees',
          recordType: 'Employee', recordRef: after!.employee_code,
          oldValue: change.old, newValue: change.new,
        });
      }
      return after!;
    });

    invalidateEmployeeCache(id);
    res.json(toProfile(updated));
  } catch (err) {
    const dup = duplicateError(err, {
      employees_username_key: MESSAGES.USERNAME_EXISTS,
      employees_email_key: MESSAGES.EMAIL_EXISTS,
      employees_employee_code_key: MESSAGES.EMPLOYEE_CODE_EXISTS,
    });
    next(dup ?? err);
  }
});

employeesRouter.post('/:id/reset-password', requirePermission('employees.manage'), validateBody(resetPasswordSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof resetPasswordSchema>;
    const passwordHash = await hashPassword(body.newPassword);

    await withTransaction(async (client) => {
      const before = await loadEmployee(id, client);
      if (!before) throw notFound();
      const result = await client.query(
        `UPDATE employees SET password_hash = $2, must_change_password = $3, failed_login_count = 0,
         locked_until = NULL, version = version + 1
         WHERE id = $1 AND version = $4`,
        [id, passwordHash, body.mustChangePassword, before.version],
      );
      if (result.rowCount === 0) throw new AppError(409, 'VERSION_CONFLICT', MESSAGES.CONFLICT);
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [id]);
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'employee.password_reset', module: 'employees',
        recordType: 'Employee', recordRef: before.employee_code,
        oldValue: { mustChangePassword: before.must_change_password },
        newValue: { mustChangePassword: body.mustChangePassword },
      });
    });

    invalidateEmployeeCache(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

employeesRouter.post('/:id/deactivate', requirePermission('employees.manage'), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    if (id === admin.id) throw forbidden('You cannot deactivate your own account.');

    const updated = await withTransaction(async (client) => {
      const before = await loadEmployee(id, client);
      if (!before) throw notFound();
      await assertNotLastAdmin(client, before);
      const result = await client.query('UPDATE employees SET is_active = FALSE, version = version + 1 WHERE id = $1 RETURNING id', [id]);
      if (result.rowCount === 0) throw notFound();
      // Sessions of a deactivated employee must stop working immediately.
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [id]);
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'employee.deactivated', module: 'employees',
        recordType: 'Employee', recordRef: before.employee_code,
        oldValue: { isActive: true }, newValue: { isActive: false },
      });
      return loadEmployee(id, client);
    });

    invalidateEmployeeCache(id);
    res.json(toProfile(updated!));
  } catch (err) {
    next(err);
  }
});

employeesRouter.post('/:id/activate', requirePermission('employees.manage'), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    const updated = await withTransaction(async (client) => {
      const before = await loadEmployee(id, client);
      if (!before) throw notFound();
      const result = await client.query('UPDATE employees SET is_active = TRUE, version = version + 1 WHERE id = $1 RETURNING id', [id]);
      if (result.rowCount === 0) throw notFound();
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'employee.activated', module: 'employees',
        recordType: 'Employee', recordRef: before.employee_code,
        oldValue: { isActive: false }, newValue: { isActive: true },
      });
      return loadEmployee(id, client);
    });

    invalidateEmployeeCache(id);
    res.json(toProfile(updated!));
  } catch (err) {
    next(err);
  }
});
