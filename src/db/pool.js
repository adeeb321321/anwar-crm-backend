// Central PostgreSQL connection pool.
// Reads DATABASE_URL from environment (Railway/Render inject this
// automatically when you attach a Postgres service).
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Railway, Render, Supabase) require SSL
  // in production but not always locally -- this handles both.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // Idle client errors should not crash the whole process
  console.error('[db pool] unexpected error on idle client', err);
});

module.exports = pool;
