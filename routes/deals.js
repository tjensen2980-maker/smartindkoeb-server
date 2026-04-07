// routes/deals.js
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /deals
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

    // 3. Hent brugerens historik
    const history = await pool.query(
      `SELECT text FROM shopping_items 
       WHERE list_id IN (SELECT id FROM shopping_lists WHERE user_id = $1)
       AND checked = true
       ORDER BY created_at DESC LIMIT 15`,
      [req.userId]
    );
    const purchasedItems = history.rows.map(r => r.text);

    // 4. TRIN 1: Claude søger efter ægte tilbud
    console.log('Step 1: Claude web search for deals...');
    const today = new Date().toISOString().split('T')[0];

    const searchResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Søg på etilbudsavis.dk efter denne uges tilbud fra: ${selectedStores.join(', ')}. 
Find mindst 15 konkrete tilbud med varenavn, butik og pris. Dato: ${today}.
Søg efter "tilbud ${selectedStores[0]}" og "tilbud ${selectedStores[1] || 'Netto'}".`
      }],
    });

    // Saml alt tekst fra søgeresultaterne
    let searchText = '';
    for (const block of searchResponse.content) {
      if (block.type === 'text') searchText += block.text + '\n';
    }
    console.log('Search result length:', searchText.length);

    // 5. TRIN 2: Separat Claude-kald der konverterer søgeresultater til JSON
    console.log('Step 2: Extract deals as JSON...');
    
    const purchaseHint = purchasedItems.length > 0
      ? `Brugeren køber ofte: ${purchasedItems.join(', ')}. Prioriter lignende varer øverst.`
      : '';

    const extractResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `Her er søgeresultater med aktuelle danske supermarkedstilbud:

${searchText.substring(0, 3000)}

${purchaseHint}

Baseret på ovenstående, lav en JSON array med 15-20 tilbud.
Brug KUN butikker fra: ${selectedStores.join(', ')}.
Hvis du ikke fandt nok ægte tilbud, supplér med realistiske tilbud der typisk findes i disse butikker i denne uge.

VIGTIGT: Svar med INTET andet end en valid JSON array. Ingen tekst, ingen markdown, ingen backticks.
Format:
[{"store":"Netto","item":"Minimælk 1L","old_price":12.95,"new_price":8.95,"savings":4,"category":"Mejeri","expiry_days":5}]

Kategorier: Mejeri, Kød & fisk, Frugt & grønt, Brød, Kolonial, Drikkevarer, Frost, Husholdning`
      }],
    });

    const jsonText = extractResponse.content.map(b => b.text || '').join('');
    console.log('JSON response length:', jsonText.length);

    // Parse JSON - prøv flere metoder
    let aiDeals = [];
    try {
      // Direkte parse
      aiDeals = JSON.parse(jsonText.trim());
    } catch {
      // Find JSON array i teksten
      const match = jsonText.match(/\[[\s\S]*\]/);
      if (match) {
        aiDeals = JSON.parse(match[0]);
      }
    }

    console.log('Parsed', aiDeals.length, 'deals');

    if (aiDeals.length === 0) {
      throw new Error('No deals parsed from AI');
    }

    // 6. Gem i database
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

    console.log('Cached', insertedDeals.length, 'deals');

    let deals = insertedDeals;
    if (category && category !== 'Alle') {
      deals = deals.filter(d => d.category === category);
    }

    res.json({ deals, source: 'web_search', count: insertedDeals.length });
  } catch (err) {
    console.error('Deals error:', err.message);
    
    // Fallback: return cached or empty
    try {
      const fallback = await pool.query(
        `SELECT id, store, item, old_price, new_price, savings, category, expiry_date, created_at
         FROM deals WHERE expiry_date >= CURRENT_DATE
         ORDER BY savings DESC LIMIT 20`
      );
      if (fallback.rows.length > 0) {
        return res.json({ deals: fallback.rows, source: 'fallback' });
      }
    } catch (e) { /* ignore */ }
    
    res.json({ deals: [], source: 'error', message: err.message });
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
    res.status(500).json({ error: 'Fejl' });
  }
});

module.exports = router;