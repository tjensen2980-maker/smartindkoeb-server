// routes/shopping.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /shopping/list - Hent brugerens indkøbsliste
router.get('/list', authMiddleware, async (req, res) => {
  try {
    // Get or create default list
    let list = await pool.query(
      'SELECT id FROM shopping_lists WHERE user_id = $1 ORDER BY created_at LIMIT 1',
      [req.userId]
    );

    if (list.rows.length === 0) {
      list = await pool.query(
        'INSERT INTO shopping_lists (user_id, name) VALUES ($1, $2) RETURNING id',
        [req.userId, 'Min indkøbsliste']
      );
    }

    const listId = list.rows[0].id;
    const items = await pool.query(
      'SELECT id, text, checked, store, created_at FROM shopping_items WHERE list_id = $1 ORDER BY checked ASC, created_at DESC',
      [listId]
    );

    res.json({ listId, items: items.rows });
  } catch (err) {
    console.error('Get list error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// POST /shopping/items - Tilføj vare
router.post('/items', authMiddleware, async (req, res) => {
  const { text, store } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Varenavn er påkrævet' });
  }

  try {
    let list = await pool.query(
      'SELECT id FROM shopping_lists WHERE user_id = $1 ORDER BY created_at LIMIT 1',
      [req.userId]
    );

    if (list.rows.length === 0) {
      list = await pool.query(
        'INSERT INTO shopping_lists (user_id, name) VALUES ($1, $2) RETURNING id',
        [req.userId, 'Min indkøbsliste']
      );
    }

    const result = await pool.query(
      'INSERT INTO shopping_items (list_id, text, store) VALUES ($1, $2, $3) RETURNING id, text, checked, store, created_at',
      [list.rows[0].id, text.trim(), store || null]
    );

    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    console.error('Add item error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// PUT /shopping/items/:id/toggle - Toggle checked
router.put('/items/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE shopping_items SET checked = NOT checked
       WHERE id = $1 AND list_id IN (SELECT id FROM shopping_lists WHERE user_id = $2)
       RETURNING id, text, checked, store`,
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vare ikke fundet' });
    }

    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error('Toggle error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// DELETE /shopping/items/:id - Slet vare
router.delete('/items/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM shopping_items
       WHERE id = $1 AND list_id IN (SELECT id FROM shopping_lists WHERE user_id = $2)
       RETURNING id`,
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vare ikke fundet' });
    }

    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete item error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

// DELETE /shopping/checked - Slet alle afkrydsede
router.delete('/checked', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM shopping_items
       WHERE checked = true AND list_id IN (SELECT id FROM shopping_lists WHERE user_id = $1)`,
      [req.userId]
    );

    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Clear checked error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

module.exports = router;
