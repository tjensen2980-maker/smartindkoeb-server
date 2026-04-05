// routes/scan.js
const express = require('express');
const multer = require('multer');
const Anthropic = require('anthropic').default;
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const SCAN_PROMPT = `Du er en dansk madlavnings-AI. Analyser dette billede af et køleskab eller madvarer. Svar KUN med valid JSON (ingen markdown, ingen backticks):
{"items":["vare1","vare2"],"recipes":[{"name":"Opskrift","ingredients":["ing1","ing2"],"time":"20 min","difficulty":"Let"},{"name":"Opskrift2","ingredients":["ing1","ing2"],"time":"30 min","difficulty":"Medium"}],"missing":[{"item":"manglende vare","cheapest_store":"Netto","price":"12.95 kr"}],"tip":"Et kort tip om madspild eller opbevaring"}`;

// POST /scan - Upload billede og analyser med Claude
router.post('/', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Intet billede uploadet' });
  }

  try {
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: SCAN_PROMPT },
        ],
      }],
    });

    const text = response.content.map(b => b.text || '').join('');
    const cleaned = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);

    // Save to history
    await pool.query(
      'INSERT INTO scan_history (user_id, result) VALUES ($1, $2)',
      [req.userId, JSON.stringify(result)]
    );

    res.json({ result });
  } catch (err) {
    console.error('Scan error:', err);

    // Fallback result
    res.json({
      result: {
        items: ['Mælk', 'Æg', 'Smør', 'Ost', 'Agurk', 'Peberfrugt', 'Kylling'],
        recipes: [
          { name: 'Omelet med ost & grønt', ingredients: ['Æg', 'Ost', 'Peberfrugt'], time: '15 min', difficulty: 'Let' },
          { name: 'Kyllingesalat', ingredients: ['Kylling', 'Agurk', 'Peberfrugt'], time: '20 min', difficulty: 'Let' },
        ],
        missing: [
          { item: 'Fløde', cheapest_store: 'Netto', price: '8.95 kr' },
          { item: 'Pasta', cheapest_store: 'Rema 1000', price: '7.95 kr' },
        ],
        tip: 'Opbevar agurker udenfor køleskabet — de holder sig bedre ved stuetemperatur.',
      },
      fallback: true,
    });
  }
});

// GET /scan/history - Hent scan-historik
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, result, created_at FROM scan_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.userId]
    );
    res.json({ scans: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Serverfejl' });
  }
});

module.exports = router;
