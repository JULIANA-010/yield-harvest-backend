const pool = require('../config/db');

/**
 * Visibility rules confirmed by the client:
 *  - agent / super_agent: can only see the farmer groups they manage
 *    (an agent's "managed groups" = groups where managed_by = their own id,
 *    OR groups managed by the super_agent they report to, depending on how
 *    the client wants day-to-day work split — currently modelled as:
 *    super_agents own groups directly; regular agents are attached to a
 *    super_agent and inherit that super_agent's group list for read access,
 *    but only super_agents can create new beneficiary profiles).
 *  - program_officer / admin: see everything, all districts.
 *
 * This middleware attaches `req.scope = { groupIds: [...] | null }`
 * where null means "no restriction" (program_officer/admin).
 */
async function attachScope(req, res, next) {
  try {
    const { id, role, supervisorId } = req.user;

    if (role === 'program_officer' || role === 'admin') {
      req.scope = { groupIds: null, unrestricted: true };
      return next();
    }

    if (role === 'super_agent') {
      const { rows } = await pool.query(
        'SELECT id FROM farmer_groups WHERE managed_by = $1',
        [id]
      );
      req.scope = { groupIds: rows.map(r => r.id), unrestricted: false };
      return next();
    }

    if (role === 'agent') {
      // regular agents inherit their supervising super agent's groups
      const ownerId = supervisorId || id;
      const { rows } = await pool.query(
        'SELECT id FROM farmer_groups WHERE managed_by = $1',
        [ownerId]
      );
      req.scope = { groupIds: rows.map(r => r.id), unrestricted: false };
      return next();
    }

    // unknown role - default to no access
    req.scope = { groupIds: [], unrestricted: false };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { attachScope };
