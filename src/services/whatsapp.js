// Thin wrapper around Meta's WhatsApp Cloud API (Graph API).
//
// Everything needed to talk to Meta lives in environment variables --
// NEVER hardcode tokens/ids here, and this module is never imported
// by anything that runs in a browser.
//
// Required env vars:
//   WHATSAPP_ACCESS_TOKEN      - long-lived System User token (Step 2 in Meta setup)
//   WHATSAPP_PHONE_NUMBER_ID   - the Phone Number ID for +967712191198 once linked
//   WHATSAPP_BUSINESS_ACCOUNT_ID - WABA id
//   GRAPH_API_VERSION          - defaults to v21.0 if unset
const axios = require('axios');

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';

function client() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error(
      'WhatsApp not configured: set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN env vars.'
    );
  }

  return axios.create({
    baseURL: `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

/**
 * Send a pre-approved WhatsApp template message.
 * @param {string} toE164 - recipient phone number, e.g. "+967771234567"
 * @param {string} templateName - must exactly match an APPROVED template name in Meta
 * @param {string} languageCode - e.g. "ar" or "ar_YE" -- must match template's configured language
 * @param {Array}  components - WhatsApp template components array (body params, etc.)
 */
async function sendTemplateMessage(toE164, templateName, languageCode, components = []) {
  const payload = {
    messaging_product: 'whatsapp',
    to: toE164.replace('+', ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  };

  const { data } = await client().post('/messages', payload);
  // data.messages[0].id is Meta's message id -- store this as wa_message_id
  return data;
}

/**
 * Send a free-form text message.
 * NOTE: Meta only allows free-form (non-template) messages within an
 * open 24-hour customer service window (i.e. the customer messaged
 * you first, recently). This is NOT for cold outbound campaigns --
 * use sendTemplateMessage for those. This function exists for
 * replying to inbound customer messages.
 */
async function sendTextMessage(toE164, bodyText) {
  const payload = {
    messaging_product: 'whatsapp',
    to: toE164.replace('+', ''),
    type: 'text',
    text: { body: bodyText },
  };

  const { data } = await client().post('/messages', payload);
  return data;
}

module.exports = {
  sendTemplateMessage,
  sendTextMessage,
};
