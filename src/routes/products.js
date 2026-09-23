const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM products WHERE is_active = true ORDER BY created_at DESC'
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, sku, image_url, description, notes, price_south, price_north, currency, min_order_qty } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await pool.query(
    `INSERT INTO products (name, sku, image_url, description, notes, price_south, price_north, currency, min_order_qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'SAR'),$9)
     RETURNING *`,
    [name, sku, image_url, description, notes, price_south, price_north, currency, min_order_qty]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const fields = ['name', 'sku', 'image_url', 'description', 'notes', 'price_south', 'price_north', 'currency', 'min_order_qty', 'is_active'];
  const sets = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      params.push(req.body[field]);
      sets.push(`${field} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'no fields to update' });

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  // Soft delete -- keep history for past campaigns that reference it.
  await pool.query('UPDATE products SET is_active = false, updated_at = now() WHERE id = $1', [
    req.params.id,
  ]);
  res.json({ success: true });
});

module.exports = router;
