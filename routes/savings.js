// routes/savings.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /savings/summary - Hent besparelsesoversigt
router.get('/summary', authMiddleware, async (req, res) => {
  const { year = new Date().getFullYear() } = req.query;

  try {
    // Monthly breakdown
    const monthly = await pool.query(
      `SELECT month, SUM(amount) as total
       FROM savings_log
       WHERE user_id = $1 AND year = $2
       GROUP BY month ORDER BY month`,
      [req.userId, year]
    );

    // Category breakdown
    const categories = await pool.query(
      `SELECT category, SUM(amount) as total, COUNT(*) as count
       FROM savings_log
       WHERE user_id = $1 AND year = $2
       GROUP BY category ORDER BY total DESC`,
      [req.userId, year]
    );

    // Top stores
    const stores = await pool.query(
      `SELECT store, SUM(amount) as total, COUNT(*) as visits
       FROM savings_log
       WHERE user_id = $1 AND year = $2
       GROUP BY store ORDER BY total DESC LIMIT 5`,
      [req.userId, year]
    );

    // Total
    const total = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM savings_log WHERE user_id = $1 AND year = $2',
      [req.userId, year]
    );

    // Fill in all 12 months
    const monthlyData = Array.from({ length: 12 }, (_, i) => {
      const found = monthly.rows.find(r => r.month === i + 1);
      return { month: i + 1, total: found ? parseFloat(found.total) : 0 };
    });

    const grandTotal = parseFloat(total.rows[0].total);
    const monthsWithData = monthlyData.filter(m => m.total > 0).length;

    res.json({
      year: parseInt(year),
      total: grandTotal,
      average: monthsWithData > 0 ? Math.round(grandTotal / monthsWithData) : 0,
      bestMonth: monthlyData.reduce((best, m) => m.total > best.total ? m : best, { total: 0 }),
      monthly: monthlyData,
      categories: categories.rows.map(c => ({
        name: c.category,
        amount: parseFloat(c.total),
        count: parseInt(c.count),
      })),
      stores: stores.rows.map(s => ({
        name: s.store,
        saved: parseFloat(s.total),
        visits: parseInt(s.visits),
      })),
    });
  } catch (err) {
    console.error('Savings error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// POST /savings/seed - Seed demo savings data
router.post('/seed', authMiddleware, async (req, res) => {
  const months = [320, 480, 390, 560, 620, 510, 680, 720, 590, 830, 760];
  const categories = ['Kød & fjerkræ', 'Mejeri', 'Frugt & grønt', 'Brød & bageri', 'Kolonial'];
  const stores = ['Netto', 'Rema 1000', 'Føtex', 'Lidl', 'Bilka'];
  const year = new Date().getFullYear();

  try {
    for (let m = 0; m < months.length; m++) {
      const total = months[m];
      // Split across categories and stores
      for (let i = 0; i < 5; i++) {
        const amount = Math.round((total / 5) * (0.5 + Math.random()) * 100) / 100;
        await pool.query(
          'INSERT INTO savings_log (user_id, amount, category, store, month, year) VALUES ($1, $2, $3, $4, $5, $6)',
          [req.userId, amount, categories[i % categories.length], stores[i % stores.length], m + 1, year]
        );
      }
    }
    res.json({ message: 'Savings data seeded' });
  } catch (err) {
    console.error('Seed savings error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

module.exports = router;
