'use strict';
// Express middleware and helpers that APPLY the decisions made in authz.js.
const authz = require('./authz');
const audit = require('./audit');
const { pool } = require('./db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Lowercase a uuid so the same id is always spelled the same way. */
function normalizeId(value) {
  return isUuid(value) ? value.toLowerCase() : value;
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-13-45). */
function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// NUL characters and broken UTF-16 cannot be stored by PostgreSQL; refuse them
// up front with a clear 400 instead of failing deep inside a query.
const BAD_TEXT_RE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function hasBadText(value, depth = 0) {
  if (depth > 10) return true;
  if (typeof value === 'string') return BAD_TEXT_RE.test(value);
  if (Array.isArray(value)) return value.some((v) => hasBadText(v, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => BAD_TEXT_RE.test(k) || hasBadText(v, depth + 1));
  return false;
}

function rejectBadText(req, res, next) {
  if (hasBadText(req.query) || hasBadText(req.body) || BAD_TEXT_RE.test(req.path)) {
    return res.status(400).json({ error: 'The request contains characters that are not allowed' });
  }
  return next();
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
  const id = normalizeId(req.params.id);
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

/**
 * Second check for writes that take time (an upload in progress, an edit):
 * inside the write's own transaction, lock the document row and re-read the
 * caller's grant. Grant and revoke lock the same row, so a revoke either
 * finishes first (and this refuses) or waits until this write is done.
 * Without this, an editor removed in the middle of a slow upload could still
 * add a version after the revoke.
 */
async function recheckInTransaction(client, user, docId, need) {
  const { rows } = await client.query(`${authz.documentAccessQuery} FOR UPDATE OF d`, [docId, user.id]);
  const row = rows[0] || null;
  const stateOk = authz.isDocumentLive(row);
  const level = authz.levelFor(user, row);
  return stateOk && NEEDS[need](level); // AUTHZ:recheckInTransaction -> return true;
}

/** Lock a document row so grant changes and in-flight writes are serialised. */
async function lockDocument(client, docId) {
  await client.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [docId]);
}

module.exports = {
  isUuid,
  normalizeId,
  isRealDate,
  rejectBadText,
  recheckInTransaction,
  lockDocument,
  csrfProtect,
  requireAuth,
  requireAdmin,
  requireUploader,
  requireDirectory,
  documentAccess,
};
