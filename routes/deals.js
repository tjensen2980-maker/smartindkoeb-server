// routes/deals.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /deals - Hent tilbud (filtreret til brugerens butikker)
router.get('/', authMiddleware, async (req, res) => {
  const { category, store, limit = 50 } = req.query;

  try {
    // Get user's selected stores
    const settings = await pool.query(
      'SELECT selected_stores FROM user_settings WHERE user_id = $1',
      [req.userId]
    );
    const selectedStores = settings.rows[0]?.selected_stores || ['Netto', 'Rema 1000', 'Føtex'];

    let query = `
      SELECT id, store, item, old_price, new_price, savings, category,
             expiry_date, created_at
      FROM deals
      WHERE expiry_date >= CURRENT_DATE
        AND store = ANY($1)
    `;
    const params = [selectedStores];
    let paramIdx = 2;

    if (category && category !== 'Alle') {
      query += ` AND category = $${paramIdx}`;
      params.push(category);
      paramIdx++;
    }

    if (store) {
      query += ` AND store = $${paramIdx}`;
      params.push(store);
      paramIdx++;
    }

    query += ` ORDER BY savings DESC LIMIT $${paramIdx}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);

    res.json({ deals: result.rows });
  } catch (err) {
    console.error('Deals error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// GET /deals/categories - Hent unikke kategorier
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT category FROM deals WHERE expiry_date >= CURRENT_DATE ORDER BY category'
    );
    res.json({ categories: ['Alle', ...result.rows.map(r => r.category)] });
  } catch (err) {
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// POST /deals/seed - Seed sample deals (til dev/demo)
router.post('/seed', async (req, res) => {
  const sampleDeals = [
    { store: 'Netto', item: "Naturli' Havremælk 1L", old_price: 26.95, new_price: 14.95, savings: 12, category: 'Mejeri', expiry_days: 3 },
    { store: 'Rema 1000', item: 'Hakket oksekød 500g', old_price: 47.95, new_price: 29.95, savings: 18, category: 'Kød', expiry_days: 4 },
    { store: 'Føtex', item: 'Lurpak smør 200g', old_price: 24.50, new_price: 16.50, savings: 8, category: 'Mejeri', expiry_days: 6 },
    { store: 'Lidl', item: 'Øko bananer 1kg', old_price: 15.95, new_price: 9.95, savings: 6, category: 'Frugt & grønt', expiry_days: 2 },
    { store: 'Netto', item: 'Skyr naturel 500g', old_price: 18.95, new_price: 12.95, savings: 6, category: 'Mejeri', expiry_days: 5 },
    { store: 'Bilka', item: 'Pasta penne 500g', old_price: 12.50, new_price: 7.95, savings: 4.55, category: 'Kolonial', expiry_days: 8 },
    { store: 'Rema 1000', item: 'Kyllingebryst 500g', old_price: 49.95, new_price: 34.95, savings: 15, category: 'Kød', expiry_days: 3 },
    { store: 'Aldi', item: 'Rugbrød Schulstad', old_price: 22.00, new_price: 15.00, savings: 7, category: 'Brød', expiry_days: 4 },
    { store: 'Føtex', item: 'Æbler Royal Gala 1kg', old_price: 19.95, new_price: 12.95, savings: 7, category: 'Frugt & grønt', expiry_days: 5 },
    { store: 'Lidl', item: 'Cheddar ost 400g', old_price: 29.95, new_price: 19.95, savings: 10, category: 'Mejeri', expiry_days: 7 },
  ];

  try {
    for (const d of sampleDeals) {
      await pool.query(
        `INSERT INTO deals (store, item, old_price, new_price, savings, category, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE + $7)
         ON CONFLICT DO NOTHING`,
        [d.store, d.item, d.old_price, d.new_price, d.savings, d.category, d.expiry_days]
      );
    }
    res.json({ message: 'Deals seeded', count: sampleDeals.length });
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

module.exports = router;
