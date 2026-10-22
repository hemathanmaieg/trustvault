'use strict';
// =============================================================================
// EVERY PERMISSION DECISION IN TRUSTVAULT IS MADE IN THIS FILE.
// =============================================================================
// Routes never compare roles or owner ids themselves; they call these functions
// (through server/src/guards.js). One place to read, one place to test, one
// place to point at in the interview.
//
// Each individual check carries a marker comment:
//     <code>  // AUTHZ:<name> -> <code with the check removed>
// `npm run test:authz-removal` swaps in the "removed" version of ONE check at a
// time and runs the whole test suite. Every swap must make at least one test
// fail; if a check can be removed with all tests still passing, the tests were
// not testing it. The same markers exist in guards.js, app.js and the routes.
//
// Permission model (see README "Roles and permissions"):
//   admin  - manages users, sees the audit log and alerts. Cannot upload, cannot
//            hold grants, cannot read document contents.
//   owner  - may upload documents; owns what they upload; can also be granted
//            other people's documents.
//   viewer - cannot upload; sees only documents granted to them.
// Per document:
//   owner (the uploader) > edit > read. Only the document owner can share,
//   revoke, delete, restore, list access and see the document's activity.
//   "edit" = read + upload a new version + change title/category/description.
// =============================================================================

const LEVELS = { read: 1, edit: 2, owner: 3 };

// ---- Sessions and sign-in ------------------------------------------------------

/** Is this session still usable? Checked on EVERY request (server/src/auth/session.js). */
function isSessionUsable(row, now = new Date()) {
  if (!row) return false;
  return row.is_active === true && new Date(row.expires_at) > now && new Date(row.idle_expires_at) > now; // AUTHZ:isSessionUsable -> return true;
}

/** Locked after repeated wrong passwords, or disabled by an admin. */
function canAttemptLogin(userRow, now = new Date()) {
  if (!userRow) return true; // unknown email: still run the (failing) password check for even timing
  return userRow.is_active === true && !(userRow.locked_until && new Date(userRow.locked_until) > now); // AUTHZ:canAttemptLogin -> return true;
}

// ---- Roles ------------------------------------------------------------------

function isAdmin(user) {
  return Boolean(user) && user.role === 'admin'; // AUTHZ:isAdmin -> return Boolean(user);
}

function canUpload(user) {
  return Boolean(user) && user.role === 'owner'; // AUTHZ:canUpload -> return Boolean(user);
}

/** Owners need the people directory to pick who to share with. */
function canUseDirectory(user) {
  return Boolean(user) && user.role === 'owner'; // AUTHZ:canUseDirectory -> return Boolean(user);
}

/** Admins never hold document access, even if a grant row somehow exists. */
function roleMayHoldDocuments(user) {
  return user.role === 'owner' || user.role === 'viewer'; // AUTHZ:roleMayHoldDocuments -> return true;
}

// ---- Per-document access ----------------------------------------------------

/**
 * This user's level on a document, from a row produced by `documentAccessQuery`.
 * Returns 'owner' | 'edit' | 'read' | null.
 */
function levelFor(user, row) {
  if (!user || !row) return null;
  if (!roleMayHoldDocuments(user)) return null;
  return row.owner_id === user.id ? 'owner' : row.grant_permission || null; // AUTHZ:levelFor -> return 'owner';
}

/** Deleted (trashed) documents are unreachable except through the owner's restore route. */
function isDocumentLive(row) {
  return Boolean(row) && row.deleted_at === null; // AUTHZ:isDocumentLive -> return Boolean(row);
}

function canRead(level) {
  return Boolean(level) && LEVELS[level] >= LEVELS.read; // AUTHZ:canRead -> return true;
}

function canEdit(level) {
  return Boolean(level) && LEVELS[level] >= LEVELS.edit; // AUTHZ:canEdit -> return true;
}

/** Share, revoke, delete, restore, see who has access, see the document's activity. */
function canManage(level) {
  return level === 'owner'; // AUTHZ:canManage -> return true;
}

/** Who may receive a grant: an active owner or viewer who is not the document's owner. */
function canReceiveGrant(target, documentOwnerId) {
  if (!target) return false;
  return target.is_active === true && roleMayHoldDocuments(target) && target.id !== documentOwnerId; // AUTHZ:canReceiveGrant -> return true;
}

/**
 * Loads one document plus the CURRENT user's grant, straight from the database,
 * on every request. There is no cache and no permission inside a token, which
 * is what makes revocation take effect immediately.  $1 = document id, $2 = user id.
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
 * SQL condition limiting a document list to what `userParam` may see. Used by
 * search, so a search can never reveal a title the user could not open.
 */
function visibleDocumentsCondition(userParam) {
  return `(d.owner_id = ${userParam} OR EXISTS (SELECT 1 FROM grants g2 WHERE g2.document_id = d.id AND g2.user_id = ${userParam}))`; // AUTHZ:visibleDocumentsCondition -> return 'TRUE';
}

/**
 * Second, independent layer for lists: keep only rows this user can read.
 * Rows must carry owner_id and grant_permission.
 */
function filterReadable(user, rows) {
  return rows.filter((row) => canRead(levelFor(user, row))); // AUTHZ:filterReadable -> return rows;
}

/** Trash shows only documents this user owns. */
function trashCondition(userParam) {
  return `d.owner_id = ${userParam}`; // AUTHZ:trashCondition -> return 'TRUE';
}

// ---- Request-level guards -----------------------------------------------------

/**
 * Cross-site request protection for state-changing requests. Together with
 * SameSite=Strict cookies, every change must carry our custom header. Browsers
 * do not send custom headers cross-site without a CORS preflight, and this
 * server never approves a preflight.
 */
function hasCsrfHeader(req) {
  return req.get('X-TrustVault-Request') === '1'; // AUTHZ:hasCsrfHeader -> return true;
}

module.exports = {
  LEVELS,
  isSessionUsable,
  canAttemptLogin,
  isAdmin,
  canUpload,
  canUseDirectory,
  roleMayHoldDocuments,
  levelFor,
  isDocumentLive,
  canRead,
  canEdit,
  canManage,
  canReceiveGrant,
  documentAccessQuery,
  visibleDocumentsCondition,
  filterReadable,
  trashCondition,
  hasCsrfHeader,
};
