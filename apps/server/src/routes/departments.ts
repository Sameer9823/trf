import { Router } from 'express';
import { z } from 'zod';
import { Department } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { duplicateError, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, currentEmployee, requirePermission, validateBody } from '../middleware/auth';

export const departmentsRouter = Router();
departmentsRouter.use(authenticate);

const createSchema = z.object({ name: z.string().trim().min(2, 'Enter at least 2 characters.').max(80) });
const renameSchema = z.object({ name: z.string().trim().min(2).max(80), isActive: z.boolean().optional() });

interface DepartmentRow { id: number; name: string; is_active: boolean }

departmentsRouter.get('/', requirePermission('employees.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<DepartmentRow>(
      `SELECT id, name, is_active FROM departments ORDER BY is_active DESC, name ASC`,
    );
    const items: Department[] = result.rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

departmentsRouter.post('/', requirePermission('employees.manage'), validateBody(createSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const { name } = req.body as z.infer<typeof createSchema>;
    const created = await withTransaction(async (client) => {
      const result = await client.query<DepartmentRow>(
        `INSERT INTO departments (name) VALUES ($1) RETURNING id, name, is_active`, [name]);
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'department.created', module: 'employees',
        recordType: 'Department', recordRef: name, newValue: { name },
      });
      return result.rows[0];
    });
    res.status(201).json({ id: created.id, name: created.name, isActive: created.is_active });
  } catch (err) {
    next(duplicateError(err, { departments_name_key: 'A department with this name already exists.' }) ?? err);
  }
});

departmentsRouter.patch('/:id', requirePermission('employees.manage'), validateBody(renameSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const { name, isActive } = req.body as z.infer<typeof renameSchema>;

    const updated = await withTransaction(async (client) => {
      const result = await client.query<DepartmentRow>(
        `UPDATE departments SET name = COALESCE($2, name), is_active = COALESCE($3, is_active)
         WHERE id = $1 RETURNING id, name, is_active`,
        [id, name ?? null, isActive ?? null],
      );
      const row = result.rows[0];
      if (!row) throw notFound();
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'department.updated', module: 'employees',
        recordType: 'Department', recordRef: row.name, newValue: { name: row.name, isActive: row.is_active },
      });
      return row;
    });
    res.json({ id: updated.id, name: updated.name, isActive: updated.is_active });
  } catch (err) {
    next(duplicateError(err, { departments_name_key: 'A department with this name already exists.' }) ?? err);
  }
});
