'use strict';
// Administrator API. Every route here requires role = admin (see app.js).
// Admins manage people and watch activity; they cannot open document contents.
const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db');
const audit = require('../audit');
const { hashPassword, validatePasswordStrength } = require('../auth/passwords');
const { endAllSessions } = require('../auth/session');
const { isUuid, normalizeId, isRealDate } = require('../guards');
const { HttpError } = require('../errors');

const router = express.Router();

// One spelling for every id: uppercase and lowercase uuids are the same user.
router.param('id', (req, res, next, id) => {
  req.params.id = normalizeId(id);
  next();
});

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, active: u.is_active,
    lockedUntil: u.locked_until && new Date(u.locked_until) > new Date() ? u.locked_until : null,
    createdAt: u.created_at,
  };
}

// ---- Users -------------------------------------------------------------------
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY role, name');
    res.json({ users: rows.map(publicUser) });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'owner', 'viewer']),
  password: z.string().min(1).max(200),
});

router.post('/users', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body || {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
    const weak = validatePasswordStrength(parsed.data.password);
    if (weak) throw new HttpError(400, weak);
    const hash = await hashPassword(parsed.data.password);
    const user = await withTransaction(async (client) => {
      const exists = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [parsed.data.email]);
      if (exists.rows[0]) throw new HttpError(409, 'A user with this email already exists');
      const { rows } = await client.query(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
        [parsed.data.email, parsed.data.name, parsed.data.role, hash]
      );
      await audit.record(audit.fromReq(req, {
        action: 'user_create', targetUserId: rows[0].id, details: { email: rows[0].email, role: rows[0].role },
      }), client);
      return rows[0];
    });
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(['admin', 'owner', 'viewer']).optional(),
  active: z.boolean().optional(),
  unlock: z.literal(true).optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to change');

router.patch('/users/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'User not found');
    const parsed = updateSchema.safeParse(req.body || {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
    const body = parsed.data;
    if (req.params.id === req.user.id && (body.role !== undefined || body.active !== undefined)) {
      throw new HttpError(400, 'You cannot change your own role or disable yourself');
    }
    const updated = await withTransaction(async (client) => {
      const cur = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
      const u = cur.rows[0];
      if (!u) throw new HttpError(404, 'User not found');
      const changes = {};
      if (body.name !== undefined && body.name !== u.name) changes.name = { from: u.name, to: body.name };
      if (body.role !== undefined && body.role !== u.role) changes.role = { from: u.role, to: body.role };
      if (body.active !== undefined && body.active !== u.is_active) changes.active = { from: u.is_active, to: body.active };
      if (body.unlock) changes.unlocked = true;
      if (Object.keys(changes).length === 0) return u;

      const { rows } = await client.query(
        `UPDATE users SET name = $2, role = $3, is_active = $4,
                failed_logins = CASE WHEN $5 THEN 0 ELSE failed_logins END,
                locked_until = CASE WHEN $5 THEN NULL ELSE locked_until END,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [u.id, body.name ?? u.name, body.role ?? u.role, body.active ?? u.is_active, Boolean(body.unlock)]
      );
      // A role change or a disable ends every session immediately.
      // An admin cannot own documents, so someone who still owns documents
      // cannot be made an admin (their files would be left with no manager).
      if (changes.role && changes.role.to === 'admin') {
        const owned = await client.query('SELECT count(*)::int AS n FROM documents WHERE owner_id = $1', [u.id]);
        if (owned.rows[0].n > 0) {
          throw new HttpError(400, 'This person owns documents. They must delete them before becoming an administrator.');
        }
      }
      if (changes.role || changes.active) await endAllSessions(u.id, client);
      // An admin never holds document grants.
      if (changes.role && changes.role.to === 'admin') {
        const removed = await client.query('DELETE FROM grants WHERE user_id = $1 RETURNING document_id', [u.id]);
        changes.grantsRemoved = removed.rowCount;
      }
      await audit.record(audit.fromReq(req, { action: 'user_update', targetUserId: u.id, details: { email: u.email, changes } }), client);
      return rows[0];
    });
    res.json({ user: publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/password', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'User not found');
    const password = req.body && req.body.password;
    const weak = validatePasswordStrength(password);
    if (weak) throw new HttpError(400, weak);
    const hash = await hashPassword(password);
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        'UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1 RETURNING email',
        [req.params.id, hash]
      );
      if (!rows[0]) throw new HttpError(404, 'User not found');
      await endAllSessions(req.params.id, client);
      await audit.record(audit.fromReq(req, { action: 'password_reset', targetUserId: req.params.id, details: { email: rows[0].email } }), client);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Audit log ---------------------------------------------------------------
const auditQuery = z.object({
  action: z.string().trim().max(50).optional(),
  outcome: z.enum(['allowed', 'denied']).optional(),
  actor: z.string().trim().max(200).optional(),
  document: z.string().trim().optional(),
  from: z.string().refine(isRealDate).optional(),
  to: z.string().refine(isRealDate).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional().default(1),
});

router.get('/audit', async (req, res, next) => {
  try {
    const parsed = auditQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'Invalid filters');
    const f = parsed.data;
    const params = [];
    const where = [];
    if (f.action) { params.push(f.action); where.push(`a.action = $${params.length}`); }
    if (f.outcome) { params.push(f.outcome); where.push(`a.outcome = $${params.length}`); }
    if (f.actor) { params.push(`%${f.actor.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`a.actor_email ILIKE $${params.length} ESCAPE '\\'`); }
    if (f.document) {
      if (!isUuid(f.document)) throw new HttpError(400, 'Document filter must be a document id');
      params.push(normalizeId(f.document)); where.push(`a.document_id = $${params.length}`);
    }
    if (f.from) { params.push(f.from); where.push(`a.occurred_at >= $${params.length}::date`); }
    if (f.to) { params.push(f.to); where.push(`a.occurred_at < ($${params.length}::date + 1)`); }
    const pageSize = 100;
    params.push(pageSize, (f.page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT a.seq, a.occurred_at, a.actor_email, a.action, a.outcome, a.document_id, a.target_user_id,
              a.details, a.ip, d.title AS document_title, tu.email AS target_email
         FROM audit_log a
         LEFT JOIN documents d ON d.id = a.document_id
         LEFT JOIN users tu ON tu.id = a.target_user_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.seq DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({
      page: f.page,
      events: rows.map((r) => ({
        seq: Number(r.seq), at: r.occurred_at, actor: r.actor_email, action: r.action, outcome: r.outcome,
        documentId: r.document_id, documentTitle: r.document_title, targetEmail: r.target_email,
        details: r.details, ip: r.ip,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/audit/verify', async (req, res, next) => {
  try {
    const result = await audit.verifyChain();
    await audit.record(audit.fromReq(req, {
      action: 'audit_verify', details: { ok: result.ok, checked: result.checked, problem: result.problem || null },
    }));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- Alerts: things worth noticing ---------------------------------------------
router.get('/alerts', async (req, res, next) => {
  try {
    const [denials, bulk, afterRevoke, locked, grantsToday] = await Promise.all([
      // Someone (or some address) refused many times in the last 24 hours.
      pool.query(`
        SELECT COALESCE(actor_email, 'not signed in (' || COALESCE(ip, '?') || ')') AS who,
               count(*)::int AS denied, max(occurred_at) AS last_at
          FROM audit_log
         WHERE outcome = 'denied' AND occurred_at > now() - interval '24 hours' AND action <> 'login'
         GROUP BY 1 HAVING count(*) >= 5 ORDER BY denied DESC LIMIT 20`),
      // Unusually many downloads by one person in the last hour.
      pool.query(`
        SELECT actor_email AS who, count(*)::int AS downloads, count(DISTINCT document_id)::int AS documents
          FROM audit_log
         WHERE action = 'download' AND outcome = 'allowed' AND occurred_at > now() - interval '1 hour'
         GROUP BY 1 HAVING count(*) >= 10 ORDER BY downloads DESC LIMIT 20`),
      // Someone kept trying a document after their access was taken away.
      pool.query(`
        SELECT DISTINCT ON (d.actor_id, d.document_id)
               d.actor_email AS who, d.document_id, doc.title, r.occurred_at AS revoked_at, d.occurred_at AS attempted_at
          FROM audit_log r
          JOIN audit_log d ON d.actor_id = r.target_user_id AND d.document_id = r.document_id
                          AND d.seq > r.seq AND d.outcome = 'denied'
          LEFT JOIN documents doc ON doc.id = d.document_id
         WHERE r.action = 'revoke' AND r.occurred_at > now() - interval '7 days'
         ORDER BY d.actor_id, d.document_id, d.seq DESC LIMIT 20`),
      // Accounts locked by repeated wrong passwords.
      pool.query(`
        SELECT u.email AS who, a.occurred_at AS locked_at
          FROM audit_log a JOIN users u ON u.id = a.target_user_id
         WHERE a.action = 'account_locked' AND a.occurred_at > now() - interval '24 hours'
         ORDER BY a.seq DESC LIMIT 20`),
      pool.query(`
        SELECT count(*)::int AS n FROM audit_log
         WHERE action IN ('grant','grant_change','revoke') AND occurred_at > now() - interval '24 hours'`),
    ]);
    res.json({
      repeatedDenials: denials.rows,
      bulkDownloads: bulk.rows,
      attemptsAfterRevoke: afterRevoke.rows,
      lockedAccounts: locked.rows,
      permissionChanges24h: grantsToday.rows[0].n,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Document overview (metadata only, never contents) ---------------------------
router.get('/documents', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.id, d.title, d.category, d.created_at, d.updated_at, d.deleted_at, d.current_version,
             o.email AS owner_email,
             (SELECT count(*)::int FROM grants g WHERE g.document_id = d.id) AS grant_count,
             (SELECT count(*)::int FROM audit_log a WHERE a.document_id = d.id AND a.action = 'download' AND a.outcome = 'allowed') AS downloads,
             (SELECT count(*)::int FROM audit_log a WHERE a.document_id = d.id AND a.outcome = 'denied') AS denied,
             (SELECT max(a.occurred_at) FROM audit_log a WHERE a.document_id = d.id) AS last_activity
        FROM documents d JOIN users o ON o.id = d.owner_id
       ORDER BY last_activity DESC NULLS LAST`);
    res.json({
      documents: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, owner: r.owner_email, createdAt: r.created_at,
        deleted: Boolean(r.deleted_at), versions: r.current_version, grants: r.grant_count,
        downloads: r.downloads, denied: r.denied, lastActivity: r.last_activity,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
