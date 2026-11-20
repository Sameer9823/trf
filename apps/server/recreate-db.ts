import pg from 'pg';
const { Client } = pg;
async function main() {
  const client = new Client({ host: 'localhost', user: 'postgres', password: 'postgres', database: 'postgres' });
  await client.connect();
  await client.query('DROP DATABASE IF EXISTS trf_test');
  await client.query('CREATE DATABASE trf_test');
  try {
    await client.query("CREATE USER trf_test WITH PASSWORD 'test-only'");
  } catch (e) {
    await client.query("ALTER USER trf_test WITH PASSWORD 'test-only'");
  }
  await client.query('GRANT ALL PRIVILEGES ON DATABASE trf_test TO trf_test');
  await client.end();
  console.log('Database recreated');
}
main();
