const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/customers -- paginated, filterable list
router.get('/', async (req, res) => {
  const { search, region, category, is_trader, opted_in_only, page = 1, pageSize = 50 } = req.query;

  const clauses = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(name ILIKE $${params.length} OR company ILIKE $${params.length} OR phone_e164 ILIKE $${params.length})`);
  }
  if (region && region !== 'كل اليمن') {
    params.push(region);
    clauses.push(`target_group = $${params.length}`);
  }
  if (category && category !== 'all') {
    params.push(`%${category}%`);
    clauses.push(`business_category ILIKE $${params.length}`);
  }
  if (is_trader === 'true') clauses.push('is_trader = true');
  if (opted_in_only === 'true') clauses.push('whatsapp_opt_in = true');
  clauses.push('opt_out = false');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const { rows } = await pool.query(
    `SELECT id, name, company, phone_e164, target_group, business_category,
            is_trader, whatsapp_opt_in, opt_out, last_contacted_at
     FROM customers ${where}
     ORDER BY created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM customers ${where}`,
    params
  );

  res.json({ data: rows, total: countRows[0].count, page: Number(page), pageSize: limit });
});

// GET /api/customers/stats -- dashboard summary numbers
router.get('/stats', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_customers,
      COUNT(*) FILTER (WHERE is_trader)::int AS traders,
      COUNT(*) FILTER (WHERE is_valid_yemeni_number)::int AS valid_numbers,
      COUNT(*) FILTER (WHERE whatsapp_opt_in)::int AS opted_in,
      COUNT(*) FILTER (WHERE opt_out)::int AS opted_out
    FROM customers
  `);
  res.json(rows[0]);
});

// POST /api/customers/:id/opt-out -- per-customer "stop messages" button
router.post('/:id/opt-out', async (req, res) => {
  const { id } = req.params;
  await pool.query(
    `UPDATE customers SET opt_out = true, opt_out_at = now(), whatsapp_opt_in = false WHERE id = $1`,
    [id]
  );
  await pool.query(
    `INSERT INTO consents (customer_id, action, source, note) VALUES ($1, 'opt_out', 'manual_admin', $2)`,
    [id, `Opted out by ${req.user.email}`]
  );
  res.json({ success: true });
});

// POST /api/customers/:id/opt-in -- manual opt-in (e.g. verbal consent recorded)
router.post('/:id/opt-in', async (req, res) => {
  const { id } = req.params;
  const { source, note } = req.body;
  await pool.query(
    `UPDATE customers SET whatsapp_opt_in = true, opt_in_source = $2, opt_in_at = now(), opt_out = false WHERE id = $1`,
    [id, source || 'manual_admin']
  );
  await pool.query(
    `INSERT INTO consents (customer_id, action, source, note) VALUES ($1, 'opt_in', $2, $3)`,
    [id, source || 'manual_admin', note || null]
  );
  res.json({ success: true });
});

module.exports = router;
