const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// The projects the signed-in person can work with (admins get all of them).
router.get('/', async (req, res) => {
  try {
    let result;
    if (req.user.projectNames === null) {
      result = await pool.query('SELECT name, label FROM projects ORDER BY sort_order, name');
    } else {
      result = await pool.query(
        'SELECT name, label FROM projects WHERE name = ANY($1) ORDER BY sort_order, name',
        [req.user.projectNames]
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching projects' });
  }
});

module.exports = router;