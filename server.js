// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');

const authRoutes = require('./routes/auth');
const dealsRoutes = require('./routes/deals');
const shoppingRoutes = require('./routes/shopping');
const scanRoutes = require('./routes/scan');
const mealsRoutes = require('./routes/meals');
const savingsRoutes = require('./routes/savings');
const settingsRoutes = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'SmartIndkøb API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Routes
app.use('/auth', authRoutes);
app.use('/deals', dealsRoutes);
app.use('/shopping', shoppingRoutes);
app.use('/scan', scanRoutes);
app.use('/meals', mealsRoutes);
app.use('/savings', savingsRoutes);
app.use('/settings', settingsRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Intern serverfejl' });
});

// Start
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🚀 SmartIndkøb API kører på port ${PORT}`);
    console.log(`📡 Endpoints:`);
    console.log(`   POST /auth/register`);
    console.log(`   POST /auth/login`);
    console.log(`   GET  /auth/profile`);
    console.log(`   GET  /deals`);
    console.log(`   GET  /deals/categories`);
    console.log(`   GET  /shopping/list`);
    console.log(`   POST /shopping/items`);
    console.log(`   PUT  /shopping/items/:id/toggle`);
    console.log(`   POST /scan`);
    console.log(`   GET  /meals/current`);
    console.log(`   GET  /savings/summary`);
    console.log(`   GET  /settings`);
    console.log(`   PUT  /settings`);
  });
}

start().catch(console.error);
