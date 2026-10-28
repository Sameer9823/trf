const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost',
  port: 5433,
  database: 'postgres',
  user: 'postgres',
  password: 'Sameer@9823'
});
pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'trfs' AND indexname LIKE 'idx_trfs_%'")
  .then(r => { console.log(r.rows); pool.end(); })
  .catch(e => { console.error(e); pool.end(); });