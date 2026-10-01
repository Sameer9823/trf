import { Router } from 'express';
import { z } from 'zod';
import type { Customer, Product } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { duplicateError, forbidden } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, currentEmployee, requirePermission, validateBody } from '../middleware/auth';

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

lookupsRouter.get('/customers', requirePermission('trf.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<CustomerRow>(
      `SELECT id, name, code, contact_person, email, phone, address, is_active
       FROM customers WHERE is_active = TRUE ORDER BY name ASC`,
    );
    res.json({ items: result.rows.map(toCustomer) });
  } catch (err) { next(err); }
});

lookupsRouter.post('/customers', requirePermission('employees.manage'), validateBody(customerSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const b = req.body as z.infer<typeof customerSchema>;
    const created = await withTransaction(async (client) => {
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

lookupsRouter.post('/products', requirePermission('employees.manage'), validateBody(productSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const b = req.body as z.infer<typeof productSchema>;
    const created = await withTransaction(async (client) => {
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
