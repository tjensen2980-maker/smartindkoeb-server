// routes/meals.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /meals/current - Hent denne uges madplan
router.get('/current', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const week = getWeekNumber(now);
    const year = now.getFullYear();

    let plan = await pool.query(
      'SELECT id FROM meal_plans WHERE user_id = $1 AND week_number = $2 AND year = $3',
      [req.userId, week, year]
    );

    if (plan.rows.length === 0) {
      // Auto-generate a plan based on current deals
      plan = await pool.query(
        'INSERT INTO meal_plans (user_id, week_number, year) VALUES ($1, $2, $3) RETURNING id',
        [req.userId, week, year]
      );

      const planId = plan.rows[0].id;
      const defaultMeals = [
        { day: 'Mandag', meal: 'Pasta Bolognese', ingredients: ['Hakket oksekød', 'Pasta penne', 'Løg', 'Hvidløg', 'Tomater'], stores: ['Rema 1000', 'Bilka'], savings: 22 },
        { day: 'Tirsdag', meal: 'Kylling i karry', ingredients: ['Kyllingebryst', 'Ris', 'Kokosmælk', 'Karrypaste', 'Løg'], stores: ['Rema 1000', 'Netto'], savings: 15 },
        { day: 'Onsdag', meal: 'Rugbrødsmadder', ingredients: ['Rugbrød', 'Smør', 'Ost', 'Agurk', 'Tomat'], stores: ['Aldi', 'Føtex'], savings: 15 },
        { day: 'Torsdag', meal: 'Bananpandekager', ingredients: ['Bananer', 'Æg', 'Mel', 'Mælk', 'Skyr'], stores: ['Lidl', 'Netto'], savings: 12 },
        { day: 'Fredag', meal: 'Tacos med oksekød', ingredients: ['Hakket oksekød', 'Tortillas', 'Salat', 'Tomat', 'Cheddar'], stores: ['Rema 1000', 'Lidl'], savings: 28 },
        { day: 'Lørdag', meal: 'Hjemmelavet pizza', ingredients: ['Mel', 'Gær', 'Ost', 'Skinke', 'Tomatsauce'], stores: ['Bilka'], savings: 18 },
        { day: 'Søndag', meal: 'Stegt kylling & salat', ingredients: ['Kyllingebryst', 'Æbler', 'Salat', 'Valnødder'], stores: ['Rema 1000', 'Føtex'], savings: 20 },
      ];

      for (const m of defaultMeals) {
        await pool.query(
          'INSERT INTO meal_days (plan_id, day_name, meal_name, ingredients, stores, estimated_savings) VALUES ($1, $2, $3, $4, $5, $6)',
          [planId, m.day, m.meal, JSON.stringify(m.ingredients), JSON.stringify(m.stores), m.savings]
        );
      }
    }

    const planId = plan.rows[0].id;
    const days = await pool.query(
      'SELECT id, day_name, meal_name, ingredients, stores, estimated_savings FROM meal_days WHERE plan_id = $1 ORDER BY id',
      [planId]
    );

    const totalSavings = days.rows.reduce((sum, d) => sum + parseFloat(d.estimated_savings || 0), 0);

    res.json({
      planId,
      week,
      year,
      days: days.rows,
      totalSavings,
    });
  } catch (err) {
    console.error('Meals error:', err);
    res.status(500).json({ error: 'Serverfejl' });
  }
});

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

module.exports = router;
