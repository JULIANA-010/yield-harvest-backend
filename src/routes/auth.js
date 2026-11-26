const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---- project helpers -------------------------------------------------------
// Projects a person can work with: admins get every project.
async function loadProjectsFor(userId, role) {
  if (role === 'admin') {
    const { rows } = await pool.query('SELECT name, label FROM projects ORDER BY sort_order, name');
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT p.name, p.label
     FROM user_projects up JOIN projects p ON p.name = up.project_name
     WHERE up.user_id = $1
     ORDER BY p.sort_order, p.name`,
    [userId]
  );
  return rows;
}

// Accepts an array of project names; returns the cleaned list, or null if any is unknown.
async function validProjectNames(names) {
  if (!Array.isArray(names)) return null;
  const cleaned = Array.from(new Set(names.map((n) => String(n).trim()).filter(Boolean)));
  if (cleaned.length === 0) return [];
  const { rows } = await pool.query('SELECT name FROM projects WHERE name = ANY($1::text[])', [cleaned]);
  return rows.length === cleaned.length ? cleaned : null;
}

async function replaceUserProjects(client, userId, names) {
  await client.query('DELETE FROM user_projects WHERE user_id = $1', [userId]);
  if (names.length > 0) {
    await client.query(
      `INSERT INTO user_projects (user_id, project_name)
       SELECT $1, p.name FROM projects p WHERE p.name = ANY($2::text[])`,
      [userId, names]
    );
  }
}

router.post(
  '/login',
  [body('phone').notEmpty(), body('password').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { phone, password } = req.body;
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid phone or password' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid phone or password' });

      if (user.status === 'pending') {
        return res.status(403).json({
          error: 'Your account is pending admin approval. Please check back later.',
          pendingApproval: true,
        });
      }
      if (user.status === 'removed') {
        return res.status(403).json({
          error: 'This account has been removed. Please contact your administrator.',
        });
      }

      const token = jwt.sign(
        {
          id: user.id,
          role: user.role,
          supervisorId: user.supervisor_id,
          districtId: user.district_id,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      const projects = await loadProjectsFor(user.id, user.role);

      res.json({
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          phone: user.phone,
          role: user.role,
          projects,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error during login' });
    }
  }
);

router.post(
  '/register',
  [
    body('fullName').notEmpty(),
    body('phone').notEmpty(),
    body('password').isLength({ min: 6 }),
    body('role').isIn(['agent', 'super_agent']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { fullName, phone, password, role, districtId } = req.body;
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(
        `INSERT INTO users (full_name, phone, password_hash, role, district_id, status, is_active)
         VALUES ($1, $2, $3, $4, $5, 'pending', FALSE)
         RETURNING id, full_name, phone, role`,
        [fullName, phone, passwordHash, role, districtId || null]
      );
      res.status(201).json({
        ...rows[0],
        message: 'Account created. An admin must approve it before you can log in.',
      });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A user with this phone number already exists' });
      }
      console.error(err);
      res.status(500).json({ error: 'Server error creating account' });
    }
  }
);

router.post(
  '/users',
  requireAuth,
  requireRole('admin'),
  [
    body('fullName').notEmpty(),
    body('phone').notEmpty(),
    body('password').isLength({ min: 6 }),
    body('role').isIn(['agent', 'super_agent', 'program_officer', 'admin']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { fullName, phone, email, password, role, supervisorId, districtId, projects } = req.body;

    // Everyone except admins must be assigned to at least one project.
    let projectNames = [];
    if (role !== 'admin') {
      projectNames = await validProjectNames(projects);
      if (projectNames === null) return res.status(400).json({ error: 'One or more projects are not valid' });
      if (projectNames.length === 0) {
        return res.status(400).json({ error: 'Please select at least one project for this account' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const passwordHash = await bcrypt.hash(password, 10);
      const { rows } = await client.query(
        `INSERT INTO users (full_name, phone, email, password_hash, role, supervisor_id, district_id, status, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', TRUE)
         RETURNING id, full_name, phone, role`,
        [fullName, phone, email || null, passwordHash, role, supervisorId || null, districtId || null]
      );
      await replaceUserProjects(client, rows[0].id, projectNames);
      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A user with this phone number already exists' });
      }
      console.error(err);
      res.status(500).json({ error: 'Server error creating user' });
    } finally {
      client.release();
    }
  }
);

router.get('/pending', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, role, district_id, created_at
       FROM users WHERE status = 'pending' ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching pending accounts' });
  }
});

router.get('/active', requireAuth, requireRole('admin', 'program_officer'), async (req, res) => {
  try {
    // Admins see everyone. A program officer only sees people working on their own project(s).
    const params = [];
    let projectFilter = '';
    if (req.user.projectNames !== null) {
      params.push(req.user.projectNames);
      projectFilter = `AND EXISTS (SELECT 1 FROM user_projects up2
                                   WHERE up2.user_id = u.id AND up2.project_name = ANY($1))`;
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.phone, u.role, u.district_id, u.supervisor_id, u.created_at,
              s.full_name AS supervisor_name,
              COALESCE(
                (SELECT array_agg(up.project_name ORDER BY up.project_name)
                 FROM user_projects up WHERE up.user_id = u.id),
                ARRAY[]::varchar[]
              ) AS projects
       FROM users u
       LEFT JOIN users s ON u.supervisor_id = s.id
       WHERE u.status = 'active' ${projectFilter}
       ORDER BY u.role, u.full_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching active accounts' });
  }
});

router.get('/super-agents', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name FROM users WHERE role = 'super_agent' AND status = 'active' ORDER BY full_name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching super agents' });
  }
});

router.patch('/users/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  const { supervisorId, projects } = req.body;
  const client = await pool.connect();
  try {
    const { rows: existingRows } = await client.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const target = existingRows[0];
    if (!target) return res.status(404).json({ error: 'Account not found' });
    if (target.status !== 'pending') {
      return res.status(400).json({ error: 'This account is not pending approval' });
    }
    if (target.role === 'agent' && !supervisorId) {
      return res.status(400).json({ error: 'A supervising Super Agent must be selected for this agent' });
    }

    const projectNames = await validProjectNames(projects);
    if (projectNames === null) return res.status(400).json({ error: 'One or more projects are not valid' });
    if (projectNames.length === 0) {
      return res.status(400).json({ error: 'Please select at least one project for this account' });
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET status = 'active', is_active = TRUE, supervisor_id = $1 WHERE id = $2
       RETURNING id, full_name, phone, role, status`,
      [target.role === 'agent' ? supervisorId : null, req.params.id]
    );
    await replaceUserProjects(client, req.params.id, projectNames);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error approving account' });
  } finally {
    client.release();
  }
});

// CHANGE WHICH PROJECTS A PERSON WORKS ON — admin only
router.put('/users/:id/projects', requireAuth, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: existingRows } = await client.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
    const target = existingRows[0];
    if (!target) return res.status(404).json({ error: 'Account not found' });
    if (target.role === 'admin') {
      return res.status(400).json({ error: 'Admins can always see every project' });
    }

    const projectNames = await validProjectNames(req.body.projects);
    if (projectNames === null) return res.status(400).json({ error: 'One or more projects are not valid' });
    if (projectNames.length === 0) {
      return res.status(400).json({ error: 'Please select at least one project' });
    }

    await client.query('BEGIN');
    await replaceUserProjects(client, req.params.id, projectNames);
    await client.query('COMMIT');
    res.json({ id: req.params.id, projects: projectNames });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error updating projects' });
  } finally {
    client.release();
  }
});

router.delete('/users/:id/reject', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM users WHERE id = $1 AND status = 'pending' RETURNING id",
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Pending account not found (it may already be approved)' });
    }
    res.json({ message: 'Account request rejected and removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error rejecting account' });
  }
});

router.patch('/users/:id/remove', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const target = existingRows[0];
    if (!target) return res.status(404).json({ error: 'Account not found' });

    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Admin accounts cannot be removed through this action' });
    }
    if (target.id === req.user.id) {
      return res.status(403).json({ error: 'You cannot remove your own account' });
    }

    const { rows } = await pool.query(
      `UPDATE users SET status = 'removed', is_active = FALSE WHERE id = $1
       RETURNING id, full_name, phone, role, status`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error removing account' });
  }
});

// LIST MY AGENTS — super_agent only. Lets a super agent see the village
// agents currently assigned to (supervised by) them.
router.get('/my-agents', requireAuth, requireRole('super_agent'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, district_id, created_at
       FROM users
       WHERE supervisor_id = $1 AND status = 'active'
       ORDER BY full_name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching your agents' });
  }
});

// GET MY PROFILE — any authenticated user
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.phone, u.role, u.district_id, u.profile_photo_url, u.created_at,
              s.full_name AS supervisor_name
       FROM users u
       LEFT JOIN users s ON u.supervisor_id = s.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// UPDATE MY PROFILE — full name and/or profile photo only. Phone number
// is intentionally never editable here (it's the login identifier).
router.patch(
  '/me',
  requireAuth,
  [body('fullName').optional().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { fullName, profilePhotoUrl } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE users SET
           full_name = COALESCE($1, full_name),
           profile_photo_url = COALESCE($2, profile_photo_url)
         WHERE id = $3
         RETURNING id, full_name, phone, role, profile_photo_url`,
        [fullName || null, profilePhotoUrl || null, req.user.id]
      );
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error updating profile' });
    }
  }
);

// CHANGE MY PASSWORD — requires the current password for verification
router.patch(
  '/me/password',
  requireAuth,
  [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 6 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { currentPassword, newPassword } = req.body;
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
      res.json({ message: 'Password updated successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error updating password' });
    }
  }
);

module.exports = router;