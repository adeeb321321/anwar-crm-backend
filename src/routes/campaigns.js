const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const campaignService = require('../services/campaigns');
const { logAction } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/campaigns -- list all campaigns
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, p.name AS product_name
     FROM campaigns c LEFT JOIN products p ON p.id = c.product_id
     ORDER BY c.created_at DESC`
  );
  res.json(rows);
});

// GET /api/campaigns/:id -- full detail + recipient status breakdown
router.get('/:id', async (req, res) => {
  const status = await campaignService.getCampaignStatus(req.params.id);
  if (!status.campaign) return res.status(404).json({ error: 'not found' });
  res.json(status);
});

// POST /api/campaigns -- create a draft campaign
router.post('/', async (req, res) => {
  const {
    name, product_id, template_id, region, business_category,
    opted_in_only, price_used, message_text, use_template,
    batch_size, batch_interval_sec, max_recipients,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await pool.query(
    `INSERT INTO campaigns (
       name, product_id, template_id, region, business_category,
       opted_in_only, price_used, message_text, use_template,
       batch_size, batch_interval_sec, max_recipients, created_by, status
     ) VALUES ($1,$2,$3,COALESCE($4,'كل اليمن'),$5,COALESCE($6,true),$7,$8,COALESCE($9,true),
               COALESCE($10,25),COALESCE($11,14400),$12,$13,'draft')
     RETURNING *`,
    [
      name, product_id, template_id, region, business_category,
      opted_in_only, price_used, message_text, use_template,
      batch_size, batch_interval_sec, max_recipients, req.user.id,
    ]
  );

  const campaign = rows[0];
  await logAction({
    userId: req.user.id,
    action: 'campaign_created',
    entityType: 'campaign',
    entityId: campaign.id,
    details: { name },
  });

  res.status(201).json(campaign);
});

// GET /api/campaigns/preview?region=&business_category=&opted_in_only=&max_recipients=
// "معاينة العملاء" -- preview audience size WITHOUT creating recipients yet
router.get('/preview/audience', async (req, res) => {
  const { region, business_category, opted_in_only, max_recipients } = req.query;
  const result = await campaignService.previewAudience({
    region,
    businessCategory: business_category,
    optedInOnly: opted_in_only !== 'false',
    maxRecipients: max_recipients ? parseInt(max_recipients, 10) : null,
  });
  res.json(result);
});

// POST /api/campaigns/:id/prepare -- freeze recipient list + assign batches
router.post('/:id/prepare', async (req, res) => {
  try {
    const result = await campaignService.prepareCampaign(req.params.id);
    await logAction({
      userId: req.user.id,
      action: 'campaign_prepared',
      entityType: 'campaign',
      entityId: req.params.id,
      details: result,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/start -- "بدء الحملة" (also handles resume)
router.post('/:id/start', async (req, res) => {
  try {
    const result = await campaignService.startCampaign(req.params.id);
    await logAction({
      userId: req.user.id,
      action: result.resumed ? 'campaign_resumed' : 'campaign_started',
      entityType: 'campaign',
      entityId: req.params.id,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pause -- "إيقاف الحملة"
router.post('/:id/pause', async (req, res) => {
  await campaignService.pauseCampaign(req.params.id);
  await logAction({
    userId: req.user.id,
    action: 'campaign_paused',
    entityType: 'campaign',
    entityId: req.params.id,
  });
  res.json({ success: true });
});

module.exports = router;
