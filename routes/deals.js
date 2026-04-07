// routes/deals.js
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /deals - Hent personaliserede tilbud via AI
router.get('/', authMiddleware, async (req, res) => {
  const { category, limit = 30 } = req.query;

  try {
    // 1. Hent brugerens butikker
    const settings = await pool.query(
      'SELECT selected_stores FROM user_settings WHERE user_id = $1',
      [req.userId]
    );
    const selectedStores = settings.rows[0]?.selected_stores || ['Netto', 'Rema 1000', 'Føtex'];

    // 2. Hent brugerens indkøbshistorik (hvad de har købt før)
    const history = await pool.query(
      `SELECT text, store FROM shopping_items 
       WHERE list_id IN (SELECT id FROM shopping_lists WHERE user_id = $1)
       AND checked = true
       ORDER BY created_at DESC LIMIT 30`,
      [req.userId]
    );
    const purchasedItems = history.rows.map(r => r.text);

    // 3. Tjek om vi har friske tilbud i databasen (under 6 timer gamle)
    const freshDeals = await pool.query(
      `SELECT id, store, item, old_price, new_price, savings, category, expiry_date, created_at
       FROM deals 
       WHERE expiry_date >= CURRENT_DATE
         AND store = ANY($1)
         AND created_at > NOW() - INTERVAL '6 hours'
       ORDER BY savings DESC
       LIMIT $2`,
      [selectedStores, parseInt(limit)]
    );

    if (freshDeals.rows.length >= 5) {
      // Vi har friske tilbud — filtrer evt. på kategori
      let deals = freshDeals.rows;
      if (category && category !== 'Alle') {
        deals = deals.filter(d => d.category === category);
      }
      return res.json({ deals, source: 'cache' });
    }

    // 4. Ingen friske tilbud — brug AI til at generere nye
    const today = new Date().toISOString().split('T')[0];
    const dayName = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'][new Date().getDay()];

    const purchaseContext = purchasedItems.length > 0
      ? `\nBrugeren har tidligere købt: ${purchasedItems.slice(0, 15).join(', ')}. Prioriter tilbud på lignende varer.`
      : '';

    const prompt = `Du er en dansk dagligvare-ekspert. Generer realistiske aktuelle tilbud fra danske supermarkeder.

Dato: ${today} (${dayName})
Butikker: ${selectedStores.join(', ')}
${purchaseContext}

Generer 15-20 realistiske tilbud der kunne findes i danske supermarkeder lige nu. 
Priserne skal være realistiske for danske supermarkeder i 2026.
Brug kategorier: Mejeri, Kød, Frugt & grønt, Brød, Kolonial, Drikkevarer, Frost, Husholdning.
Varier mellem hverdagsvarer og sæsonvarer.

Svar KUN med valid JSON array (ingen markdown, ingen backticks):
[{"store":"Butiksnavn","item":"Varenavn","old_price":29.95,"new_price":19.95,"savings":10,"category":"Kategori","expiry_days":3}]`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.map(b => b.text || '').join('');
    const cleaned = text.replace(/```json|```/g, '').trim();
    const aiDeals = JSON.parse(cleaned);

    // 5. Gem tilbud i databasen
    await pool.query('DELETE FROM deals WHERE created_at < NOW() - INTERVAL \'12 hours\'');

    const insertedDeals = [];
    for (const d of aiDeals) {
      if (!selectedStores.includes(d.store)) continue;
      
      const result = await pool.query(
        `INSERT INTO deals (store, item, old_price, new_price, savings, category, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE + $7)
         RETURNING id, store, item, old_price, new_price, savings, category, expiry_date, created_at`,
        [d.store, d.item, d.old_price, d.new_price, d.savings, d.category, d.expiry_days || 3]
      );
      insertedDeals.push(result.rows[0]);
    }

    // 6. Filtrer på kategori hvis angivet
    let deals = insertedDeals;
    if (category && category !== 'Alle') {
      deals = deals.filter(d => d.category === category);
    }

    res.json({ deals, source: 'ai', generated: insertedDeals.length });
  } catch (err) {
    console.error('Deals error:', err.message);
    
    // Fallback: hent hvad der er i databasen
    try {
      const fallback = await pool.query(
        `SELECT id, store, item, old_price, new_price, savings, category, expiry_date, created_at
         FROM deals WHERE expiry_date >= CURRENT_DATE
         ORDER BY savings DESC LIMIT 20`
      );
      res.json({ deals: fallback.rows, source: 'fallback' });
    } catch (e) {
      res.json({ deals: [], source: 'empty' });
    }
  }
});

// GET /deals/categories - Hent unikke kategorier
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT category FROM deals WHERE expiry_date >= CURRENT_DATE ORDER BY category'
    );
    const categories = result.rows.map(r => r.category).filter(Boolean);
    res.json({ categories: ['Alle', ...categories] });
  } catch (err) {
    res.json({ categories: ['Alle', 'Mejeri', 'Kød', 'Frugt & grønt', 'Brød', 'Kolonial', 'Drikkevarer'] });
  }
});

// POST /deals/refresh - Tving ny AI-generering af tilbud
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    // Slet brugerens gamle cached tilbud og tving refresh
    await pool.query('DELETE FROM deals WHERE created_at < NOW() - INTERVAL \'1 hour\'');
    
    // Redirect til GET /deals som nu genererer nye
    res.json({ message: 'Cache ryddet. Hent /deals for nye tilbud.' });
  } catch (err) {
    res.status(500).json({ error: 'Kunne ikke opdatere tilbud' });
  }
});

module.exports = router;