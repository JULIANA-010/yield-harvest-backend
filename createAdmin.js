const bcrypt = require('bcryptjs');
const pool = require('./src/config/db');
require('dotenv').config();

async function createAdmin() {
  try {
    const passwordHash = await bcrypt.hash('adminpass123', 10);

    const result = await pool.query(
      `INSERT INTO users
      (full_name, phone, password_hash, role, status, is_active)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, full_name, phone, role`,
      [
        'Patience Admin',
        '0700000001',
        passwordHash,
        'admin',
        'active',
        true
      ]
    );

    console.log('✅ Admin account created successfully!');
    console.log(result.rows[0]);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

createAdmin();