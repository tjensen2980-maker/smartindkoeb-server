// routes/settings.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /settings
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT selected_stores, notifications_enabled FROM user_settings WHERE user_id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      // Create default
      await pool.query('INSERT INTO user_settings (user_id) VALUES ($1)', [req.userId]);
      return res.json({ selected_stores: ['Netto', 'Rema 1000', 'Føtex'], notifications_enabled: true });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Settings error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// PUT /settings
router.put('/', authMiddleware, async (req, res) => {
  const { selected_stores, notifications_enabled } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO user_settings (user_id, selected_stores, notifications_enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
       SET selected_stores = COALESCE($2, user_settings.selected_stores),
           notifications_enabled = COALESCE($3, user_settings.notifications_enabled)
       RETURNING selected_stores, notifications_enabled`,
      [req.userId, selected_stores ? JSON.stringify(selected_stores) : null, notifications_enabled]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// PUT /settings/plan - Skift abonnement
router.put('/plan', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  const validPlans = ['basis', 'premium', 'familie'];

  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Ugyldig plan' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, plan',
      [plan, req.userId]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Plan update error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

module.exports = router;
