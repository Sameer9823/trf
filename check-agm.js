const { pool } = require('./apps/server/src/db.js');
pool.query("SELECT id, full_name, role, designation, is_active FROM employees WHERE designation = 'AGM' OR role = 'AGM'")
  .then(r => {
    console.log('Active AGM accounts:', r.rows.filter(x => x.is_active).length);
    console.log('All matching rows:', JSON.stringify(r.rows, null, 2));
    process.exit(0);
  })
  .catch(e => { console.error(e); process.exit(1); });