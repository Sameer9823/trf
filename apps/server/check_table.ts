import { pool } from './src/db.js';
const r = await pool.query("SELECT * FROM information_schema.tables WHERE table_name = 'ard_assignment_results'");
console.log('Table exists:', r.rows.length > 0);
if (r.rows.length > 0) {
  const cols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ard_assignment_results'");
  console.log('Columns:', cols.rows);
}
await pool.end();
