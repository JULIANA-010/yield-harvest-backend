const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// Verifies the JWT AND re-checks the account's current status from the
// database on every request. This is what makes "removing an agent"
// actually take effect immediately, instead of the agent staying logged
// in for up to 7 days until their old token naturally expires.
//
// It also loads the projects the person is assigned to:
//   req.user.projectNames === null  -> admin, can see every project
//   req.user.projectNames === [...] -> only these projects (may be empty)
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query('SELECT status, role FROM users WHERE id = $1', [payload.id]);
    if (!rows[0] || rows[0].status !== 'active') {
      return res.status(403).json({ error: 'Your account is no longer active. Please contact your administrator.' });
    }

    let projectNames = null;
    if (rows[0].role !== 'admin') {
      const projectRows = await pool.query(
        'SELECT project_name FROM user_projects WHERE user_id = $1 ORDER BY project_name',
        [payload.id]
      );
      projectNames = projectRows.rows.map((r) => r.project_name);
    }

    req.user = { ...payload, projectNames };
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Server error verifying account status' });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };