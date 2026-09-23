const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/reports/dashboard -- the numbers for the main dashboard screen
router.get('/dashboard', async (req, res) => {
  const [customerStats, campaignStats, messageStats] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total_customers,
        COUNT(*) FILTER (WHERE is_trader)::int AS traders,
        COUNT(*) FILTER (WHERE is_valid_yemeni_number)::int AS valid_numbers,
        COUNT(*) FILTER (WHERE opt_out)::int AS opted_out
      FROM customers
    `),
    pool.query(`
      SELECT
        COUNT(*)::int AS total_campaigns,
        COUNT(*) FILTER (WHERE status = 'running')::int AS active_campaigns
      FROM campaigns
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent' OR sent_at IS NOT NULL)::int AS sent,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER (WHERE read_at IS NOT NULL)::int AS read,
        COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM messages WHERE direction = 'outbound'
    `),
  ]);

  const { rows: recipientStatusRows } = await pool.query(`
    SELECT status, COUNT(*)::int AS count FROM campaign_recipients GROUP BY status
  `);
  const recipientStatusCounts = {};
  for (const r of recipientStatusRows) recipientStatusCounts[r.status] = r.count;

  res.json({
    customers: customerStats.rows[0],
    campaigns: campaignStats.rows[0],
    messages: messageStats.rows[0],
    recipientStatusCounts, // includes interested/price_requested/quantity_requested/sale counts
  });
});

module.exports = router;
