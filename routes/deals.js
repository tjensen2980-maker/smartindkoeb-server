// routes/deals.js
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /deals - Hent ægte tilbud via Claude web search
router.get('/', authMiddleware, async (req, res) => {
  const { category, limit = 30 } = req.query;

  try {
    // 1. Hent brugerens butikker
    const settings = await pool.query(
      'SELECT selected_stores FROM user_settings WHERE user_id = $1',
      [req.userId]
    );
    const selectedStores = settings.rows[0]?.selected_stores || ['Netto', 'Rema 1000', 'Føtex'];

    // 2. Tjek cache (under 3 timer gamle)
    const freshDeals = await pool.query(
      `SELECT id, store, item, old_price, new_price, savings, category, expiry_date, created_at
       FROM deals 
       WHERE expiry_date >= CURRENT_DATE
         AND store = ANY($1)
         AND created_at > NOW() - INTERVAL '3 hours'
       ORDER BY savings DESC
       LIMIT $2`,
      [selectedStores, parseInt(limit)]
    );

    if (freshDeals.rows.length >= 5) {
      let deals = freshDeals.rows;
      if (category && category !== 'Alle') {
        deals = deals.filter(d => d.category === category);
      }
      console.log('Returning', deals.length, 'cached deals');
      return res.json({ deals, source: 'cache' });
    }

    // 3. Hent brugerens indkøbshistorik
    const history = await pool.query(
      `SELECT text FROM shopping_items 
       WHERE list_id IN (SELECT id FROM shopping_lists WHERE user_id = $1)
       AND checked = true
       ORDER BY created_at DESC LIMIT 20`,
      [req.userId]
    );
    const purchasedItems = history.rows.map(r => r.text);

    // 4. Brug Claude med web search til at finde ÆGTE tilbud
    console.log('Using Claude web search for real deals...');

    const today = new Date().toISOString().split('T')[0];
    const purchaseContext = purchasedItems.length > 0
      ? `Brugeren køber ofte: ${purchasedItems.slice(0, 10).join(', ')}. Prioriter relevante tilbud.`
      : '';

    const prompt = `Søg efter denne uges aktuelle tilbud fra danske supermarkeder: ${selectedStores.join(', ')}.

Dato i dag: ${today}
${purchaseContext}

Søg på etilbudsavis.dk, tilbudsavis.dk eller de enkelte butikkers hjemmesider for at finde RIGTIGE aktuelle tilbud.
Find 15-20 ægte tilbud med rigtige priser.

Svar KUN med valid JSON array (ingen markdown, ingen backticks, ingen forklaring):
[{"store":"Butiksnavn","item":"Varenavn med mængde","old_price":29.95,"new_price":19.95,"savings":10,"category":"Kategori","expiry_days":5}]

Kategorier: Mejeri, Kød & fisk, Frugt & grønt, Brød, Kolonial, Drikkevarer, Frost, Husholdning.
expiry_days skal være et heltal.
Brug kun butikker fra listen: ${selectedStores.join(', ')}.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract text from response (may contain multiple content blocks)
    let responseText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        responseText += block.text;
      }
    }

    console.log('Claude response length:', responseText.length);

    // Parse JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('No JSON array found in response');
      throw new Error('No deals JSON in response');
    }

    const aiDeals = JSON.parse(jsonMatch[0]);
    console.log('Parsed', aiDeals.length, 'deals from Claude');

    // 5. Gem i database
    await pool.query("DELETE FROM deals WHERE created_at < NOW() - INTERVAL '6 hours'");

    const insertedDeals = [];
    for (const d of aiDeals) {
      if (!selectedStores.includes(d.store)) continue;
      
      try {
        const expiryDays = parseInt(d.expiry_days) || 5;
        const expiryDate = new Date(Date.now() + expiryDays * 86400000).toISOString().split('T')[0];

        const result = await pool.query(
          `INSERT INTO deals (store, item, old_price, new_price, savings, category, expiry_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date)
           RETURNING id, store, item, old_price, new_price, savings, category, expiry_date, created_at`,
          [d.store, d.item, d.old_price, d.new_price, d.savings || (d.old_price - d.new_price), d.category, expiryDate]
        );
        insertedDeals.push(result.rows[0]);
      } catch (insertErr) {
        console.warn('Insert error:', insertErr.message);
      }
    }

    console.log('Cached', insertedDeals.length, 'deals in DB');

    let deals = insertedDeals;
    if (category && category !== 'Alle') {
      deals = deals.filter(d => d.category === category);
    }

    res.json({ deals, source: 'web_search', fetched: aiDeals.length, cached: insertedDeals.length });
  } catch (err) {
    console.error('Deals error:', err.message);
    
    // Fallback
    try {
      const fallback = await pool.query(
        `SELECT id, store, item, old_price, new_price, savings, category, expiry_date, created_at
         FROM deals WHERE expiry_date >= CURRENT_DATE
         ORDER BY savings DESC LIMIT 20`
      );
      
      if (fallback.rows.length > 0) {
        return res.json({ deals: fallback.rows, source: 'fallback' });
      }
    } catch (e) {
      // ignore
    }
    
    res.json({ deals: [], source: 'error', error: err.message });
  }
});

// GET /deals/categories
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT category FROM deals WHERE expiry_date >= CURRENT_DATE ORDER BY category'
    );
    const categories = result.rows.map(r => r.category).filter(Boolean);
    res.json({ categories: ['Alle', ...categories] });
  } catch (err) {
    res.json({ categories: ['Alle', 'Mejeri', 'Kød & fisk', 'Frugt & grønt', 'Brød', 'Kolonial', 'Drikkevarer'] });
  }
});

// POST /deals/refresh
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM deals');
    res.json({ message: 'Cache ryddet' });
  } catch (err) {
    res.status(500).json({ error: 'Kunne ikke rydde cache' });
  }
});

module.exports = router;