// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        plan VARCHAR(50) DEFAULT 'basis',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        selected_stores JSONB DEFAULT '["Netto","Rema 1000","Føtex"]',
        notifications_enabled BOOLEAN DEFAULT true,
        UNIQUE(user_id)
      );

      CREATE TABLE IF NOT EXISTS shopping_lists (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) DEFAULT 'Min liste',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS shopping_items (
        id SERIAL PRIMARY KEY,
        list_id INTEGER REFERENCES shopping_lists(id) ON DELETE CASCADE,
        text VARCHAR(255) NOT NULL,
        checked BOOLEAN DEFAULT false,
        store VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        store VARCHAR(100) NOT NULL,
        item VARCHAR(255) NOT NULL,
        old_price DECIMAL(10,2),
        new_price DECIMAL(10,2),
        savings DECIMAL(10,2),
        category VARCHAR(100),
        expiry_date DATE,
        image TEXT,
        search_term VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS meal_plans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        week_number INTEGER,
        year INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS meal_days (
        id SERIAL PRIMARY KEY,
        plan_id INTEGER REFERENCES meal_plans(id) ON DELETE CASCADE,
        day_name VARCHAR(20) NOT NULL,
        meal_name VARCHAR(255) NOT NULL,
        ingredients JSONB,
        stores JSONB,
        estimated_savings DECIMAL(10,2) DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS scan_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        image_url TEXT,
        result JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS savings_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        category VARCHAR(100),
        store VARCHAR(100),
        month INTEGER,
        year INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Tilføj manglende kolonner til eksisterende deals tabel
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE deals ADD COLUMN IF NOT EXISTS image TEXT;
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE deals ADD COLUMN IF NOT EXISTS search_term VARCHAR(100);
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;
    `);

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };