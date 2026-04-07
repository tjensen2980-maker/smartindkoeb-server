// routes/deals.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const COMMON_SEARCHES = ['mælk', 'smør', 'ost', 'brød', 'kylling', 'hakket oksekød', 'æg', 'bananer', 'kartofler', 'pasta', 'ris', 'kaffe', 'yoghurt', 'pølser', 'juice'];

// Default: Fredericia
const DEFAULT_LAT = 55.57;
const DEFAULT_LNG = 9.75;

async function searchTilbudsugen(query, lat, lng) {
  try {
    // Tilbudsugen API med lokation
    const url = `https://www.tilbudsugen.dk/api/api/typeahead-search/dk/${encodeURIComponent(query)}?lat=${lat}&lng=${lng}`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.organicProductOffers?.items || []).map(offer => ({
      id: offer.id,
      store: offer.chain?.name || 'Ukendt',
      item: [offer.brand?.name, offer.productName?.productName].filter(Boolean).join(' ') || '',
      new_price: parseFloat(offer.price) || null,
      quantity: offer.quantity ? `${offer.quantity} ${offer.quantityType || ''}`.trim() : null,
      category: offer.productVariant?.category?.name || 'Dagligvarer',
      image: offer.imageThumbnailUrl || offer.imageUrl || null,
      expiry_date: offer.endDate || null,
    })).filter(d => d.item);
  } catch (err) {
    console.warn('Search error for', query, ':', err.message);
    return [];
  }
}

// GET /deals?lat=55.57&lng=9.75
router.get('/', authMiddleware, async (req, res) => {
  const { category } = req.query;
  const lat = parseFloat(req.query.lat) || DEFAULT_LAT;
  const lng = parseFloat(req.query.lng) || DEFAULT_LNG;

  try {
    // Ensure deals table has image column
    try {
      const check = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'image'");
      if (check.rows.length === 0) {
        await pool.query('DROP TABLE IF EXISTS deals CASCADE');
        await pool.query(`CREATE TABLE deals (
          id SERIAL PRIMARY KEY, store VARCHAR(100) NOT NULL, item VARCHAR(255) NOT NULL,
          old_price DECIMAL(10,2), new_price DECIMAL(10,2), savings DECIMAL(10,2),
          category VARCHAR(100), expiry_date DATE, image TEXT, lat DECIMAL(8,5), lng DECIMAL(8,5),
          created_at TIMESTAMP DEFAULT NOW()
        )`);
        console.log('✅ Deals table recreated with image + location');
      }
    } catch(e) {}

    // Cache check - brug location-specifik cache (inden for 5 km)
    const cached = await pool.query(
      `SELECT id, store, item, new_price, category, image, expiry_date, created_at
       FROM deals 
       WHERE created_at > NOW() - INTERVAL '2 hours'
         AND lat IS NOT NULL
         AND ABS(lat - $1) < 0.05 AND ABS(lng - $2) < 0.05
       ORDER BY id DESC LIMIT 50`,
      [lat, lng]
    );

    if (cached.rows.length >= 15) {
      let deals = cached.rows;
      if (category && category !== 'Alle') deals = deals.filter(d => d.category === category);
      return res.json({ deals, source: 'cache', location: { lat, lng } });
    }

    // Hent friske tilbud med lokation
    console.log(`Fetching deals near ${lat},${lng}...`);
    const shuffled = [...COMMON_SEARCHES].sort(() => Math.random() - 0.5);
    const searches = shuffled.slice(0, 6);

    const results = await Promise.all(searches.map(term => searchTilbudsugen(term, lat, lng)));

    const allDeals = [];
    const seenIds = new Set();
    for (const list of results) {
      for (const deal of list) {
        if (!seenIds.has(deal.id)) {
          seenIds.add(deal.id);
          allDeals.push(deal);
        }
      }
    }

    console.log('Found', allDeals.length, 'local deals');

    if (allDeals.length === 0) {
      return res.json({ deals: [], source: 'empty', location: { lat, lng } });
    }

    // Cache med lokation
    await pool.query("DELETE FROM deals WHERE created_at < NOW() - INTERVAL '4 hours'");

    const insertedDeals = [];
    for (const d of allDeals) {
      try {
        const expiry = d.expiry_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        const result = await pool.query(
          `INSERT INTO deals (store, item, new_price, category, expiry_date, image, lat, lng)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)
           RETURNING id, store, item, new_price, category, expiry_date, image, created_at`,
          [d.store, d.item, d.new_price, d.category, expiry, d.image, lat, lng]
        );
        insertedDeals.push(result.rows[0]);
      } catch (e) {
        console.warn('Insert error:', e.message);
      }
    }

    console.log('Cached', insertedDeals.length, 'local deals');

    let deals = insertedDeals;
    if (category && category !== 'Alle') deals = deals.filter(d => d.category === category);

    res.json({ deals, source: 'tilbudsugen', count: insertedDeals.length, location: { lat, lng } });
  } catch (err) {
    console.error('Deals error:', err.message);
    res.json({ deals: [], source: 'error', message: err.message });
  }
});

// GET /deals/search?q=mælk&lat=55.57&lng=9.75
router.get('/search', authMiddleware, async (req, res) => {
  const { q } = req.query;
  const lat = parseFloat(req.query.lat) || DEFAULT_LAT;
  const lng = parseFloat(req.query.lng) || DEFAULT_LNG;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Søgeord påkrævet' });
  try {
    const deals = await searchTilbudsugen(q.trim(), lat, lng);
    res.json({ deals, query: q, source: 'tilbudsugen', location: { lat, lng } });
  } catch (err) {
    res.json({ deals: [], query: q, source: 'error' });
  }
});

// GET /deals/categories
router.get('/categories', async (req, res) => {
  try {
    const r = await pool.query('SELECT DISTINCT category FROM deals WHERE expiry_date >= CURRENT_DATE ORDER BY category');
    res.json({ categories: ['Alle', ...r.rows.map(x => x.category).filter(Boolean)] });
  } catch (err) {
    res.json({ categories: ['Alle'] });
  }
});

// POST /deals/refresh
router.post('/refresh', authMiddleware, async (req, res) => {
  try { await pool.query('DELETE FROM deals'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;