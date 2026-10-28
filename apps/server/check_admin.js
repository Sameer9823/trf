const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost',
  port: 5433,
  database: 'postgres',
  user: 'postgres',
  password: 'Sameer@9823'
});

pool.query('SELECT username, role, is_active, must_change_password FROM employees WHERE username = $1', ['admin'])
  .then(r => { 
    console.log('Admin user:', r.rows[0] || 'NOT FOUND');
    pool.end(); 
  })
  .catch(e => { 
    console.error('Error:', e.message); 
    pool.end(); 
  });