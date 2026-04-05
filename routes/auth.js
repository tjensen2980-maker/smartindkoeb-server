// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { authMiddleware, generateToken } = require('../middleware/auth');

const router = express.Router();

// POST /auth/register
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email og adgangskode er påkrævet' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 6 tegn' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'En bruger med denne email eksisterer allerede' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, plan',
      [email.toLowerCase(), hash, name || email.split('@')[0]]
    );

    const user = result.rows[0];

    // Create default settings
    await pool.query(
      'INSERT INTO user_settings (user_id) VALUES ($1)',
      [user.id]
    );

    // Create default shopping list
    await pool.query(
      'INSERT INTO shopping_lists (user_id, name) VALUES ($1, $2)',
      [user.id, 'Min indkøbsliste']
    );

    const token = generateToken(user.id, user.email);

    res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
      token,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Serverfejl ved oprettelse' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email og adgangskode er påkrævet' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, name, password_hash, plan FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Forkert email eller adgangskode' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Forkert email eller adgangskode' });
    }

    const token = generateToken(user.id, user.email);

    res.json({
      user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Serverfejl ved login' });
  }
});

// GET /auth/profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, plan, created_at FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bruger ikke fundet' });
    }

    const settings = await pool.query(
      'SELECT selected_stores, notifications_enabled FROM user_settings WHERE user_id = $1',
      [req.userId]
    );

    res.json({
      user: result.rows[0],
      settings: settings.rows[0] || {},
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// PUT /auth/profile
router.put('/profile', authMiddleware, async (req, res) => {
  const { name } = req.body;

  try {
    const result = await pool.query(
      'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, plan',
      [name, req.userId]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// DELETE /auth/account
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);
    res.json({ message: 'Konto slettet' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Serverfejl ved sletning' });
  }
});

module.exports = router;
