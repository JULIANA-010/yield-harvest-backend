const { Pool } = require('pg');
require('dotenv').config();

// Supabase (and most managed Postgres) requires SSL in production
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

module.exports = pool;
