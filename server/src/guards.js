'use strict';
// Express middleware and helpers that APPLY the decisions made in authz.js.
const authz = require('./authz');
const audit = require('./audit');
const { pool } = require('./db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Reject state-changing requests that lack our custom header (CSRF). */
async function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (authz.hasCsrfHeader(req)) return next(); // AUTHZ:csrfProtect -> return next();
  try {
    await audit.record(audit.fromReq(req, {
      action: 'csrf_check', outcome: 'denied', details: { method: req.method, path: req.path.slice(0, 200) },
    }));
  } catch (_) { /* still refuse */ }
  return res.status(403).json({ error: 'Missing request header' });
}

async function requireAuth(req, res, next) {
  if (req.user) return next(); // AUTHZ:requireAuth -> return next();
  // Refused attempts on document routes are part of the evidence trail.
  if (req.originalUrl.startsWith('/api/documents')) {
    try {
      const m = req.originalUrl.match(/^\/api\/documents\/([^/?]+)/);
      await audit.record(audit.fromReq(req, {
        action: 'unauthenticated_request',
        outcome: 'denied',
        documentId: m && isUuid(m[1]) ? m[1] : null,
        details: { method: req.method, path: req.originalUrl.slice(0, 200) },
      }));
    } catch (_) { /* still refuse */ }
  }
  return res.status(401).json({ error: 'Please sign in' });
}

function requireRole(check, action) {
  return async (req, res, next) => {
    if (check(req.user)) return next(); // AUTHZ:requireRole -> return next();
    try {
      await audit.record(audit.fromReq(req, {
        action, outcome: 'denied', details: { reason: 'role', role: req.user && req.user.role, path: req.originalUrl.slice(0, 200) },
      }));
    } catch (_) { /* still refuse */ }
    return res.status(403).json({ error: 'You do not have permission to do this' });
  };
}

const requireAdmin = requireRole(authz.isAdmin, 'admin_access');
const requireUploader = requireRole(authz.canUpload, 'upload');
const requireDirectory = requireRole(authz.canUseDirectory, 'user_directory');

const NEEDS = {
  read: authz.canRead,
  edit: authz.canEdit,
  manage: authz.canManage,
};

/**
 * Load a document and decide if the current user may perform `action` on it.
 * THIS is where the server decides, for every document route (download included).
 *
 * On refusal it writes a `denied` audit entry and answers 404 "Document not found"
 * for missing AND forbidden documents alike, so an attacker cannot tell
 * which document ids exist.
 *
 * @returns {Promise<{doc, level}|null>} null means a response was already sent.
 */
async function documentAccess(req, res, { need, action, trashed = false }) {
  const id = req.params.id;
  const valid = isUuid(id);
  let row = null;
  if (valid) {
    const { rows } = await pool.query(authz.documentAccessQuery, [id, req.user.id]);
    row = rows[0] || null;
  }
  // Live routes need a live document; trash routes need a deleted one.
  const stateOk = trashed ? Boolean(row) && row.deleted_at !== null : authz.isDocumentLive(row);
  const level = authz.levelFor(req.user, row);
  const allowed = stateOk && NEEDS[need](level); // AUTHZ:documentAccess -> const allowed = Boolean(row);

  if (!allowed) {
    await audit.record(audit.fromReq(req, {
      action,
      outcome: 'denied',
      documentId: valid ? id : null,
      details: {
        reason: !row ? 'not_found' : !stateOk ? (trashed ? 'not_in_trash' : 'deleted') : 'no_permission',
        level: level || 'none',
        ...(valid ? {} : { requested_id: String(id).slice(0, 80) }),
      },
    }));
    res.status(404).json({ error: 'Document not found' });
    return null;
  }
  return { doc: row, level };
}

module.exports = {
  isUuid,
  csrfProtect,
  requireAuth,
  requireAdmin,
  requireUploader,
  requireDirectory,
  documentAccess,
};
