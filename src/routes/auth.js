const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

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

      res.json({
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          phone: user.phone,
          role: user.role,
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

    const { fullName, phone, email, password, role, supervisorId, districtId } = req.body;
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(
        `INSERT INTO users (full_name, phone, email, password_hash, role, supervisor_id, district_id, status, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', TRUE)
         RETURNING id, full_name, phone, role`,
        [fullName, phone, email || null, passwordHash, role, supervisorId || null, districtId || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A user with this phone number already exists' });
      }
      console.error(err);
      res.status(500).json({ error: 'Server error creating user' });
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
    const { rows } = await pool.query(
      `SELECT u.id, u.full_name, u.phone, u.role, u.district_id, u.supervisor_id, u.created_at,
              s.full_name AS supervisor_name
       FROM users u
       LEFT JOIN users s ON u.supervisor_id = s.id
       WHERE u.status = 'active'
       ORDER BY u.role, u.full_name`
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
  const { supervisorId } = req.body;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const target = existingRows[0];
    if (!target) return res.status(404).json({ error: 'Account not found' });
    if (target.status !== 'pending') {
      return res.status(400).json({ error: 'This account is not pending approval' });
    }
    if (target.role === 'agent' && !supervisorId) {
      return res.status(400).json({ error: 'A supervising Super Agent must be selected for this agent' });
    }

    const { rows } = await pool.query(
      `UPDATE users SET status = 'active', is_active = TRUE, supervisor_id = $1 WHERE id = $2
       RETURNING id, full_name, phone, role, status`,
      [target.role === 'agent' ? supervisorId : null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error approving account' });
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