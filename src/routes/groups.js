const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { attachScope } = require('../middleware/scope');
const { checkProjectChoice } = require('../middleware/projects');

const router = express.Router();
router.use(requireAuth, attachScope);

// LIST groups visible to the current user (optionally for one project)
router.get('/', async (req, res) => {
  try {
    let query = `SELECT g.*, d.name AS district_name
                 FROM farmer_groups g
                 LEFT JOIN districts d ON g.district_id = d.id`;
    const params = [];
    const conditions = [];

    if (!req.scope.unrestricted) {
      if (req.scope.groupIds.length === 0) return res.json([]);
      params.push(req.scope.groupIds);
      conditions.push(`g.id = ANY($${params.length})`);
    }
    if (req.query.projectName) {
      params.push(req.query.projectName);
      conditions.push(`g.project_name = $${params.length}`);
    }
    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY g.name';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching groups' });
  }
});

// CREATE group — super_agent (for their own portfolio) or officer/admin.
// The group is registered under one project, and every participant registered in
// it belongs to that project.
router.post(
  '/',
  requireRole('agent', 'super_agent', 'program_officer', 'admin'),
  [body('name').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const g = req.body;

    const projectProblem = await checkProjectChoice(req.user, g.projectName);
    if (projectProblem) return res.status(projectProblem.status).json({ error: projectProblem.error });

    const managedBy = req.user.role === 'super_agent' ? req.user.id : (g.managedBy || req.user.id);

    try {
      const { rows } = await pool.query(
        `INSERT INTO farmer_groups (
          name, group_type, district_id,
          subcounty_name, parish_name, village_name,
          chairperson_name, chairperson_phone,
          agent_name, agent_phone,
          managed_by, village_agent_id,
          project_name
        ) VALUES ($1,$2,$3, $4,$5,$6, $7,$8, $9,$10, $11,$12, $13)
        RETURNING id`,
        [
          g.name, g.groupType || 'farmer_group', g.districtId || null,
          g.subcountyName || null, g.parishName || null, g.villageName || null,
          g.chairpersonName || null, g.chairpersonPhone || null,
          g.agentName || null, g.agentPhone || null,
          managedBy, g.villageAgentId || null,
          g.projectName.trim(),
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