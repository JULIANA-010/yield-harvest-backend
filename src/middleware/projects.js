const pool = require('../config/db');

// True if this person may work with the given project.
// Admins (projectNames === null) may use every project.
function canAccessProject(user, projectName) {
  if (!projectName) return false;
  return user.projectNames === null || user.projectNames.includes(projectName);
}

async function projectExists(projectName) {
  const { rows } = await pool.query('SELECT 1 FROM projects WHERE name = $1', [projectName]);
  return rows.length > 0;
}

// Checks a project chosen on a form: it must exist and the person must have access to it.
// Returns an error message, or null if everything is fine.
async function checkProjectChoice(user, projectName) {
  const name = (projectName || '').trim();
  if (!name) return { status: 400, error: 'Please select a project' };
  if (!(await projectExists(name))) return { status: 400, error: 'Unknown project' };
  if (!canAccessProject(user, name)) {
    return { status: 403, error: 'You are not assigned to this project' };
  }
  return null;
}

module.exports = { canAccessProject, projectExists, checkProjectChoice };