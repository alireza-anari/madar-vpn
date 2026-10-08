import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required');

const client = new Client({ connectionString });
await client.connect();
try {
  const ping = await client.query('SELECT 1::int AS ok');
  if (ping.rows[0]?.ok !== 1) throw new Error('PostgreSQL driver smoke query failed');

  await client.query('BEGIN');
  try {
    await client.query('CREATE TEMP TABLE madar_runtime_smoke(value text)');
    await client.query('INSERT INTO madar_runtime_smoke(value) VALUES ($1)', ['rollback-witness']);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  const rolledBack = await client.query("SELECT to_regclass('pg_temp.madar_runtime_smoke') AS relation");
  if (rolledBack.rows[0]?.relation !== null) {
    throw new Error('PostgreSQL transaction rollback smoke check failed');
  }

  console.log('PostgreSQL runtime driver smoke passed');
} finally {
  await client.end();
}
