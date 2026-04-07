// routes/deals.js
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /deals/search?q=mælk - Søg efter ægte tilbud via tilbudsugen.dk
router.get('/search', authMiddleware, async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Søgeord er påkrævet' });
  }

  try {
    const query = encodeURIComponent(q.trim());
    const url = `https://www.tilbudsugen.dk/api/api/typeahead-search/dk/${query}`;

    console.log('Searching tilbudsugen.dk for:', q);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      console.warn('Tilbudsugen API returned', response.status);
      return res.json({ deals: [], source: 'error' });
    }

    const data = await response.json();
    const items = data.organicProductOffers?.items || [];

    const deals = items.map(offer => ({
      id: offer.id,
      store: offer.chain?.name || 'Ukendt',
      item: [offer.brand?.name, offer.productName?.productName].filter(Boolean).join(' ') || offer.definedDescription || '',
      description: offer.definedDescription || '',
      new_price: parseFloat(offer.price) || null,
      quantity: offer.quantity ? `${offer.quantity} ${offer.quantityType || ''}`.trim() : null,
      unit_price: offer.pricePerFullUnitOfQuantityType ? parseFloat(offer.pricePerFullUnitOfQuantityType) : null,
      category: offer.productVariant?.category?.name || 'Dagligvarer',
      image: offer.imageThumbnailUrl || offer.imageUrl || null,
      start_date: offer.startDate || null,
      expiry_date: offer.endDate || null,
    })).filter(d => d.item);

    console.log('Found', deals.length, 'deals for', q);

    res.json({ deals, query: q, source: 'tilbudsugen' });
  } catch (err) {
    console.error('Search error:', err.message);
    res.json({ deals: [], query: q, source: 'error', message: err.message });
  }
});

// GET /deals - Hent populære tilbud fra tilbudsugen.dk
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Søg efter populære dagligvarer
    const searches = ['mælk', 'kylling', 'brød', 'ost', 'frugt'];
    const randomSearch = searches[Math.floor(Math.random() * searches.length)];
    
    const url = `https://www.tilbudsugen.dk/api/api/typeahead-search/dk/${encodeURIComponent(randomSearch)}`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    
    if (!response.ok) {
      return res.json({ deals: [], source: 'error' });
    }

    const data = await response.json();
    const items = data.organicProductOffers?.items || [];

    const deals = items.map(offer => ({
      id: offer.id,
      store: offer.chain?.name || 'Ukendt',
      item: [offer.brand?.name, offer.productName?.productName].filter(Boolean).join(' ') || '',
      new_price: parseFloat(offer.price) || null,
      category: offer.productVariant?.category?.name || 'Dagligvarer',
      image: offer.imageThumbnailUrl || null,
      expiry_date: offer.endDate || null,
    })).filter(d => d.item);

    res.json({ deals, source: 'tilbudsugen' });
  } catch (err) {
    console.error('Deals error:', err.message);
    res.json({ deals: [], source: 'error' });
  }
});

// GET /deals/categories
router.get('/categories', async (req, res) => {
  res.json({ categories: ['Alle', 'Mejeri', 'Kød', 'Frugt & grønt', 'Brød', 'Kolonial', 'Drikkevarer'] });
});

module.exports = router;