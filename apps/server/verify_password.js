const { Pool } = require('pg');
const argon2 = require('argon2');

const pool = new Pool({
  host: 'localhost',
  port: 5433,
  database: 'postgres',
  user: 'postgres',
  password: 'Sameer@9823'
});

async function verifyPassword() {
  const result = await pool.query('SELECT password_hash FROM employees WHERE username = $1', ['admin']);
  const hash = result.rows[0].password_hash;
  console.log('Stored hash:', hash.substring(0, 30) + '...');
  
  const testPassword = 'Sameer@98231234';
  const isValid = await argon2.verify(hash, testPassword);
  console.log('Password match:', isValid);
  
  pool.end();
}

verifyPassword();