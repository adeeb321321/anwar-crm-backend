// Minimal JWT auth. Given this is a single-business internal tool
// (not a multi-tenant SaaS), this stays deliberately simple: one or a
// few named users (see users table), issued a JWT on login, checked
// on every protected route.
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
