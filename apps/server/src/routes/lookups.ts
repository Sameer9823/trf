import { Router } from 'express';
import { z } from 'zod';
import type { Customer, Product, StageOption, EmployeeOption } from '@trf/shared';
import { QueryResult } from 'pg';
import { pool, withTransaction } from '../db';
import { duplicateError, forbidden, conflict, badRequest } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, currentEmployee, requirePermission, requireTrfLookupEdit, requireArdEdit, validateBody } from '../middleware/auth';

export const lookupsRouter = Router();
// Customers and products are readable by anyone who can see a TRF, because the
// TRF form shows them. Editing them is Admin-only.
lookupsRouter.use(authenticate);

const customerSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(120),
  code: z.string().trim().max(40).nullable().optional(),
  contactPerson: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(30).nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
});
const productSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(120),
  code: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().max(200).nullable().optional(),
});

interface CustomerRow { id: number; name: string; code: string | null; contact_person: string | null; email: string | null; phone: string | null; address: string | null; is_active: boolean }
interface ProductRow { id: number; name: string; code: string | null; description: string | null; is_active: boolean }

const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id, name: r.name, code: r.code, contactPerson: r.contact_person,
  email: r.email, phone: r.phone, address: r.address, isActive: r.is_active,
});
const toProduct = (r: ProductRow): Product => ({ id: r.id, name: r.name, code: r.code, description: r.description, isActive: r.is_active });

const nullIfEmpty = (v: string | null | undefined) => (v ? v : null);

/**
 * Looks for a customer or product whose name matches, ignoring case. The unique
 * index on `code` is case-sensitive, so "Acme" and "acme" would both be
 * accepted by the database but read as the same record to a person.
 */
async function findByName(client: { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number }> },
  table: 'customers' | 'products', name: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) LIMIT 1`, [name]);
  return result.rowCount > 0;
}

/** The same check for the optional code, which is unique but case-sensitive. */
async function findByCode(client: { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number }> },
  table: 'customers' | 'products', code: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM ${table} WHERE lower(code) = lower($1) LIMIT 1`, [code]);
  return result.rowCount > 0;
}

lookupsRouter.get('/customers', requirePermission('trf.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<CustomerRow>(
      `SELECT id, name, code, contact_person, email, phone, address, is_active
       FROM customers WHERE is_active = TRUE ORDER BY name ASC`,
    );
    res.json({ items: result.rows.map(toCustomer) });
  } catch (err) { next(err); }
});

lookupsRouter.post('/customers', requireTrfLookupEdit(), validateBody(customerSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const b = req.body as z.infer<typeof customerSchema>;
    const created = await withTransaction(async (client) => {
      if (await findByName(client, 'customers', b.name)) {
        throw conflict('A customer with this name already exists.');
      }
      if (b.code && await findByCode(client, 'customers', b.code)) {
        throw conflict('A customer with this code already exists.');
      }
      const result = await client.query<CustomerRow>(
        `INSERT INTO customers (name, code, contact_person, email, phone, address)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, code, contact_person, email, phone, address, is_active`,
        [b.name, nullIfEmpty(b.code), nullIfEmpty(b.contactPerson), nullIfEmpty(b.email as string), nullIfEmpty(b.phone), nullIfEmpty(b.address)],
      );
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'customer.created', module: 'trf',
        recordType: 'Customer', recordRef: b.name, newValue: { name: b.name, code: b.code ?? null },
      });
      return result.rows[0];
    });
    res.status(201).json(toCustomer(created));
  } catch (err) {
    next(duplicateError(err, { customers_code_key: 'A customer with this code already exists.' }) ?? err);
  }
});

lookupsRouter.get('/products', requirePermission('trf.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<ProductRow>(
      `SELECT id, name, code, description, is_active FROM products WHERE is_active = TRUE ORDER BY name ASC`,
    );
    res.json({ items: result.rows.map(toProduct) });
  } catch (err) { next(err); }
});

lookupsRouter.post('/products', requireTrfLookupEdit(), validateBody(productSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const b = req.body as z.infer<typeof productSchema>;
    const created = await withTransaction(async (client) => {
      if (await findByName(client, 'products', b.name)) {
        throw conflict('A product with this name already exists.');
      }
      if (b.code && await findByCode(client, 'products', b.code)) {
        throw conflict('A product with this code already exists.');
      }
      const result = await client.query<ProductRow>(
        `INSERT INTO products (name, code, description) VALUES ($1, $2, $3)
         RETURNING id, name, code, description, is_active`,
        [b.name, nullIfEmpty(b.code), nullIfEmpty(b.description)],
      );
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'product.created', module: 'trf',
        recordType: 'Product', recordRef: b.name, newValue: { name: b.name, code: b.code ?? null },
      });
      return result.rows[0];
    });
    res.status(201).json(toProduct(created));
  } catch (err) {
    next(duplicateError(err, { products_code_key: 'A product with this code already exists.' }) ?? err);
  }
});

// Product and customer edits are needed before TRFs reference them heavily.
const customerUpdateSchema = customerSchema.partial().extend({ isActive: z.boolean().optional() });
const productUpdateSchema = productSchema.partial().extend({ isActive: z.boolean().optional() });

// Editing or deactivating a master record is Admin-only: the lists are shared
// with every TRF, so only an administrator may change or retire one. Adding a
// new one while filling in a TRF is a different job and is allowed to anyone
// with Part A rights.
lookupsRouter.patch('/customers/:id', requirePermission('employees.manage'), validateBody(customerUpdateSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    const b = req.body as z.infer<typeof customerUpdateSchema>;
    const updated = await withTransaction(async (client) => {
      const result = await client.query<CustomerRow>(
        `UPDATE customers SET name = COALESCE($2, name), code = COALESCE($3, code),
           contact_person = COALESCE($4, contact_person), email = COALESCE($5, email),
           phone = COALESCE($6, phone), address = COALESCE($7, address), is_active = COALESCE($8, is_active)
         WHERE id = $1 RETURNING id, name, code, contact_person, email, phone, address, is_active`,
        [id, b.name ?? null, b.code ?? null, b.contactPerson ?? null, b.email ? b.email : null,
         b.phone ?? null, b.address ?? null, b.isActive ?? null],
      );
      if (!result.rows[0]) return null;
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'customer.updated', module: 'trf',
        recordType: 'Customer', recordRef: result.rows[0].name, newValue: b,
      });
      return result.rows[0];
    });
    if (!updated) throw forbidden();
    res.json(toCustomer(updated));
  } catch (err) {
    next(duplicateError(err, { customers_code_key: 'A customer with this code already exists.' }) ?? err);
  }
});

lookupsRouter.patch('/products/:id', requirePermission('employees.manage'), validateBody(productUpdateSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    const b = req.body as z.infer<typeof productUpdateSchema>;
    const updated = await withTransaction(async (client) => {
      const result = await client.query<ProductRow>(
        `UPDATE products SET name = COALESCE($2, name), code = COALESCE($3, code),
           description = COALESCE($4, description), is_active = COALESCE($5, is_active)
         WHERE id = $1 RETURNING id, name, code, description, is_active`,
        [id, b.name ?? null, b.code ?? null, b.description ?? null, b.isActive ?? null],
      );
      if (!result.rows[0]) return null;
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'product.updated', module: 'trf',
        recordType: 'Product', recordRef: result.rows[0].name, newValue: b,
      });
      return result.rows[0];
    });
    if (!updated) throw forbidden();
    res.json(toProduct(updated));
  } catch (err) {
    next(duplicateError(err, { products_code_key: 'A product with this code already exists.' }) ?? err);
  }
});

const stageSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters.').max(60, 'The stage must be at most 60 characters.'),
});

/** Active stages offered in the ARD Stage dropdown. Anyone who can see a TRF may read them. */
lookupsRouter.get('/stages', requirePermission('trf.view'), async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, is_active FROM ard_stages WHERE is_active = TRUE ORDER BY name ASC`,
    );
    const items: StageOption[] = (result.rows as { id: number; name: string; is_active: boolean }[])
      .map((r) => ({ id: r.id, name: r.name, isActive: r.is_active }));
    res.json({ items });
  } catch (err) { next(err); }
});

/**
 * Create a stage. Requires Part B rights (canEditTrfPartB). Whitespace is
 * collapsed and trimmed; 2-60 characters; a case-insensitive duplicate reuses
 * the existing record and tells the user. An unknown stage saved on a TRF is
 * a 400 with a field message, never a 500.
 */
lookupsRouter.post('/stages', requireArdEdit(), validateBody(stageSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const b = req.body as z.infer<typeof stageSchema>;
    const name = b.name.replace(/\s+/g, ' ').trim();
    if (name.length < 2) throw badRequest('Enter at least 2 characters.', { name: 'Enter at least 2 characters.' });
    if (name.length > 60) throw badRequest('The stage must be at most 60 characters.', { name: 'The stage must be at most 60 characters.' });

    const existing = await pool.query(
      `SELECT id, name, is_active FROM ard_stages WHERE lower(name) = lower($1) LIMIT 1`, [name],
    );
    if (existing.rowCount) {
      const row = existing.rows[0] as { id: number; name: string; is_active: boolean };
      // Reuse the existing record and tell the user.
      return res.json({ item: { id: row.id, name: row.name, isActive: row.is_active }, duplicate: true });
    }

    const created = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ard_stages (name, is_active, created_by) VALUES ($1, TRUE, $2) RETURNING id, name, is_active`,
        [name, user.id],
      );
      const row = result.rows[0] as { id: number; name: string; is_active: boolean };
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'ard.stage_created', module: 'trf',
        recordType: 'ARD Stage', recordRef: name, newValue: { name },
      });
      return row;
    });
    res.status(201).json({ item: { id: created.id, name: created.name, isActive: created.is_active }, duplicate: false });
  } catch (err) {
    next(duplicateError(err, { ard_stages_name_unique: 'A stage with this name already exists.' }) ?? err);
  }
});

/**
 * Active employees for dropdowns: id, employeeCode, fullName, designation, departmentName.
 * Anyone who can view a TRF may call this (permission: trf.view).
 * Returns employees of ANY role, sorted by name.
 * Used for Analyst Name and Sample Submitted By dropdowns.
 */
lookupsRouter.get('/employees', requirePermission('trf.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<{
      id: number;
      employee_code: string;
      full_name: string;
      designation: string | null;
      department_name: string | null;
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
  } catch (err) { next(err); }
});
