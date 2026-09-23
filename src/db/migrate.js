// Applies schema.sql to the configured database.
// Safe to run multiple times: every statement uses IF NOT EXISTS.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('[migrate] applying schema.sql ...');
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('[migrate] done. All tables/indexes are up to date.');
  } finally {
    client.release();
  }
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
