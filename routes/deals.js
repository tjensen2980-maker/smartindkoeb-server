// routes/deals.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const COMMON_SEARCHES = ['mælk', 'smør', 'ost', 'brød', 'kylling', 'hakket oksekød', 'æg', 'bananer', 'kartofler', 'pasta', 'ris', 'kaffe', 'yoghurt', 'pølser', 'juice'];
const DEFAULT_LAT = 55.57;
const DEFAULT_LNG = 9.75;
const RADIUS = 20000;

// KUN danske dagligvarebutikker
const GROCERY_STORES = new Set([
  'netto', 'rema 1000', 'føtex', 'bilka', 'lidl', 'aldi',
  'meny', 'spar', 'kvickly', 'superbrugsen', 'dagli\'brugsen',
  '365discount', 'coop 365discount', 'coop 365', 'fakta', 'irma',
  'løvbjerg', 'let-køb', 'min købmand', 'brugsen', 'abc lavpris',
  'nemlig.com', 'mad cooperativet', 'døgnkiosken',
]);

function isGroceryStore(name) {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  // Direkte match
  if (GROCERY_STORES.has(lower)) return true;
  // Delvis match (f.eks. "REMA 1000" matcher "rema 1000")
  for (const store of GROCERY_STORES) {
    if (lower.includes(store) || store.includes(lower)) return true;
  }
  return false;
}

let migrated = false;

async function migrate() {
  if (migrated) return;
  try {
    await pool.query('DROP TABLE IF EXISTS deals');
    await pool.query(`
      CREATE TABLE deals (
        id SERIAL PRIMARY KEY,
        store VARCHAR(100) NOT NULL,
        item VARCHAR(255) NOT NULL,
        description TEXT,
        old_price DECIMAL(10,2),
        new_price DECIMAL(10,2),
        savings DECIMAL(10,2),
        quantity VARCHAR(50),
        category VARCHAR(100),
        expiry_date DATE,
        image TEXT,
        lat DECIMAL(8,5),
        lng DECIMAL(8,5),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Deals table created');
    migrated = true;
  } catch (err) {
    console.error('Migration error:', err.message);
    migrated = true;
  }
}

function formatQuantity(offer) {
  const q = offer.quantity;
  if (!q) return null;
  const size = q.size?.from;
  const unit = q.unit?.symbol;
  if (!size || !unit) return null;
  if (unit === 'g' && size >= 1000) return (size / 1000) + ' kg';
  if (unit === 'ml' && size >= 1000) return (size / 1000) + ' L';
  if (unit === 'cl') return (size / 100) + ' L';
  if (unit === 'l') return size + ' L';
  if (unit === 'g') return size + ' g';
  if (unit === 'kg') return size + ' kg';
  if (unit === 'ml') return size + ' ml';
  if (unit === 'stk') return size + ' stk';
  return size + ' ' + unit;
}

async function searchEtilbudsavis(query, lat, lng) {
  try {
    const url = `https://api.etilbudsavis.dk/v2/offers/search?r_lat=${lat}&r_lng=${lng}&r_radius=${RADIUS}&r_locale=da_DK&query=${encodeURIComponent(query)}&offset=0&limit=24`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) return [];
    const data = await response.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter(offer => isGroceryStore(offer.branding?.name))
      .map(offer => ({
        id: offer.id,
        store: offer.branding?.name || 'Ukendt',
        item: offer.heading || '',
        description: offer.description || '',
        old_price: offer.pricing?.pre_price || null,
        new_price: offer.pricing?.price || null,
        savings: (offer.pricing?.pre_price && offer.pricing?.price)
          ? Math.round((offer.pricing.pre_price - offer.pricing.price) * 100) / 100
          : null,
        quantity: formatQuantity(offer),
        category: offer.branding?.name || 'Dagligvarer',
        image: offer.images?.view || offer.images?.thumb || null,
        expiry_date: offer.run_till ? offer.run_till.split('T')[0] : null,
      }))
      .filter(d => d.item);
  } catch (err) {
    console.warn('Search error for', query, ':', err.message);
    return [];
  }
}

// GET /deals?lat=55.91&lng=12.50
router.get('/', authMiddleware, async (req, res) => {
  const { category } = req.query;
  const lat = parseFloat(req.query.lat) || DEFAULT_LAT;
  const lng = parseFloat(req.query.lng) || DEFAULT_LNG;

  try {
    await migrate();

    const cached = await pool.query(
      `SELECT id, store, item, description, old_price, new_price, savings, quantity, category, image, expiry_date, created_at
       FROM deals
       WHERE created_at > NOW() - INTERVAL '2 hours'
         AND ABS(lat - $1) < 0.05 AND ABS(lng - $2) < 0.05
       ORDER BY savings DESC NULLS LAST, id DESC
       LIMIT 60`,
      [lat, lng]
    );

    if (cached.rows.length >= 15) {
      let deals = cached.rows;
      if (category && category !== 'Alle') deals = deals.filter(d => d.category === category);
      return res.json({ deals, source: 'cache', location: { lat, lng } });
    }

    console.log(`Fetching grocery deals within 20km of ${lat}, ${lng}...`);
    const shuffled = [...COMMON_SEARCHES].sort(() => Math.random() - 0.5);
    const searches = shuffled.slice(0, 6);

    const results = await Promise.all(searches.map(term => searchEtilbudsavis(term, lat, lng)));

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

    console.log('Found', allDeals.length, 'grocery deals (filtered)');

    if (allDeals.length === 0) {
      return res.json({ deals: [], source: 'empty', location: { lat, lng } });
    }

    await pool.query("DELETE FROM deals WHERE created_at < NOW() - INTERVAL '4 hours'");

    const insertedDeals = [];
    for (const d of allDeals) {
      try {
        const expiry = d.expiry_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        const result = await pool.query(
          `INSERT INTO deals (store, item, description, old_price, new_price, savings, quantity, category, expiry_date, image, lat, lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12)
           RETURNING id, store, item, description, old_price, new_price, savings, quantity, category, expiry_date, image, created_at`,
          [d.store, d.item, d.description, d.old_price, d.new_price, d.savings, d.quantity, d.category, expiry, d.image, lat, lng]
        );
        insertedDeals.push(result.rows[0]);
      } catch (e) {
        console.warn('Insert error:', e.message);
      }
    }

    console.log('Cached', insertedDeals.length, 'grocery deals');

    let deals = insertedDeals;
    if (category && category !== 'Alle') deals = deals.filter(d => d.category === category);
    deals.sort((a, b) => (b.savings || 0) - (a.savings || 0));

    res.json({ deals, source: 'etilbudsavis', count: insertedDeals.length, location: { lat, lng } });
  } catch (err) {
    console.error('Deals error:', err.message);
    res.json({ deals: [], source: 'error', message: err.message });
  }
});

// GET /deals/search?q=mælk&lat=55.91&lng=12.50
router.get('/search', authMiddleware, async (req, res) => {
  const { q } = req.query;
  const lat = parseFloat(req.query.lat) || DEFAULT_LAT;
  const lng = parseFloat(req.query.lng) || DEFAULT_LNG;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Søgeord påkrævet' });
  try {
    const deals = await searchEtilbudsavis(q.trim(), lat, lng);
    res.json({ deals, query: q, source: 'etilbudsavis', location: { lat, lng } });
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