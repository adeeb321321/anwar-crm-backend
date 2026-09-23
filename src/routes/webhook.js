// WhatsApp Cloud API webhook endpoint.
//
// Two responsibilities:
//   1. GET  /webhook -- Meta's one-time verification handshake
//   2. POST /webhook -- receives status updates (sent/delivered/read/
//      failed) and inbound customer messages, with signature
//      verification and idempotent processing.
//
// Required env vars:
//   WEBHOOK_VERIFY_TOKEN - a secret string YOU choose; must match
//                           exactly what you type into Meta's
//                           "Verify token" field during webhook setup.
//   META_APP_SECRET       - used to verify the X-Hub-Signature-256
//                           header so we know requests genuinely
//                           came from Meta.
const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');

const router = express.Router();

// --- 1. Verification handshake (Meta calls this once when you save
//        the Callback URL in the dashboard) --------------------------
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[webhook] verification succeeded');
    return res.status(200).send(challenge);
  }

  console.warn('[webhook] verification FAILED -- token mismatch or wrong mode');
  return res.sendStatus(403);
});

// --- 2. Signature verification middleware ----------------------------
// Applied only to the POST route below. Requires the raw request body,
// so server.js must mount this route with express.raw() BEFORE any
// express.json() body parsing -- see server.js comments.
function verifySignature(req, res, next) {
  const signature = req.get('X-Hub-Signature-256');
  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret) {
    console.warn('[webhook] META_APP_SECRET not set -- skipping signature check (dev only!)');
    return next();
  }

  if (!signature) {
    return res.sendStatus(401);
  }

  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(req.body) // raw Buffer, set by express.raw()
    .digest('hex');
  const expectedSignature = `sha256=${expectedHash}`;

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    console.warn('[webhook] signature verification FAILED');
    return res.sendStatus(401);
  }

  next();
}

// --- 3. Inbound event handler -----------------------------------------
router.post('/', verifySignature, async (req, res) => {
  // Body was parsed as raw Buffer for signature verification; parse
  // JSON manually here.
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('[webhook] invalid JSON body');
    return res.sendStatus(400);
  }

  // Always ACK fast -- Meta will retry aggressively if we're slow or
  // return non-2xx. Process asynchronously after responding.
  res.sendStatus(200);

  try {
    await processWebhookPayload(payload);
  } catch (err) {
    console.error('[webhook] processing error:', err);
  }
});

async function processWebhookPayload(payload) {
  if (payload.object !== 'whatsapp_business_account') return;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value) continue;

      // Idempotency: derive a stable key for this specific change so
      // re-delivered webhooks (Meta retries on any non-200, and can
      // also just double-send) don't get processed twice.
      const idempotencyKey = deriveIdempotencyKey(entry, change);

      const inserted = await pool.query(
        `INSERT INTO webhook_events (meta_event_key, event_type, raw_payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (meta_event_key) DO NOTHING
         RETURNING id`,
        [idempotencyKey, change.field, JSON.stringify(change)]
      );

      if (inserted.rows.length === 0) {
        // Already processed this exact event -- skip.
        continue;
      }

      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status);
        }
      }

      if (value.messages) {
        for (const message of value.messages) {
          await handleInboundMessage(message, value.contacts);
        }
      }

      await pool.query(
        `UPDATE webhook_events SET processed = true, processed_at = now()
         WHERE meta_event_key = $1`,
        [idempotencyKey]
      );
    }
  }
}

function deriveIdempotencyKey(entry, change) {
  // Meta doesn't give a single global event id, so we build one from
  // stable fields: entry id + change field + a hash of the value.
  const raw = `${entry.id}:${change.field}:${JSON.stringify(change.value)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function handleStatusUpdate(status) {
  // status.id = wa_message_id, status.status = sent|delivered|read|failed
  const { rows } = await pool.query('SELECT id FROM messages WHERE wa_message_id = $1', [
    status.id,
  ]);
  if (!rows.length) {
    console.warn(`[webhook] status update for unknown wa_message_id ${status.id}`);
    return;
  }
  const messageId = rows[0].id;

  const columnMap = {
    sent: 'sent_at',
    delivered: 'delivered_at',
    read: 'read_at',
  };

  if (columnMap[status.status]) {
    await pool.query(
      `UPDATE messages SET status = $2, ${columnMap[status.status]} = to_timestamp($3) WHERE id = $1`,
      [messageId, status.status, status.timestamp]
    );
  } else if (status.status === 'failed') {
    const err = status.errors?.[0];
    await pool.query(
      `UPDATE messages SET status = 'failed', error_code = $2, error_message = $3 WHERE id = $1`,
      [messageId, err?.code ? String(err.code) : null, err?.title || null]
    );
  }

  // Mirror onto campaign_recipients so campaign-level reporting stays current.
  const { rows: msgRows } = await pool.query(
    'SELECT campaign_recipient_id FROM messages WHERE id = $1',
    [messageId]
  );
  const recipientId = msgRows[0]?.campaign_recipient_id;
  if (recipientId && ['delivered', 'read', 'failed'].includes(status.status)) {
    await pool.query(
      `UPDATE campaign_recipients SET status = $2, updated_at = now() WHERE id = $1`,
      [recipientId, status.status]
    );
  }

  await pool.query(
    `INSERT INTO message_events (message_id, event_type, payload) VALUES ($1, $2, $3)`,
    [messageId, status.status, JSON.stringify(status)]
  );
}

async function handleInboundMessage(message, contacts) {
  const fromPhone = '+' + message.from;

  const { rows: customerRows } = await pool.query(
    'SELECT id FROM customers WHERE phone_e164 = $1',
    [fromPhone]
  );

  let customerId = customerRows[0]?.id || null;

  // If this phone isn't in our master database at all, create a
  // minimal customer record so the reply is still tracked. This
  // does NOT touch the master CSV-imported data -- it's a new row.
  if (!customerId) {
    const contactName = contacts?.[0]?.profile?.name || null;
    const inserted = await pool.query(
      `INSERT INTO customers (name, phone_e164, is_valid_yemeni_number, country)
       VALUES ($1, $2, $3, 'Yemen')
       ON CONFLICT (phone_e164) WHERE phone_e164 IS NOT NULL AND phone_e164 <> ''
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [contactName, fromPhone, /^\+9677[0137]\d{7}$/.test(fromPhone)]
    );
    customerId = inserted.rows[0].id;
  }

  const bodyText = message.text?.body || null;

  await pool.query(
    `INSERT INTO messages (customer_id, phone_e164, direction, wa_message_id, body_snapshot, status, replied_at)
     VALUES ($1, $2, 'inbound', $3, $4, 'delivered', now())`,
    [customerId, fromPhone, message.id, bodyText]
  );

  // Mark most recent outbound campaign_recipient for this customer as
  // 'replied' so campaign reporting reflects engagement. Simple
  // keyword detection can be layered on later for
  // interested/price_requested/quantity_requested classification.
  await pool.query(
    `UPDATE campaign_recipients
     SET status = 'replied', updated_at = now()
     WHERE customer_id = $1 AND status IN ('sent','delivered','read')
     AND campaign_id = (
       SELECT campaign_id FROM campaign_recipients
       WHERE customer_id = $1 AND status IN ('sent','delivered','read')
       ORDER BY updated_at DESC LIMIT 1
     )`,
    [customerId]
  );

  // Basic opt-out keyword detection (Arabic + English), per WhatsApp
  // commerce policy best practice.
  if (bodyText && /(ايقاف|إيقاف|توقف|stop|unsubscribe)/i.test(bodyText)) {
    await pool.query(
      `UPDATE customers SET opt_out = true, opt_out_at = now(), whatsapp_opt_in = false WHERE id = $1`,
      [customerId]
    );
    await pool.query(
      `INSERT INTO consents (customer_id, action, source, note)
       VALUES ($1, 'opt_out', 'whatsapp_reply', $2)`,
      [customerId, bodyText]
    );
    console.log(`[webhook] customer ${customerId} opted out via reply`);
  }
}

module.exports = router;
