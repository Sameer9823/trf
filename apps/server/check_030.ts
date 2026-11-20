import { pool } from './src/db.js';

// Check if ard_assignment_results table exists
const tableCheck = await pool.query("SELECT * FROM information_schema.tables WHERE table_name = 'ard_assignment_results'");
console.log('ard_assignment_results table exists:', tableCheck.rows.length > 0);

// Check trf_approvals constraint
const constraintCheck = await pool.query("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'trf_approvals'::regclass AND contype = 'c'");
console.log('trf_approvals constraints:', constraintCheck.rows);

// Check ard_test_assignment_history constraint
const historyConstraint = await pool.query("SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'ard_test_assignment_history'::regclass AND contype = 'c'");
console.log('ard_test_assignment_history constraints:', historyConstraint.rows);

// Check ard_test_assignments columns
const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'ard_test_assignments'");
console.log('ard_test_assignments columns:', columns.rows.map(r => r.column_name));

await pool.end();
