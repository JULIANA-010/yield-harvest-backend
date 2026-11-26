const pool = require('../config/db');

/**
 * Visibility rules:
 *  - admin: sees everything, every project.
 *  - program_officer: sees every farmer group in the project(s) they are assigned to.
 *  - super_agent: sees the farmer groups they manage, in their assigned projects.
 *  - agent: inherits the groups of the super agent they report to, in their assigned projects.
 *
 * A person assigned to no project sees nothing.
 *
 * Attaches req.scope = { groupIds: [...] | null, unrestricted, projectNames: [...] | null }
 * where groupIds null / unrestricted true means "no restriction" (admin only).
 */
async function attachScope(req, res, next) {
  try {
    const { id, role, supervisorId, projectNames } = req.user;

    if (role === 'admin') {
      req.scope = { groupIds: null, unrestricted: true, projectNames: null };
      return next();
    }

    const projects = projectNames || [];
    if (projects.length === 0) {
      req.scope = { groupIds: [], unrestricted: false, projectNames: [] };
      return next();
    }

    let rows;
    if (role === 'program_officer') {
      ({ rows } = await pool.query(
        'SELECT id FROM farmer_groups WHERE project_name = ANY($1)',
        [projects]
      ));
    } else if (role === 'super_agent') {
      ({ rows } = await pool.query(
        'SELECT id FROM farmer_groups WHERE managed_by = $1 AND project_name = ANY($2)',
        [id, projects]
      ));
    } else if (role === 'agent') {
      // regular agents inherit their supervising super agent's groups
      const ownerId = supervisorId || id;
      ({ rows } = await pool.query(
        'SELECT id FROM farmer_groups WHERE managed_by = $1 AND project_name = ANY($2)',
        [ownerId, projects]
      ));
    } else {
      rows = [];
    }

    req.scope = { groupIds: rows.map((r) => r.id), unrestricted: false, projectNames: projects };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { attachScope };