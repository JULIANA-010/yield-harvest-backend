const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { attachScope } = require('../middleware/scope');

const router = express.Router();
router.use(requireAuth, attachScope);

// Trainings are recorded by field officers (Super Agents).
// Program Officers and Admins keep access as a backup.
const TRAINING_ROLES = ['super_agent', 'program_officer', 'admin'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------
// FARMER GROUP TRAININGS
// ------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    let query = `SELECT t.*, g.name AS group_name
                 FROM training_sessions t
                 JOIN farmer_groups g ON t.farmer_group_id = g.id`;
    const params = [];

    if (!req.scope.unrestricted) {
      if (req.scope.groupIds.length === 0) return res.json([]);
      query += ' WHERE t.farmer_group_id = ANY($1)';
      params.push(req.scope.groupIds);
    }
    query += ' ORDER BY t.activity_date DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching training sessions' });
  }
});

// ------------------------------------------------------------
// VILLAGE AGENT TRAININGS (trainings given TO village agents)
// These routes are declared before the farmer POST so paths never collide.
// ------------------------------------------------------------

// Does the users table have a "status" column? (checked once, then remembered)
let usersHasStatusColumn = null;
async function usersHaveStatus() {
  if (usersHasStatusColumn === null) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'status' LIMIT 1`
    );
    usersHasStatusColumn = rows.length > 0;
  }
  return usersHasStatusColumn;
}

// The list of village agents a field officer can pick attendees from.
router.get('/agent-roster', requireRole(...TRAINING_ROLES), async (req, res) => {
  try {
    const params = [];
    const conditions = [`role = 'agent'`];

    if (await usersHaveStatus()) {
      conditions.push(`COALESCE(status::text, 'active') NOT IN ('removed', 'pending', 'rejected')`);
    } else {
      conditions.push('is_active = TRUE');
    }

    // A Super Agent only sees the village agents assigned to them.
    if (req.user.role === 'super_agent') {
      params.push(req.user.id);
      conditions.push(`supervisor_id = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT id, full_name, phone
       FROM users
       WHERE ${conditions.join(' AND ')}
       ORDER BY full_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching village agents' });
  }
});

router.get('/agent', requireRole(...TRAINING_ROLES), async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.user.role === 'super_agent') {
      params.push(req.user.id);
      where = 'WHERE s.recorded_by = $1';
    }
    const { rows } = await pool.query(
      `SELECT s.*,
              u.full_name AS recorded_by_name,
              (SELECT COUNT(*) FROM agent_training_attendance a
                WHERE a.agent_training_session_id = s.id)::int AS attendee_count
       FROM agent_training_sessions s
       LEFT JOIN users u ON u.id = s.recorded_by
       ${where}
       ORDER BY s.activity_date DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching agent trainings' });
  }
});

router.post(
  '/agent',
  requireRole(...TRAINING_ROLES),
  [body('activityDate').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const t = req.body;
    const agentIds = Array.isArray(t.attendance)
      ? t.attendance.map((a) => a && a.agentId).filter(Boolean)
      : [];
    if (agentIds.some((id) => !UUID_RE.test(String(id)))) {
      return res.status(400).json({ error: 'One or more attendee ids are invalid' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const sessionResult = await client.query(
        `INSERT INTO agent_training_sessions (
          activity_date, training_topics, activity_description, activity_venue,
          district_id, facilitator_name, hard_copy_photo_url, project_name,
          recorded_by, client_uuid, synced_at
        ) VALUES (
          $1, $2, $3, $4,
          (SELECT district_id FROM users WHERE id = $5),
          $6, $7, $8,
          $5, $9, now()
        )
        ON CONFLICT (client_uuid) WHERE client_uuid IS NOT NULL DO NOTHING
        RETURNING id`,
        [
          t.activityDate,
          t.trainingTopics || null,
          t.activityDescription || null,
          t.activityVenue || null,
          req.user.id,
          t.facilitatorName || null,
          t.hardCopyPhotoUrl || null,
          t.projectName || null,
          t.clientUuid || null,
        ]
      );

      // Same record sent twice (e.g. a retry after a dropped connection): already saved.
      if (sessionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        const existing = await pool.query(
          'SELECT id FROM agent_training_sessions WHERE client_uuid = $1',
          [t.clientUuid]
        );
        return res.status(200).json({ id: existing.rows[0]?.id, duplicate: true });
      }

      const sessionId = sessionResult.rows[0].id;

      if (agentIds.length > 0) {
        await client.query(
          `INSERT INTO agent_training_attendance (agent_training_session_id, agent_id)
           SELECT $1, u.id FROM users u
           WHERE u.id = ANY($2::uuid[]) AND u.role = 'agent'
           ON CONFLICT (agent_training_session_id, agent_id) DO NOTHING`,
          [sessionId, agentIds]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ id: sessionId });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Server error creating agent training session' });
    } finally {
      client.release();
    }
  }
);

// ------------------------------------------------------------
// FARMER GROUP TRAININGS: create
// ------------------------------------------------------------
router.post(
  '/',
  requireRole(...TRAINING_ROLES),
  [body('farmerGroupId').notEmpty(), body('activityDate').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const t = req.body;
    if (!req.scope.unrestricted && !req.scope.groupIds.includes(t.farmerGroupId)) {
      return res.status(403).json({ error: 'You cannot record training for a group you do not manage' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const sessionResult = await client.query(
        `INSERT INTO training_sessions (
          farmer_group_id, activity_date, activity_description, training_topics,
          activity_venue, district_id, subcounty_id, village_agent_id, village_agent_phone,
          facilitator_name, recorded_by, client_uuid,
          hard_copy_photo_url,
          synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, $13, now())
        RETURNING id`,
        [
          t.farmerGroupId, t.activityDate, t.activityDescription || null, t.trainingTopics || null,
          t.activityVenue || null, t.districtId || null, t.subcountyId || null,
          t.villageAgentId || null, t.villageAgentPhone || null, t.facilitatorName || null,
          req.user.id, t.clientUuid || null,
          t.hardCopyPhotoUrl || null,
        ]
      );
      const sessionId = sessionResult.rows[0].id;

      if (Array.isArray(t.attendance)) {
        for (const a of t.attendance) {
          await client.query(
            `INSERT INTO training_attendance (
              training_session_id, beneficiary_id, is_pwd_snapshot, is_refugee_snapshot,
              attestation_no, signed
            ) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (training_session_id, beneficiary_id) DO NOTHING`,
            [sessionId, a.beneficiaryId, a.isPwdSnapshot || false, a.isRefugeeSnapshot || false, a.attestationNo || null, a.signed || false]
          );
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ id: sessionId });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Server error creating training session' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;