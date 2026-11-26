const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { canAccessProject, checkProjectChoice } = require('../middleware/projects');

const router = express.Router();

// Demo establishments are managed by field officers (Super Agents).
// Program Officers and Admins keep access as a backup.
router.use(requireAuth, requireRole('super_agent', 'program_officer', 'admin'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dates come back as plain YYYY-MM-DD text so they never shift with time zones.
const DEMO_COLUMNS = `
  id, serial_no, host_name, value_chain, district_name, subcounty_name, parish_name,
  village_name, host_phone, host_contact_person, alt_phone, project_name,
  on_master_list, confirmed, confirmed_at,
  (SELECT full_name FROM users u WHERE u.id = confirmed_by) AS confirmed_by_name,
  to_char(established_date, 'YYYY-MM-DD') AS established_date,
  latitude, longitude, photo_url, notes, created_at
`;

const toNumberOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const validators = [
  body('hostName').trim().notEmpty().withMessage('Host name is required'),
  body('valueChain').trim().notEmpty().withMessage('Value chain is required'),
  body('districtName').trim().notEmpty().withMessage('District is required'),
  body('establishedDate')
    .optional({ nullable: true, checkFalsy: true })
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('Established date must be YYYY-MM-DD'),
];

// List all demos, plus the comparison against the master list.
router.get('/', async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    if (req.query.project) {
      params.push(req.query.project);
      conditions.push(`project_name = $${params.length}`);
    }
    // Only demos from the person's own project(s) (admins see all).
    if (req.user.projectNames !== null) {
      params.push(req.user.projectNames);
      conditions.push(`project_name = ANY($${params.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT ${DEMO_COLUMNS}
       FROM demo_establishments
       ${where}
       ORDER BY on_master_list DESC, serial_no NULLS LAST, created_at`,
      params
    );

    const master = rows.filter((r) => r.on_master_list);
    const extras = rows.filter((r) => !r.on_master_list);

    const byDistrictMap = {};
    for (const r of master) {
      const d = r.district_name;
      byDistrictMap[d] = byDistrictMap[d] || { district: d, listed: 0, confirmed: 0 };
      byDistrictMap[d].listed += 1;
      if (r.confirmed) byDistrictMap[d].confirmed += 1;
    }

    const masterConfirmed = master.filter((r) => r.confirmed).length;

    res.json({
      demos: rows,
      summary: {
        masterTotal: master.length,
        masterConfirmed,
        masterOutstanding: master.length - masterConfirmed,
        extraEntered: extras.length,
        byDistrict: Object.values(byDistrictMap),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching demos' });
  }
});

// Add a demo that is NOT on the master list (an extra one found or established in the field).
router.post('/', validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const d = req.body;

  const projectProblem = await checkProjectChoice(req.user, d.projectName);
  if (projectProblem) return res.status(projectProblem.status).json({ error: projectProblem.error });

  try {
    const { rows } = await pool.query(
      `INSERT INTO demo_establishments (
         host_name, value_chain, district_name, subcounty_name, parish_name, village_name,
         host_phone, host_contact_person, alt_phone, project_name,
         on_master_list, confirmed, confirmed_at, confirmed_by,
         established_date, latitude, longitude, photo_url, notes, recorded_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         FALSE, TRUE, now(), $11,
         $12,$13,$14,$15,$16,$11
       )
       RETURNING ${DEMO_COLUMNS}`,
      [
        d.hostName.trim(), d.valueChain.trim(), d.districtName.trim(),
        d.subcountyName || null, d.parishName || null, d.villageName || null,
        d.hostPhone || null, d.hostContactPerson || null, d.altPhone || null,
        d.projectName.trim(),
        req.user.id,
        d.establishedDate || null,
        toNumberOrNull(d.latitude), toNumberOrNull(d.longitude),
        d.photoUrl || null, d.notes || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error saving demo' });
  }
});

// Confirm / correct the details of a demo (works for master-list demos and extras).
router.patch('/:id', validators, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid demo id' });
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const d = req.body;

  const projectProblem = await checkProjectChoice(req.user, d.projectName);
  if (projectProblem) return res.status(projectProblem.status).json({ error: projectProblem.error });

  try {
    // The demo itself must also belong to one of the person's projects.
    const existing = await pool.query('SELECT project_name FROM demo_establishments WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Demo not found' });
    if (!canAccessProject(req.user, existing.rows[0].project_name)) {
      return res.status(403).json({ error: 'This demo belongs to a project you are not assigned to' });
    }

    const { rows } = await pool.query(
      `UPDATE demo_establishments SET
         host_name = $1, value_chain = $2, district_name = $3,
         subcounty_name = $4, parish_name = $5, village_name = $6,
         host_phone = $7, host_contact_person = $8, alt_phone = $9,
         project_name = $10,
         established_date = $11, latitude = $12, longitude = $13,
         photo_url = COALESCE($14, photo_url), notes = $15,
         confirmed = TRUE,
         confirmed_at = COALESCE(confirmed_at, now()),
         confirmed_by = COALESCE(confirmed_by, $16),
         updated_at = now()
       WHERE id = $17
       RETURNING ${DEMO_COLUMNS}`,
      [
        d.hostName.trim(), d.valueChain.trim(), d.districtName.trim(),
        d.subcountyName || null, d.parishName || null, d.villageName || null,
        d.hostPhone || null, d.hostContactPerson || null, d.altPhone || null,
        d.projectName.trim(),
        d.establishedDate || null,
        toNumberOrNull(d.latitude), toNumberOrNull(d.longitude),
        d.photoUrl || null, d.notes || null,
        req.user.id,
        req.params.id,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Demo not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating demo' });
  }
});

module.exports = router;