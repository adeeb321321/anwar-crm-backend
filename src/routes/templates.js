const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM templates ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, language, category, body, variables } = req.body;
  if (!name || !category || !body) {
    return res.status(400).json({ error: 'name, category, and body are required' });
  }

  const { rows } = await pool.query(
    `INSERT INTO templates (name, language, category, body, variables, status)
     VALUES ($1, COALESCE($2,'ar'), $3, $4, $5, 'pending')
     RETURNING *`,
    [name, language, category, body, variables ? JSON.stringify(variables) : null]
  );
  res.status(201).json(rows[0]);
});

// Manually mark a template's approval status once you've submitted
// it in Meta's UI and it comes back approved/rejected -- Meta does
// not push template status changes to our webhook automatically for
// all account types, so this stays a manual sync for now.
router.patch('/:id/status', async (req, res) => {
  const { status, meta_template_id } = req.body;
  const allowed = ['approved', 'pending', 'rejected', 'paused'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }

  const { rows } = await pool.query(
    `UPDATE templates SET status = $2, meta_template_id = COALESCE($3, meta_template_id), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, status, meta_template_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

module.exports = router;
