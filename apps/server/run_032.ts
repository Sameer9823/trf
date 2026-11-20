import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '032_assignment_result_review.sql'), 'utf8');
console.log('Running migration 032...');
try {
  await pool.query('BEGIN');
  await pool.query(sql);
  await pool.query('COMMIT');
  console.log('Migration 032 applied successfully');
} catch (err) {
  await pool.query('ROLLBACK');
  console.error('Migration 032 failed:', (err as Error).message);
}
await pool.end();
