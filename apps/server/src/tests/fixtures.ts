import { pool } from '../db';

/**
 * A customer, product, and test/dosage option IDs every test file can build TRFs on.
 * A TRF cannot be created without both a customer and a product, and now also needs
 * at least one test requested option and one dosage form option.
 */
export interface BaseLookups { customerId: number; productId: number; testRequestedOptionIds: number[]; dosageFormOptionIds: number[] }

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
  const testOpt = await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1');
  if (!testOpt.rowCount) {
    await pool.query("INSERT INTO test_requested_options (name, display_order) VALUES ('Test Option 1', 1)");
  }
  const dosageOpt = await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1');
  if (!dosageOpt.rowCount) {
    await pool.query("INSERT INTO dosage_form_options (name, display_order) VALUES ('Tablet', 1)");
  }
  cached = {
    customerId: customer.rows[0].id,
    productId: product.rows[0].id,
    testRequestedOptionIds: [(await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1')).rows[0].id],
    dosageFormOptionIds: [(await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1')).rows[0].id],
  };
  return cached;
}
