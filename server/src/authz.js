'use strict';
// =============================================================================
// EVERY PERMISSION DECISION IN TRUSTVAULT IS MADE IN THIS FILE.
// =============================================================================
// Routes never compare roles or owner ids themselves; they call these functions.
// That gives one place to read, one place to test, and one place a reviewer
// can point at and say "if this line went, here is what would break".
//
// Lines marked `// AUTHZ:<name> -> <permissive expression>` are the individual
// checks. `npm run test:authz-removal` replaces each one, one at a time, with
// the permissive expression (i.e. removes the check) and confirms that at least
// one test fails. If removing a check does not break a test, that test suite
// was not testing it.
//
// Permission model (see README "Roles and permissions"):
//   admin  - manages users, sees the audit log and alerts. Cannot upload, cannot
//            be granted documents, cannot read document contents.
//   owner  - may upload documents; owns what they upload; can also be granted
//            other people's documents.
//   viewer - cannot upload; sees only documents granted to them.
// Per document:
//   owner (the uploader) > edit > read. Only the document owner can share,
//   revoke, delete or restore. "edit" = read + new version + change details.
// =============================================================================

const LEVELS = { read: 1, edit: 2, owner: 3 };

// ---- Sessions ---------------------------------------------------------------

/** Is this session still usable? Checked on EVERY request (server/src/auth/session.js). */
function isSessionUsable(sessionRow, now = new Date()) {
  return Boolean(sessionRow) && sessionRow.is_active === true && new Date(sessionRow.expires_at) > now && new Date(sessionRow.idle_expires_at) > now; // AUTHZ:isSessionUsable -> Boolean(sessionRow)
}

/** Account locked after repeated wrong passwords, or disabled by an admin. */
function canAttemptLogin(userRow, now = new Date()) {
  if (!userRow) return true; // unknown email: still run the (failing) password check for even timing
  return userRow.is_active === true && !(userRow.locked_until && new Date(userRow.locked_until) > now); // AUTHZ:canAttemptLogin -> true
}

// ---- Roles ------------------------------------------------------------------

function isAdmin(user) {
  return Boolean(user) && user.role === 'admin'; // AUTHZ:isAdmin -> Boolean(user)
}

function canUpload(user) {
  return Boolean(user) && user.role === 'owner'; // AUTHZ:canUpload -> Boolean(user)
}

/** Owners need the people directory to pick who to share with. */
function canUseDirectory(user) {
  return Boolean(user) && user.role === 'owner'; // AUTHZ:canUseDirectory -> Boolean(user)
}

// ---- Per-document access ----------------------------------------------------

/**
 * Work out this user's level on a document from a row produced by
 * `documentAccessQuery` below. Returns 'owner' | 'edit' | 'read' | null.
 */
function levelFor(user, row) {
  if (!user || !row) return null;
  // Admins never hold document access, even if a grant row somehow exists.
  if (user.role === 'admin') return null; // AUTHZ:adminHasNoDocAccess -> undefined
  return row.owner_id === user.id ? 'owner' : row.grant_permission || null; // AUTHZ:levelFor -> 'owner'
}

/** Deleted (trashed) documents are unreachable except through the owner's trash routes. */
function isDocumentLive(row) {
  return Boolean(row) && row.deleted_at === null; // AUTHZ:isDocumentLive -> Boolean(row)
}

function canRead(level) {
  return Boolean(level) && LEVELS[level] >= LEVELS.read; // AUTHZ:canRead -> true
}

function canEdit(level) {
  return Boolean(level) && LEVELS[level] >= LEVELS.edit; // AUTHZ:canEdit -> true
}

/** Share, revoke, delete, restore, see who has access, see the document's activity. */
function canManage(level) {
  return level === 'owner'; // AUTHZ:canManage -> true
}

/** Who may receive a grant: an active owner or viewer who is not the document owner. */
function canReceiveGrant(target, documentOwnerId) {
  return Boolean(target) && target.is_active === true && target.role !== 'admin' && target.id !== documentOwnerId; // AUTHZ:canReceiveGrant -> Boolean(target)
}

/**
 * SQL that loads one document plus the CURRENT user's grant, straight from the
 * database, on every request. There is no cache and no permission baked into a
 * token, which is what makes revocation take effect immediately.
 * $1 = document id, $2 = user id.
 */
const documentAccessQuery = `
  SELECT d.id, d.owner_id, d.title, d.category, d.description, d.current_version,
         d.created_at, d.updated_at, d.deleted_at,
         o.name AS owner_name, o.email AS owner_email,
         g.permission AS grant_permission
    FROM documents d
    JOIN users o ON o.id = d.owner_id
    LEFT JOIN grants g ON g.document_id = d.id AND g.user_id = $2
   WHERE d.id = $1`;

/**
 * SQL condition limiting a document list to what `userParam` may see.
 * Used by search and listing so a search can never reveal a title the user
 * could not open.
 */
function visibleDocumentsCondition(userParam) {
  return `(d.owner_id = ${userParam} OR EXISTS (SELECT 1 FROM grants g2 WHERE g2.document_id = d.id AND g2.user_id = ${userParam}))`; // AUTHZ:visibleDocumentsCondition -> 'TRUE'
}

/** Trash shows only documents this user owns. */
function trashCondition(userParam) {
  return `d.owner_id = ${userParam}`; // AUTHZ:trashCondition -> 'TRUE'
}

// ---- Request-level guards -----------------------------------------------------

/**
 * Cross-site request protection for state-changing requests. Together with
 * SameSite=Strict cookies, a request that changes anything must carry our custom
 * header; browsers will not send a custom header cross-site without a CORS
 * preflight, and we never answer preflights.
 */
function hasCsrfHeader(req) {
  return req.get('X-TrustVault-Request') === '1'; // AUTHZ:hasCsrfHeader -> true
}

module.exports = {
  LEVELS,
  isSessionUsable,
  canAttemptLogin,
  isAdmin,
  canUpload,
  canUseDirectory,
  levelFor,
  isDocumentLive,
  canRead,
  canEdit,
  canManage,
  canReceiveGrant,
  documentAccessQuery,
  visibleDocumentsCondition,
  trashCondition,
  hasCsrfHeader,
};
