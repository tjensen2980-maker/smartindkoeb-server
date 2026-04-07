// routes/deals.js
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Tjek/eTilbudsavis business IDs for Danish stores
const STORE_IDS = {
  'Netto': '9ba51',
  'Rema 1000': '11deC',
  'Føtex': 'bfMe0',
  'Bilka': '93f13',
  'Lidl': '71c90',
  'Aldi': 'b7Dnn',
  'Meny': 'a23s7',
  'Spar': '230Lm',
  'Coop365': 'c1G3q',
};

// Fetch real offers from eTilbudsavis/Tjek
async function fetchRealDeals(storeNames) {
  const allDeals = [];

  for (const storeName of storeNames) {
    const storeId = STORE_IDS[storeName];
    if (!storeId) continue;

    try {
      const url = `https://squid-api.tjek.com/v4/rpc/get_offers?r_lat=55.5&r_lng=9.75&r_radius=50000&r_locale=da_DK&dealer_ids=${storeId}&limit=20&order_by=-savings`;
      
      console.log(`Fetching deals from ${storeName} (${storeId})...`);
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SmartIndkoeb/1.0',
        },
      });

      if (!response.ok) {
        console.warn(`Tjek API returned ${response.status} for ${storeName}`);
        continue;
      }

      const data = await response.json();
      
      if (Array.isArray(data)) {
        for (const offer of data) {
          if (!offer.name || !offer.pricing) continue;
          
          const price = offer.pricing?.price || null;
          const prePrice = offer.pricing?.pre_price || null;
          const savings = prePrice && price ? Math.round((prePrice - price) * 100) / 100 : 0;

          allDeals.push({
            store: storeName,
            item: offer.name,
            old_price: prePrice || price,
            new_price: price,
            savings: savings,
            category: categorize(offer.name),
            expiry_date: offer.valid_until ? offer.valid_until.split('T')[0] : null,
            image: offer.images?.view_url || null,
          });
        }
      }
    } catch (err) {
      console.warn(`Error fetching ${storeName}:`, err.message);
    }
  }

  return allDeals;
}

// Simple Danish grocery categorizer
function categorize(itemName) {
  const name = itemName.toLowerCase();
  if (/mælk|ost|smør|yoghurt|skyr|fløde|æg/.test(name)) return 'Mejeri';
  if (/kylling|okse|svine|hakke|pølse|bacon|laks|fisk|rejer/.test(name)) return 'Kød & fisk';
  if (/æble|banan|tomat|agurk|salat|løg|kartof|gulerod|frugt|grønt|avocado|peber/.test(name)) return 'Frugt & grønt';
  if (/brød|rugbrød|bolle|kage|wiener/.test(name)) return 'Brød & bageri';
  if (/cola|pepsi|juice|vand|øl|vin|kaffe|te/.test(name)) return 'Drikkevarer';
  if (/frossen|frost|is|pizza/.test(name)) return 'Frost';
  if (/shampoo|toilet|vaske|rengør|opvask/.test(name)) return 'Husholdning';
  return 'Kolonial';
}

// GET /deals - Hent ægte tilbud fra danske supermarkeder
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
      return res.json({ deals, source: 'cache' });
    }

    // 3. Hent ægte tilbud fra eTilbudsavis
    console.log('Fetching real deals from eTilbudsavis...');
    let realDeals = await fetchRealDeals(selectedStores);
    console.log(`Got ${realDeals.length} real deals`);

    // 4. Personalisér med AI baseret på brugerens historik
    const history = await pool.query(
      `SELECT text FROM shopping_items 
       WHERE list_id IN (SELECT id FROM shopping_lists WHERE user_id = $1)
       AND checked = true
       ORDER BY created_at DESC LIMIT 20`,
      [req.userId]
    );
    const purchasedItems = history.rows.map(r => r.text);

    if (purchasedItems.length > 0 && realDeals.length > 10) {
      try {
        // Lad AI ranke tilbuddene baseret på brugerens vaner
        const dealNames = realDeals.slice(0, 40).map((d, i) => `${i}: ${d.item} (${d.store}, ${d.savings} kr spart)`).join('\n');
        
        const prompt = `Brugeren har tidligere købt: ${purchasedItems.join(', ')}.

Her er aktuelle tilbud:
${dealNames}

Ranker de 20 mest relevante tilbud for denne bruger (baseret på deres købshistorik). Svar KUN med en JSON array af indeks-numre, f.eks. [3, 1, 7, 12, ...]. Ingen forklaring.`;

        const aiResponse = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }],
        });

        const rankText = aiResponse.content.map(b => b.text || '').join('').trim();
        const rankedIndices = JSON.parse(rankText.replace(/```json|```/g, ''));
        
        // Reorder deals based on AI ranking
        const rankedDeals = rankedIndices
          .filter(i => i >= 0 && i < realDeals.length)
          .map(i => realDeals[i]);
        
        // Add remaining deals that weren't ranked
        const rankedSet = new Set(rankedIndices);
        const remaining = realDeals.filter((_, i) => !rankedSet.has(i));
        realDeals = [...rankedDeals, ...remaining];
        
        console.log('AI personalized deal ranking');
      } catch (aiErr) {
        console.warn('AI ranking failed, using default order:', aiErr.message);
      }
    }

    // 5. Gem i database cache
    await pool.query("DELETE FROM deals WHERE created_at < NOW() - INTERVAL '6 hours'");

    const insertedDeals = [];
    for (const d of realDeals.slice(0, parseInt(limit))) {
      try {
        const expiryDate = d.expiry_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        
        const result = await pool.query(
          `INSERT INTO deals (store, item, old_price, new_price, savings, category, expiry_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date)
           RETURNING id, store, item, old_price, new_price, savings, category, expiry_date, created_at`,
          [d.store, d.item, d.old_price, d.new_price, d.savings, d.category, expiryDate]
        );
        insertedDeals.push(result.rows[0]);
      } catch (insertErr) {
        console.warn('Insert deal error:', insertErr.message);
      }
    }

    console.log(`Cached ${insertedDeals.length} deals`);

    let deals = insertedDeals;
    if (category && category !== 'Alle') {
      deals = deals.filter(d => d.category === category);
    }

    res.json({ deals, source: 'live', fetched: realDeals.length, cached: insertedDeals.length });
  } catch (err) {
    console.error('Deals error:', err.message);
    
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

// GET /deals/categories
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT category FROM deals WHERE expiry_date >= CURRENT_DATE ORDER BY category'
    );
    const categories = result.rows.map(r => r.category).filter(Boolean);
    res.json({ categories: ['Alle', ...categories] });
  } catch (err) {
    res.json({ categories: ['Alle', 'Mejeri', 'Kød & fisk', 'Frugt & grønt', 'Brød & bageri', 'Kolonial', 'Drikkevarer'] });
  }
});

// POST /deals/refresh - Tving nye tilbud
router.post('/refresh', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM deals');
    res.json({ message: 'Cache ryddet. Hent /deals for nye tilbud.' });
  } catch (err) {
    res.status(500).json({ error: 'Kunne ikke rydde cache' });
  }
});

module.exports = router;