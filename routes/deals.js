// routes/deals.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Default søgeord hvis brugeren ikke har nogen historik
const DEFAULT_SEARCHES = ['mælk', 'brød', 'kylling', 'ost', 'frugt', 'pasta', 'smør', 'kaffe'];

// Søg tilbudsugen.dk
async function searchTilbudsugen(query) {
  try {
    const url = `https://www.tilbudsugen.dk/api/api/typeahead-search/dk/${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) return [];

    const data = await response.json();
    const items = data.organicProductOffers?.items || [];

    return items.map(offer => ({
      id: offer.id,
      store: offer.chain?.name || 'Ukendt',
      item: [offer.brand?.name, offer.productName?.productName].filter(Boolean).join(' ') || offer.definedDescription || '',
      description: offer.definedDescription || '',
      new_price: parseFloat(offer.price) || null,
      quantity: offer.quantity ? `${offer.quantity} ${offer.quantityType || ''}`.trim() : null,
      category: offer.productVariant?.category?.name || 'Dagligvarer',
      image: offer.imageThumbnailUrl || offer.imageUrl || null,
      start_date: offer.startDate || null,
      expiry_date: offer.endDate || null,
      search_term: query,
    })).filter(d => d.item);
  } catch (err) {
    console.warn('Tilbudsugen search error for', query, ':', err.message);
    return [];
  }
}

// Udtrk søgeord fra indkøbshistorik
function extractSearchTerms(purchasedItems) {
  // Normaliser og find unikke basisvarer
  const terms = new Set();
  for (const item of purchasedItems) {
    const clean = item.toLowerCase()
      .replace(/\d+\s*(g|kg|ml|l|cl|stk|pk)\b/gi, '') // fjern mængder
      .replace(/[^\wæøå ]/gi, '') // fjern specialtegn
      .trim();
    
    // Tag det første/vigtigste ord (f.eks. "Arla Minimælk 1L" → "minimælk")
    const words = clean.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 0) {
      // Brug det sidste ord (ofte selve varen) eller hele teksten hvis kort
      terms.add(words.length <= 2 ? clean : words[words.length - 1]);
    }
  }
  return [...terms].slice(0, 8); // max 8 søgeord
}

// GET /deals - Hent personlige tilbud automatisk
router.get('/', authMiddleware, async (req, res) => {
  const { category, limit = 30 } = req.query;

  try {
    // 1. Tjek cache (under 2 timer)
    const freshDeals = await pool.query(
      `SELECT id, store, item, new_price, category, image, expiry_date, search_term, created_at
       FROM deals
       WHERE expiry_date >= CURRENT_DATE
         AND created_at > NOW() - INTERVAL '2 hours'
       ORDER BY created_at DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    if (freshDeals.rows.length >= 10) {
      let deals = freshDeals.rows;
      if (category && category !== 'Alle') deals = deals.filter(d => d.category === category);
      console.log('Returning', deals.length, 'cached personal deals');
      return res.json({ deals, source: 'cache' });
    }

    // 2. Hent brugerens indkøbshistorik
    const history = await pool.query(
      `SELECT text FROM shopping_items 
       WHERE list_id IN (SELECT id FROM shopping_lists WHERE user_id = $1)
       ORDER BY created_at DESC LIMIT 30`,
      [req.userId]
    );

    const purchasedItems = history.rows.map(r => r.text);
    let searchTerms;

    if (purchasedItems.length >= 3) {
      // Personaliserede søgeord fra historik
      searchTerms = extractSearchTerms(purchasedItems);
      console.log('Personal search terms:', searchTerms);
    } else {
      // Nye brugere: brug standard søgeord
      searchTerms = DEFAULT_SEARCHES.sort(() => Math.random() - 0.5).slice(0, 5);
      console.log('Default search terms:', searchTerms);
    }

    // 3. Søg tilbudsugen.dk for hvert søgeord (parallel)
    console.log('Fetching deals for', searchTerms.length, 'search terms...');
    const results = await Promise.all(searchTerms.map(term => searchTilbudsugen(term)));
    
    // 4. Fladgør og dedupliker
    const allDeals = [];
    const seenIds = new Set();
    
    for (const dealList of results) {
      for (const deal of dealList) {
        if (!seenIds.has(deal.id)) {
          seenIds.add(deal.id);
          allDeals.push(deal);
        }
      }
    }

    console.log('Found', allDeals.length, 'unique deals');

    // 5. Gem i database cache
    await pool.query("DELETE FROM deals WHERE created_at < NOW() - INTERVAL '4 hours'");

    // Tilføj search_term kolonne hvis den ikke eksisterer
    try {
      await pool.query("ALTER TABLE deals ADD COLUMN IF NOT EXISTS search_term VARCHAR(100)");
      await pool.query("ALTER TABLE deals ADD COLUMN IF NOT EXISTS image TEXT");
    } catch (e) { /* kolonne eksisterer allerede */ }

    const insertedDeals = [];
    for (const d of allDeals.slice(0, parseInt(limit))) {
      try {
        const expiryDate = d.expiry_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        const result = await pool.query(
          `INSERT INTO deals (store, item, new_price, category, expiry_date, image, search_term)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7)
           RETURNING id, store, item, new_price, category, expiry_date, image, search_term, created_at`,
          [d.store, d.item, d.new_price, d.category, expiryDate, d.image, d.search_term]
        );
        insertedDeals.push(result.rows[0]);
      } catch (e) {
        console.warn('Insert error:', e.message);
      }
    }

    console.log('Cached', insertedDeals.length, 'personal deals');

    let deals = insertedDeals;
    if (category && category !== 'Alle') deals = deals.filter(d => d.category === category);

    res.json({ 
      deals, 
      source: purchasedItems.length >= 3 ? 'personalized' : 'popular',
      searchTerms,
      count: insertedDeals.length 
    });
  } catch (err) {
    console.error('Deals error:', err.message);
    try {
      const fb = await pool.query(
        `SELECT id, store, item, new_price, category, expiry_date, image, created_at
         FROM deals WHERE expiry_date >= CURRENT_DATE ORDER BY created_at DESC LIMIT 20`
      );
      if (fb.rows.length) return res.json({ deals: fb.rows, source: 'fallback' });
    } catch (e) { /* */ }
    res.json({ deals: [], source: 'error', message: err.message });
  }
});

// GET /deals/search?q=mælk - Manuel søgning
router.get('/search', authMiddleware, async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Søgeord er påkrævet' });

  try {
    console.log('Manual search for:', q);
    const deals = await searchTilbudsugen(q.trim());
    console.log('Found', deals.length, 'deals for', q);
    res.json({ deals, query: q, source: 'tilbudsugen' });
  } catch (err) {
    console.error('Search error:', err.message);
    res.json({ deals: [], query: q, source: 'error', message: err.message });
  }
});

// GET /deals/categories
router.get('/categories', async (req, res) => {
  try {
    const r = await pool.query('SELECT DISTINCT category FROM deals WHERE expiry_date >= CURRENT_DATE ORDER BY category');
    res.json({ categories: ['Alle', ...r.rows.map(x => x.category).filter(Boolean)] });
  } catch (err) {
    res.json({ categories: ['Alle', 'Mejeri', 'Kød', 'Frugt & grønt', 'Brød', 'Kolonial', 'Drikkevarer'] });
  }
});

// POST /deals/refresh
router.post('/refresh', authMiddleware, async (req, res) => {
  try { await pool.query('DELETE FROM deals'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;