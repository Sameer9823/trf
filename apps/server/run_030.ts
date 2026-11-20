import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '030_trf_submit_and_complete.sql'), 'utf8');
console.log('Running migration 030...');
try {
  await pool.query('BEGIN');
  await pool.query(sql);
  await pool.query('COMMIT');
  console.log('Migration 030 applied successfully');
} catch (err) {
  await pool.query('ROLLBACK');
  console.error('Migration 030 failed:', (err as Error).message);
}
await pool.end();
