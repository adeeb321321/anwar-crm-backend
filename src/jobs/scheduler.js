// Server-side campaign scheduler.
//
// THIS IS THE FIX for the user's #1 prior failure: the old app used
// a browser setTimeout() for batch scheduling, which stopped the
// moment the phone screen locked or the browser closed. This runs
// as a cron job INSIDE the backend process, so it keeps working
// regardless of whether any phone or browser is open.
//
// Runs every minute, and for each campaign in status='running' whose
// next_batch_at has passed, sends the next batch of pending
// recipients and reschedules next_batch_at using the campaign's own
// configured interval (batch_interval_sec).
const cron = require('node-cron');
const pool = require('../db/pool');
const whatsapp = require('../services/whatsapp');

const MAX_RETRIES_DEFAULT = 3;
// Exponential backoff base for transient errors, in seconds.
const RETRY_BACKOFF_BASE_SEC = 300; // 5 min, 10 min, 20 min...

/**
 * Meta error codes that are safe to retry (rate limits, transient
 * network/server issues). Anything else (invalid number, template
 * rejected, recipient blocked business) is treated as permanent and
 * is NOT retried.
 */
const RETRYABLE_ERROR_CODES = new Set([
  '4',    // API Too Many Calls
  '80007', // rate limit hit
  '1',    // Unknown error (transient at Meta's end, generally safe to retry once)
  '131048', // Spam rate limit hit
  '131056', // (Re)engagement message limit
]);

async function processDueCampaignBatches() {
  const { rows: dueCampaigns } = await pool.query(
    `SELECT * FROM campaigns
     WHERE status = 'running' AND (next_batch_at IS NULL OR next_batch_at <= now())`
  );

  for (const campaign of dueCampaigns) {
    try {
      await sendNextBatch(campaign);
    } catch (err) {
      console.error(`[scheduler] campaign ${campaign.id} batch send failed:`, err.message);
      // Don't let one campaign's failure block others; move on.
    }
  }
}

async function sendNextBatch(campaign) {
  const nextBatchNumber = campaign.current_batch_number + 1;

  const { rows: recipients } = await pool.query(
    `SELECT cr.id AS recipient_id, cr.customer_id, c.phone_e164, c.name
     FROM campaign_recipients cr
     JOIN customers c ON c.id = cr.customer_id
     WHERE cr.campaign_id = $1 AND cr.batch_number = $2 AND cr.status = 'pending'
     ORDER BY cr.created_at ASC`,
    [campaign.id, nextBatchNumber]
  );

  if (recipients.length === 0) {
    // No more batches -- check if the whole campaign is done.
    const { rows: remaining } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM campaign_recipients
       WHERE campaign_id = $1 AND status = 'pending'`,
      [campaign.id]
    );

    if (remaining[0].count === 0) {
      await pool.query(
        `UPDATE campaigns SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [campaign.id]
      );
      console.log(`[scheduler] campaign ${campaign.id} completed.`);
    } else {
      // Odd state (e.g. batch numbering gap) -- advance batch pointer
      // and let the next tick look further.
      await pool.query(
        `UPDATE campaigns SET current_batch_number = $2, updated_at = now() WHERE id = $1`,
        [campaign.id, nextBatchNumber]
      );
    }
    return;
  }

  console.log(
    `[scheduler] campaign ${campaign.id}: sending batch ${nextBatchNumber} (${recipients.length} recipients)`
  );

  let template = null;
  if (campaign.use_template && campaign.template_id) {
    const { rows: tRows } = await pool.query('SELECT * FROM templates WHERE id = $1', [
      campaign.template_id,
    ]);
    template = tRows[0] || null;
  }

  for (const recipient of recipients) {
    await sendToRecipient(campaign, recipient, template);
  }

  // Advance batch pointer and schedule the next batch using this
  // campaign's OWN configured interval -- never a hardcoded value.
  const nextBatchAt = new Date(Date.now() + campaign.batch_interval_sec * 1000);
  await pool.query(
    `UPDATE campaigns
     SET current_batch_number = $2, next_batch_at = $3, updated_at = now()
     WHERE id = $1`,
    [campaign.id, nextBatchNumber, nextBatchAt]
  );
}

async function sendToRecipient(campaign, recipient, template) {
  const bodyComponents = buildTemplateComponents(campaign, template);

  const messageInsert = await pool.query(
    `INSERT INTO messages (
       campaign_id, campaign_recipient_id, customer_id, phone_e164,
       direction, template_id, body_snapshot, status, max_retries, last_attempt_at
     ) VALUES ($1,$2,$3,$4,'outbound',$5,$6,'queued',$7, now())
     RETURNING id`,
    [
      campaign.id,
      recipient.recipient_id,
      recipient.customer_id,
      recipient.phone_e164,
      template ? template.id : null,
      template ? template.body : campaign.message_text,
      MAX_RETRIES_DEFAULT,
    ]
  );
  const messageId = messageInsert.rows[0].id;

  try {
    const response = template
      ? await whatsapp.sendTemplateMessage(
          recipient.phone_e164,
          template.name,
          template.language,
          bodyComponents
        )
      : await whatsapp.sendTextMessage(recipient.phone_e164, campaign.message_text);

    const waMessageId = response?.messages?.[0]?.id || null;

    await pool.query(
      `UPDATE messages SET status = 'sent', wa_message_id = $2, sent_at = now() WHERE id = $1`,
      [messageId, waMessageId]
    );
    await pool.query(
      `UPDATE campaign_recipients SET status = 'sent', updated_at = now() WHERE id = $1`,
      [recipient.recipient_id]
    );
    await pool.query(
      `UPDATE customers SET last_contacted_at = now(), updated_at = now() WHERE id = $1`,
      [recipient.customer_id]
    );
    await pool.query(
      `INSERT INTO message_events (message_id, event_type, payload) VALUES ($1, 'sent', $2)`,
      [messageId, JSON.stringify(response)]
    );
  } catch (err) {
    await handleSendFailure(messageId, recipient, err);
  }
}

function buildTemplateComponents(campaign, template) {
  if (!template) return [];
  // Simple convention: campaign.price_used substitutes {{1}} if the
  // template body references a price variable. Extend this mapping
  // as more template variable types are needed.
  const params = [];
  if (campaign.price_used != null) {
    params.push({ type: 'text', text: String(campaign.price_used) });
  }
  if (params.length === 0) return [];
  return [{ type: 'body', parameters: params }];
}

async function handleSendFailure(messageId, recipient, err) {
  const metaError = err?.response?.data?.error;
  const errorCode = metaError?.code ? String(metaError.code) : 'unknown';
  const errorMessage = metaError?.message || err.message || 'Unknown send failure';

  const { rows } = await pool.query('SELECT retry_count, max_retries FROM messages WHERE id = $1', [
    messageId,
  ]);
  const { retry_count: retryCount, max_retries: maxRetries } = rows[0];

  const isRetryable = RETRYABLE_ERROR_CODES.has(errorCode) && retryCount < maxRetries;

  if (isRetryable) {
    const backoffSec = RETRY_BACKOFF_BASE_SEC * Math.pow(2, retryCount);
    const nextRetryAt = new Date(Date.now() + backoffSec * 1000);

    await pool.query(
      `UPDATE messages
       SET status = 'failed', error_code = $2, error_message = $3,
           retry_count = retry_count + 1, next_retry_at = $4
       WHERE id = $1`,
      [messageId, errorCode, errorMessage, nextRetryAt]
    );
    console.warn(
      `[scheduler] message ${messageId} failed (retryable, code ${errorCode}), retry #${
        retryCount + 1
      } at ${nextRetryAt.toISOString()}`
    );
    // Recipient stays 'pending'-equivalent implicitly via message retry;
    // campaign_recipients status only flips to 'failed' once retries exhaust.
  } else {
    await pool.query(
      `UPDATE messages SET status = 'failed', error_code = $2, error_message = $3 WHERE id = $1`,
      [messageId, errorCode, errorMessage]
    );
    await pool.query(
      `UPDATE campaign_recipients SET status = 'failed', updated_at = now() WHERE id = $1`,
      [recipient.recipient_id]
    );
    console.error(
      `[scheduler] message ${messageId} permanently failed (code ${errorCode}): ${errorMessage}`
    );
  }

  await pool.query(
    `INSERT INTO message_events (message_id, event_type, payload) VALUES ($1, 'failed', $2)`,
    [messageId, JSON.stringify({ code: errorCode, message: errorMessage })]
  );
}

/**
 * Separate tick: retries messages whose next_retry_at has passed.
 * Runs on the same cron schedule as the main batch processor.
 */
async function processDueRetries() {
  const { rows: dueRetries } = await pool.query(
    `SELECT m.*, c.phone_e164, cam.use_template, cam.message_text
     FROM messages m
     JOIN customers c ON c.id = m.customer_id
     JOIN campaigns cam ON cam.id = m.campaign_id
     WHERE m.status = 'failed' AND m.next_retry_at IS NOT NULL AND m.next_retry_at <= now()
       AND m.retry_count <= m.max_retries`
  );

  for (const msg of dueRetries) {
    try {
      let template = null;
      if (msg.template_id) {
        const { rows } = await pool.query('SELECT * FROM templates WHERE id = $1', [
          msg.template_id,
        ]);
        template = rows[0] || null;
      }

      const response = template
        ? await whatsapp.sendTemplateMessage(msg.phone_e164, template.name, template.language, [])
        : await whatsapp.sendTextMessage(msg.phone_e164, msg.message_text);

      const waMessageId = response?.messages?.[0]?.id || null;

      await pool.query(
        `UPDATE messages SET status = 'sent', wa_message_id = $2, sent_at = now(), next_retry_at = NULL WHERE id = $1`,
        [msg.id, waMessageId]
      );
      await pool.query(
        `UPDATE campaign_recipients SET status = 'sent', updated_at = now() WHERE id = $1`,
        [msg.campaign_recipient_id]
      );
    } catch (err) {
      await handleSendFailure(msg.id, { recipient_id: msg.campaign_recipient_id }, err);
    }
  }
}

function start() {
  // Every minute: check for due campaign batches and due retries.
  // node-cron keeps running as long as the Node process is alive --
  // on Railway/Render this means "as long as the service is deployed",
  // independent of any phone, browser, or client connection.
  cron.schedule('* * * * *', async () => {
    try {
      await processDueCampaignBatches();
      await processDueRetries();
    } catch (err) {
      console.error('[scheduler] tick error:', err);
    }
  });

  console.log('[scheduler] started -- checking for due campaign batches every minute.');
}

module.exports = { start, processDueCampaignBatches, processDueRetries };
