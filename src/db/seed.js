// Creates the first admin user so you can log in to the PWA.
// Usage: node src/db/seed.js "Adeeb" "admin@example.com" "yourpassword"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function seed() {
  const [, , name, email, password] = process.argv;
  if (!name || !email || !password) {
    console.error('Usage: node src/db/seed.js "<name>" "<email>" "<password>"');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [name, email, passwordHash]
  );

  console.log(`[seed] admin user ready: ${email}`);
  await pool.end();
}

seed().catch((err) => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
