-- ============================================================
-- Anwar Al-Juntain WhatsApp CRM — Database Schema (PostgreSQL)
-- ============================================================
-- Design notes:
--   * Every campaign-facing entity uses UUID primary keys so IDs
--     are safe to expose in the PWA / API without leaking row counts.
--   * customers table is the master file. Campaigns NEVER write to it
--     except for opt_in/opt_out fields (explicit user action) and
--     last_contacted_at bookkeeping.
--   * campaign_recipients has a UNIQUE(campaign_id, customer_id)
--     constraint -- this is the DB-level duplicate-prevention the
--     user explicitly required. A customer CAN appear in multiple
--     different campaigns, just not twice in the same one.
--   * messages / message_events separate the "one send attempt"
--     record from the "timeline of status updates" for that send,
--     so retries and webhook events don't overwrite history.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------
-- USERS / ADMIN (for audit log attribution + simple auth)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin', -- admin | staff
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- CUSTOMERS (master database — imported from CSV, never deleted
-- or overwritten by campaign logic)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT,
  company                TEXT,               -- الجهة/الشركة
  phone_raw              TEXT,               -- الرقم الأصلي (as imported)
  phone_e164             TEXT,               -- normalized +9677XXXXXXXX
  country                TEXT,
  status                 TEXT,               -- صالح / مشكوك فيه / بدون رقم / غير قابل للتحليل
  business_category      TEXT,               -- الفئات_المهنية (raw, from CSV)
  detected_locations     TEXT,               -- المواقع_المكتشفة
  target_group           TEXT,               -- مجموعة_الاستهداف: الجنوب / الشمال / ''
  is_trader              BOOLEAN NOT NULL DEFAULT false,   -- تاجر_وفق_قواعدك
  classification_grade   TEXT,               -- درجة_التصنيف
  is_duplicate_phone      BOOLEAN NOT NULL DEFAULT false,   -- مكرر_رقم (from CSV)
  is_valid_yemeni_number  BOOLEAN NOT NULL DEFAULT false,   -- رقم_صالح_يمني (from CSV)

  -- Opt-in / consent (WhatsApp commercial messaging compliance)
  whatsapp_opt_in   BOOLEAN NOT NULL DEFAULT false,
  opt_in_source     TEXT,          -- e.g. 'csv_import_legacy', 'customer_replied', 'manual'
  opt_in_at         TIMESTAMPTZ,
  opt_out           BOOLEAN NOT NULL DEFAULT false,
  opt_out_at        TIMESTAMPTZ,

  last_contacted_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone_e164 ON customers(phone_e164);
CREATE INDEX IF NOT EXISTS idx_customers_is_trader ON customers(is_trader);
CREATE INDEX IF NOT EXISTS idx_customers_target_group ON customers(target_group);
CREATE INDEX IF NOT EXISTS idx_customers_opt_out ON customers(opt_out);
-- Prevent the exact same phone number being imported twice as separate rows
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_phone_e164_notnull
  ON customers(phone_e164) WHERE phone_e164 IS NOT NULL AND phone_e164 <> '';

-- ---------------------------------------------------------------
-- PRODUCTS (generic — not tied to any one campaign)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  sku          TEXT,
  image_url    TEXT,
  description  TEXT,
  notes        TEXT,
  -- Regional pricing lives here, NOT as a single fixed price,
  -- because the user's business has South/North pricing that differs.
  price_south      NUMERIC(12,2),
  price_north      NUMERIC(12,2),
  currency         TEXT NOT NULL DEFAULT 'SAR',
  min_order_qty    INTEGER,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- MESSAGE TEMPLATES (mirrors WhatsApp-approved templates; the
-- source of truth for template status still lives at Meta, this
-- table just tracks what we believe the state to be)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,       -- must match Meta template name exactly
  language        TEXT NOT NULL DEFAULT 'ar',
  category        TEXT NOT NULL,       -- MARKETING | UTILITY | AUTHENTICATION
  body            TEXT NOT NULL,       -- template body text with {{1}} {{2}} placeholders
  variables       JSONB,               -- ordered list describing each {{n}} placeholder
  status          TEXT NOT NULL DEFAULT 'pending', -- approved | pending | rejected | paused
  meta_template_id TEXT,               -- id assigned by Meta once submitted
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- CAMPAIGNS
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  product_id        UUID REFERENCES products(id),
  template_id       UUID REFERENCES templates(id),

  -- Targeting filters (applied at "preview" time against customers;
  -- never mutates the customers table)
  region            TEXT NOT NULL DEFAULT 'كل اليمن',  -- الجنوب | الشمال | كل اليمن
  business_category TEXT,                              -- matches customers.business_category, 'all' = no filter
  opted_in_only     BOOLEAN NOT NULL DEFAULT true,

  -- Pricing used for THIS campaign (campaign picks which of the
  -- product's regional prices to quote, since a single campaign
  -- might target one region or show region-specific pricing)
  price_used        NUMERIC(12,2),

  message_text      TEXT,             -- rendered/free-text message body (non-template sends)
  use_template       BOOLEAN NOT NULL DEFAULT true,

  -- Batch / scheduling configuration
  batch_size         INTEGER NOT NULL DEFAULT 25,
  batch_interval_sec INTEGER NOT NULL DEFAULT 14400, -- default 4 hours, fully configurable
  max_recipients      INTEGER,          -- optional cap on total campaign size

  status            TEXT NOT NULL DEFAULT 'draft',
    -- draft | ready | running | paused | completed | cancelled

  current_batch_number INTEGER NOT NULL DEFAULT 0,
  next_batch_at         TIMESTAMPTZ,

  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ
);

-- ---------------------------------------------------------------
-- CAMPAIGN_RECIPIENTS — the frozen list of who this campaign will
-- reach, computed once at "prepare" time. This is what makes
-- resume-after-crash and duplicate-prevention possible: it is the
-- single source of truth for "who is in this campaign and what
-- batch are they in", independent of the live customers table.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id),
  batch_number INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
    -- pending | queued | sent | delivered | read | replied | failed
    -- | blocked | opted_out | interested | price_requested
    -- | quantity_requested | sale
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- THE core duplicate-prevention constraint the user required:
  UNIQUE(campaign_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_status
  ON campaign_recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_batch
  ON campaign_recipients(campaign_id, batch_number);

-- ---------------------------------------------------------------
-- MESSAGES — one row per actual send ATTEMPT to Meta's API.
-- Retries create new rows (linked via retry_of_message_id) rather
-- than overwriting, so the full attempt history is preserved.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          UUID REFERENCES campaigns(id),
  campaign_recipient_id UUID REFERENCES campaign_recipients(id),
  customer_id          UUID NOT NULL REFERENCES customers(id),
  phone_e164           TEXT NOT NULL,

  direction            TEXT NOT NULL DEFAULT 'outbound', -- outbound | inbound
  wa_message_id        TEXT,           -- Meta's message id (for webhook correlation)
  template_id          UUID REFERENCES templates(id),
  body_snapshot        TEXT,           -- exact text/template payload actually sent

  status               TEXT NOT NULL DEFAULT 'pending',
    -- pending | queued | sent | delivered | read | failed
  error_code           TEXT,
  error_message        TEXT,

  retry_count           INTEGER NOT NULL DEFAULT 0,
  max_retries            INTEGER NOT NULL DEFAULT 3,
  retry_of_message_id     UUID REFERENCES messages(id),
  last_attempt_at         TIMESTAMPTZ,
  next_retry_at            TIMESTAMPTZ,

  sent_at              TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  read_at               TIMESTAMPTZ,
  replied_at             TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_wa_message_id ON messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_next_retry ON messages(next_retry_at)
  WHERE status = 'failed';

-- ---------------------------------------------------------------
-- MESSAGE_EVENTS — append-only timeline of every status change /
-- webhook event for a message (delivered, read, replied, etc.)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL, -- sent | delivered | read | failed | replied | button_clicked
  payload     JSONB,         -- raw webhook payload for that event, for debugging
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_events_message ON message_events(message_id);

-- ---------------------------------------------------------------
-- CONSENTS — explicit log of opt-in/opt-out actions (separate from
-- the current-state flags on customers, so we keep full history)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id),
  action       TEXT NOT NULL, -- opt_in | opt_out
  source       TEXT,          -- 'whatsapp_reply', 'manual_admin', 'csv_import'
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- WEBHOOK_EVENTS — raw inbound log from Meta, with idempotency
-- guard (Meta's own event id, when present, is unique)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_event_key  TEXT UNIQUE,   -- derived idempotency key (see webhook handler)
  event_type      TEXT,
  raw_payload     JSONB NOT NULL,
  processed       BOOLEAN NOT NULL DEFAULT false,
  processed_at    TIMESTAMPTZ,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- SETTINGS — key/value store for things like current active
-- WhatsApp phone_number_id, region rules version, etc.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- AUDIT_LOG — who did what, when
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  action      TEXT NOT NULL, -- campaign_created | campaign_started | campaign_stopped |
                              -- campaign_resumed | settings_changed | message_edited | ...
  entity_type TEXT,          -- 'campaign' | 'product' | 'template' | 'settings'
  entity_id   UUID,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
