const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { attachScope } = require('../middleware/scope');

const router = express.Router();
router.use(requireAuth, attachScope);

// LIST training sessions visible to current user
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

// CREATE a training session + attendance list in one call
// (mirrors the paper form: header info + up to N participant rows)
router.post(
  '/',
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
          facilitator_name, recorded_by, client_uuid, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
        RETURNING id`,
        [
          t.farmerGroupId, t.activityDate, t.activityDescription || null, t.trainingTopics || null,
          t.activityVenue || null, t.districtId || null, t.subcountyId || null,
          t.villageAgentId || null, t.villageAgentPhone || null, t.facilitatorName || null,
          req.user.id, t.clientUuid || null,
        ]
      );
      const sessionId = sessionResult.rows[0].id;

      // attendance: array of { beneficiaryId, isPwdSnapshot, isRefugeeSnapshot, attestationNo, signed }
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
