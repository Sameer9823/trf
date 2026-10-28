import { pool } from '../db';

/**
 * A customer and a product every test file can build its TRFs on. A TRF cannot
 * be created without both, so they are made once per run and reused. They are
 * written straight to the database rather than through the API, so the fixture
 * does not need a session and cannot fail for a reason of its own.
 */
export interface BaseLookups { customerId: number; productId: number }

let cached: BaseLookups | null = null;

export async function baseLookups(): Promise<BaseLookups> {
  if (cached) return cached;
  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (name, code) VALUES ('Test Base Customer', 'TBC-FIXTURE')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const product = await pool.query<{ id: number }>(
    `INSERT INTO products (name, code) VALUES ('Test Base Product', 'TBP-FIXTURE')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  cached = { customerId: customer.rows[0].id, productId: product.rows[0].id };
  return cached;
}
