import { pool } from './apps/server/src/db.js';

async function main() {
  const result = await pool.query("SELECT id, full_name, role, designation, is_active FROM employees WHERE designation = 'AGM' OR role = 'AGM'");
  console.log('Active AGM accounts:', result.rows.filter(x => x.is_active).length);
  console.log('All matching rows:', JSON.stringify(result.rows, null, 2));
  await pool.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });