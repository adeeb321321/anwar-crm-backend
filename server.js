require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(helmet());
app.use(cors()); // PWA is served from a different origin (Netlify) than the API

// ---------------------------------------------------------------
// IMPORTANT: the webhook route needs the RAW request body to verify
// Meta's X-Hub-Signature-256 header, so it must be mounted with
// express.raw() BEFORE the global express.json() parser below.
// If you add express.json() first, req.body will already be a
// parsed object by the time the webhook route sees it, and
// signature verification will fail.
// ---------------------------------------------------------------
app.use(
  '/webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/webhook')
);

// Standard JSON body parsing for every other route.
app.use(express.json({ limit: '2mb' }));

// Basic rate limiting on the public API surface.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
app.use('/api', apiLimiter);

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/products', require('./routes/products'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/reports', require('./routes/reports'));

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);

  // Start the server-side campaign scheduler. This is what replaces
  // the old browser setTimeout() approach -- it runs inside this
  // long-lived Node process and keeps working whether or not any
  // phone or browser is connected.
  require('./jobs/scheduler').start();
});
