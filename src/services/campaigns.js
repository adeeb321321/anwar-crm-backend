// Core campaign business logic: building the target list (filtering,
// never mutating customers), computing batches, and lifecycle
// transitions (start / pause / resume). The actual sending loop lives
// in jobs/scheduler.js -- this file only prepares state.
const pool = require('../db/pool');

/**
 * Build the WHERE clause + params for a campaign's targeting filters.
 * Shared by both previewCampaign() and prepareCampaign() so the
 * preview count always matches what actually gets queued.
 */
function buildTargetQuery({ region, businessCategory, optedInOnly }) {
  const clauses = [
    'is_trader = true',
    "is_valid_yemeni_number = true",
    'opt_out = false',
  ];
  const params = [];

  if (region && region !== 'كل اليمن') {
    params.push(region);
    clauses.push(`target_group = $${params.length}`);
  }

  if (businessCategory && businessCategory !== 'all') {
    params.push(`%${businessCategory}%`);
    clauses.push(`business_category ILIKE $${params.length}`);
  }

  if (optedInOnly) {
    clauses.push('whatsapp_opt_in = true');
  }

  return { where: clauses.join(' AND '), params };
}

/**
 * Preview how many customers match a campaign's targeting filters,
 * without creating any campaign_recipients rows yet.
 */
async function previewAudience({ region, businessCategory, optedInOnly, maxRecipients }) {
  const { where, params } = buildTargetQuery({ region, businessCategory, optedInOnly });
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM customers WHERE ${where}`,
    params
  );
  const total = rows[0].count;
  return {
    matchingCustomers: total,
    willTarget: maxRecipients ? Math.min(total, maxRecipients) : total,
  };
}

/**
 * Freeze the recipient list for a campaign: selects matching
 * customers, assigns each to a batch number, and inserts into
 * campaign_recipients. This is idempotent-safe via the UNIQUE
 * (campaign_id, customer_id) constraint -- calling prepare twice
 * on the same campaign will simply skip already-added recipients.
 */
async function prepareCampaign(campaignId) {
  const { rows: campaignRows } = await pool.query(
    'SELECT * FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaignRows.length) throw new Error('Campaign not found');
  const campaign = campaignRows[0];

  const { where, params } = buildTargetQuery({
    region: campaign.region,
    businessCategory: campaign.business_category,
    optedInOnly: campaign.opted_in_only,
  });

  let query = `SELECT id FROM customers WHERE ${where} ORDER BY created_at ASC`;
  if (campaign.max_recipients) {
    params.push(campaign.max_recipients);
    query += ` LIMIT $${params.length}`;
  }

  const { rows: customers } = await pool.query(query, params);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchSize = campaign.batch_size || 25;
    let insertedCount = 0;

    for (let i = 0; i < customers.length; i++) {
      const batchNumber = Math.floor(i / batchSize) + 1;
      const customerId = customers[i].id;

      const result = await client.query(
        `INSERT INTO campaign_recipients (campaign_id, customer_id, batch_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (campaign_id, customer_id) DO NOTHING
         RETURNING id`,
        [campaignId, customerId, batchNumber]
      );
      if (result.rows.length) insertedCount++;
    }

    await client.query(
      `UPDATE campaigns SET status = 'ready', updated_at = now() WHERE id = $1`,
      [campaignId]
    );

    await client.query('COMMIT');
    return { totalRecipients: customers.length, newlyAdded: insertedCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Start (or resume) a campaign: sets status='running' and computes
 * next_batch_at. If the campaign was previously paused mid-way,
 * this does NOT reset current_batch_number -- the scheduler picks
 * up from wherever campaign_recipients says sending left off.
 */
async function startCampaign(campaignId) {
  const { rows } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) throw new Error('Campaign not found');
  const campaign = rows[0];

  if (!['ready', 'paused'].includes(campaign.status)) {
    throw new Error(`Cannot start campaign in status '${campaign.status}'`);
  }

  const isFirstStart = !campaign.started_at;

  await pool.query(
    `UPDATE campaigns
     SET status = 'running',
         started_at = COALESCE(started_at, now()),
         next_batch_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [campaignId]
  );

  return { resumed: !isFirstStart };
}

async function pauseCampaign(campaignId) {
  await pool.query(
    `UPDATE campaigns SET status = 'paused', updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [campaignId]
  );
}

/**
 * Compute crash-recovery status for a campaign: what's been sent,
 * what failed, what remains, and when the next batch is due.
 */
async function getCampaignStatus(campaignId) {
  const { rows: statusRows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count
     FROM campaign_recipients WHERE campaign_id = $1
     GROUP BY status`,
    [campaignId]
  );

  const { rows: campaignRows } = await pool.query(
    'SELECT * FROM campaigns WHERE id = $1',
    [campaignId]
  );

  const counts = {};
  for (const r of statusRows) counts[r.status] = r.count;

  return {
    campaign: campaignRows[0] || null,
    recipientStatusCounts: counts,
  };
}

module.exports = {
  buildTargetQuery,
  previewAudience,
  prepareCampaign,
  startCampaign,
  pauseCampaign,
  getCampaignStatus,
};
