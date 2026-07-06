const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { attachScope } = require('../middleware/scope');

const router = express.Router();
router.use(requireAuth, attachScope);

// LIST groups visible to the current user
router.get('/', async (req, res) => {
  try {
    let query = `SELECT g.*, d.name AS district_name
                 FROM farmer_groups g
                 LEFT JOIN districts d ON g.district_id = d.id`;
    const params = [];

    if (!req.scope.unrestricted) {
      if (req.scope.groupIds.length === 0) return res.json([]);
      query += ' WHERE g.id = ANY($1)';
      params.push(req.scope.groupIds);
    }
    query += ' ORDER BY g.name';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching groups' });
  }
});

// CREATE group — super_agent (for their own portfolio) or officer/admin
router.post(
  '/',
  requireRole('super_agent', 'program_officer', 'admin'),
  [body('name').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const g = req.body;
    // super_agents can only create groups managed by themselves
    const managedBy = req.user.role === 'super_agent' ? req.user.id : (g.managedBy || req.user.id);

    try {
      const { rows } = await pool.query(
        `INSERT INTO farmer_groups (name, group_type, district_id, subcounty_id, parish_id, village_id,
          chairperson_name, chairperson_phone, managed_by, village_agent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          g.name, g.groupType || 'farmer_group', g.districtId || null, g.subcountyId || null,
          g.parishId || null, g.villageId || null, g.chairpersonName || null, g.chairpersonPhone || null,
          managedBy, g.villageAgentId || null,
        ]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error creating group' });
    }
  }
);

module.exports = router;
