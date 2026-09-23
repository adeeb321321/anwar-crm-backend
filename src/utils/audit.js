const pool = require('../db/pool');

async function logAction({ userId, action, entityType, entityId, details }) {
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, action, entityType || null, entityId || null, details ? JSON.stringify(details) : null]
  );
}

module.exports = { logAction };
