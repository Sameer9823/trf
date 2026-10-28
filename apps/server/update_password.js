const { Pool } = require('pg');
const argon2 = require('argon2');

const pool = new Pool({
  host: 'localhost',
  port: 5433,
  database: 'postgres',
  user: 'postgres',
  password: 'Sameer@9823'
});

async function updatePassword() {
  const password = 'Sameer@98231234';
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  
  console.log('New argon2 hash:', hash.substring(0, 30) + '...');
  
  const result = await pool.query(
    'UPDATE employees SET password_hash = $1 WHERE username = $2 RETURNING username',
    [hash, 'admin']
  );
  
  if (result.rowCount > 0) {
    console.log('Password updated for:', result.rows[0].username);
  } else {
    console.log('No rows updated');
  }
  
  pool.end();
}

updatePassword();