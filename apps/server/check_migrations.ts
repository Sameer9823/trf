import { pool } from './src/db.js';
const r = await pool.query('SELECT * FROM schema_migrations ORDER BY name');
console.log(r.rows);
await pool.end();
