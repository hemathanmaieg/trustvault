'use strict';
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const config = require('../config');
const { pool, withTransaction } = require('../db');
const authz = require('../authz');
const audit = require('../audit');
const { CATEGORIES } = require('../categories');
const { validateUpload } = require('../upload/validate');
const { requireUploader, documentAccess, isUuid } = require('../guards');
const { HttpError } = require('../errors');

const router = express.Router();

// Files are held in memory only long enough to validate and store them in the
// database. Nothing is ever written to a public folder.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes, files: 1, fields: 10, fieldSize: 4000, parts: 15 },
}).single('file');

function runUpload(req, res) {
  return new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const metaSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  category: z.enum(CATEGORIES),
  description: z.string().trim().max(1000).optional().default(''),
});

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function publicDoc(row, level) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    myAccess: level,
  };
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------
// GET /api/documents  - list + search (name, owner, category, date)
// ---------------------------------------------------------------------------
const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  owner: z.string().trim().max(200).optional(),
  category: z.enum(CATEGORIES).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  scope: z.enum(['all', 'mine', 'shared']).optional().default('all'),
});

router.get('/', async (req, res, next) => {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'Invalid search filters');
    const f = parsed.data;
    const params = [req.user.id];
    // The visibility condition is ALWAYS applied, before any user filter.
    const where = [authz.visibleDocumentsCondition('$1'), 'd.deleted_at IS NULL'];
    if (f.q) {
      params.push(`%${escapeLike(f.q)}%`);
      where.push(`d.title ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (f.owner) {
      params.push(`%${escapeLike(f.owner)}%`);
      where.push(`(o.name ILIKE $${params.length} ESCAPE '\\' OR o.email ILIKE $${params.length} ESCAPE '\\')`);
    }
    if (f.category) {
      params.push(f.category);
      where.push(`d.category = $${params.length}`);
    }
    if (f.from) {
      params.push(f.from);
      where.push(`d.created_at >= $${params.length}::date`);
    }
    if (f.to) {
      params.push(f.to);
      where.push(`d.created_at < ($${params.length}::date + 1)`);
    }
    if (f.scope === 'mine') where.push('d.owner_id = $1');
    if (f.scope === 'shared') where.push('d.owner_id <> $1');

    const { rows } = await pool.query(
      `SELECT d.*, o.name AS owner_name, o.email AS owner_email,
              (SELECT g.permission FROM grants g WHERE g.document_id = d.id AND g.user_id = $1) AS grant_permission
         FROM documents d JOIN users o ON o.id = d.owner_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.updated_at DESC
        LIMIT 200`,
      params
    );
    const documents = rows
      .map((r) => ({ row: r, level: authz.levelFor(req.user, r) }))
      .filter((x) => authz.canRead(x.level)) // second, independent check on every row
      .map((x) => publicDoc(x.row, x.level));
    res.json({ documents, categories: CATEGORIES });
  } catch (err) {
    next(err);
  }
});

router.get('/categories', (req, res) => res.json({ categories: CATEGORIES }));

// ---------------------------------------------------------------------------
// POST /api/documents  - upload a new document (role: owner)
// ---------------------------------------------------------------------------
router.post('/', requireUploader, async (req, res, next) => {
  try {
    await runUpload(req, res);
    const file = await validateUpload(req.file);
    const defaults = { title: file.filename.replace(/\.[^.]+$/, '') || file.filename, category: 'General' };
    const parsed = metaSchema.safeParse({ ...defaults, ...stripEmpty(req.body) });
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
    const meta = parsed.data;

    const doc = await withTransaction(async (client) => {
      const d = await client.query(
        `INSERT INTO documents (owner_id, title, category, description)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.user.id, meta.title, meta.category, meta.description]
      );
      const id = d.rows[0].id;
      await client.query(
        `INSERT INTO document_versions (document_id, version_no, filename, mime_type, size_bytes, sha256, content, uploaded_by)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
        [id, file.filename, file.mimeType, file.size, file.sha256, file.content, req.user.id]
      );
      await audit.record(audit.fromReq(req, {
        action: 'upload', documentId: id,
        details: { title: meta.title, filename: file.filename, size: file.size, sha256: file.sha256, version: 1 },
      }), client);
      return id;
    });
    res.status(201).json({ id: doc });
  } catch (err) {
    if (err instanceof HttpError || (err && err.name === 'MulterError')) {
      await audit.record(audit.fromReq(req, {
        action: 'upload', outcome: 'denied', details: { reason: 'validation', message: err.message.slice(0, 200) },
      })).catch(() => {});
    }
    next(err);
  }
});

function stripEmpty(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /api/documents/trash  - my deleted documents (document owner only)
// ---------------------------------------------------------------------------
router.get('/trash', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, o.name AS owner_name, o.email AS owner_email
         FROM documents d JOIN users o ON o.id = d.owner_id
        WHERE ${authz.trashCondition('$1')} AND d.deleted_at IS NOT NULL
        ORDER BY d.deleted_at DESC`,
      [req.user.id]
    );
    res.json({ documents: rows.map((r) => publicDoc(r, 'owner')) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/documents/:id  - details + versions (read)
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'read', action: 'view' });
    if (!access) return;
    const { doc, level } = access;
    const versions = await pool.query(
      `SELECT v.version_no, v.filename, v.mime_type, v.size_bytes, v.sha256, v.created_at, u.name AS uploaded_by_name
         FROM document_versions v JOIN users u ON u.id = v.uploaded_by
        WHERE v.document_id = $1 ORDER BY v.version_no DESC`,
      [doc.id]
    );
    await audit.record(audit.fromReq(req, { action: 'view', documentId: doc.id }));
    res.json({
      document: publicDoc(doc, level),
      versions: versions.rows.map((v) => ({
        version: v.version_no, filename: v.filename, mimeType: v.mime_type, size: v.size_bytes,
        sha256: v.sha256, createdAt: v.created_at, uploadedBy: v.uploaded_by_name,
      })),
      can: { edit: authz.canEdit(level), manage: authz.canManage(level) },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/:id  - change title / category / description (edit)
// ---------------------------------------------------------------------------
const patchSchema = metaSchema.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to change');

router.patch('/:id', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'edit', action: 'update_details' });
    if (!access) return;
    const parsed = patchSchema.safeParse(req.body || {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
    const changes = {};
    for (const key of ['title', 'category', 'description']) {
      if (parsed.data[key] !== undefined && parsed.data[key] !== access.doc[key]) {
        changes[key] = { from: access.doc[key], to: parsed.data[key] };
      }
    }
    if (Object.keys(changes).length === 0) return res.json({ ok: true, changed: [] });
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE documents SET title = COALESCE($2, title), category = COALESCE($3, category),
                description = COALESCE($4, description), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [access.doc.id, parsed.data.title ?? null, parsed.data.category ?? null, parsed.data.description ?? null]
      );
      await audit.record(audit.fromReq(req, { action: 'update_details', documentId: access.doc.id, details: { changes } }), client);
    });
    res.json({ ok: true, changed: Object.keys(changes) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/documents/:id/versions  - upload a new version (edit)
// Permission is checked BEFORE the file body is read.
// ---------------------------------------------------------------------------
router.post('/:id/versions', async (req, res, next) => {
  let access;
  try {
    access = await documentAccess(req, res, { need: 'edit', action: 'new_version' });
    if (!access) return;
    await runUpload(req, res);
    const file = await validateUpload(req.file);
    const version = await withTransaction(async (client) => {
      // Lock the document row so two uploads cannot take the same version number,
      // and re-check it was not deleted in the meantime.
      const d = await client.query('SELECT current_version FROM documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [access.doc.id]);
      if (!d.rows[0]) throw new HttpError(404, 'Document not found');
      const next = d.rows[0].current_version + 1;
      await client.query(
        `INSERT INTO document_versions (document_id, version_no, filename, mime_type, size_bytes, sha256, content, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [access.doc.id, next, file.filename, file.mimeType, file.size, file.sha256, file.content, req.user.id]
      );
      await client.query('UPDATE documents SET current_version = $2, updated_at = now() WHERE id = $1', [access.doc.id, next]);
      await audit.record(audit.fromReq(req, {
        action: 'new_version', documentId: access.doc.id,
        details: { version: next, filename: file.filename, size: file.size, sha256: file.sha256 },
      }), client);
      return next;
    });
    res.status(201).json({ version });
  } catch (err) {
    if (access && (err instanceof HttpError || (err && err.name === 'MulterError'))) {
      await audit.record(audit.fromReq(req, {
        action: 'new_version', outcome: 'denied', documentId: access.doc.id,
        details: { reason: 'validation', message: err.message.slice(0, 200) },
      })).catch(() => {});
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/documents/:id/download?version=N  (read)
//
// THE AUTHORISATION DECISION FOR A DOWNLOAD IS THE `documentAccess(...)` CALL
// BELOW (server/src/guards.js -> server/src/authz.js). It runs on every request,
// reads the grant from the database at that moment, and nothing is sent unless
// it returns access. Remove it and any signed-in user could download any file
// by id: the tests in server/test/isolation.test.js fail if that happens.
// ---------------------------------------------------------------------------
router.get('/:id/download', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'read', action: 'download' });
    if (!access) return;
    let versionNo = access.doc.current_version;
    if (req.query.version !== undefined) {
      versionNo = Number(req.query.version);
      if (!Number.isInteger(versionNo) || versionNo < 1 || versionNo > 100000) throw new HttpError(400, 'Invalid version');
    }
    const { rows } = await pool.query(
      `SELECT filename, mime_type, size_bytes, sha256, content FROM document_versions
        WHERE document_id = $1 AND version_no = $2`,
      [access.doc.id, versionNo]
    );
    const v = rows[0];
    if (!v) throw new HttpError(404, 'Version not found');
    // Record the download BEFORE sending. If the audit write fails, nothing is sent.
    await audit.record(audit.fromReq(req, {
      action: 'download', documentId: access.doc.id,
      details: { version: versionNo, filename: v.filename, sha256: v.sha256 },
    }));
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(v.filename),
      'Content-Length': String(v.content.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.end(v.content);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id  - move to trash (document owner)
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'manage', action: 'delete' });
    if (!access) return;
    await withTransaction(async (client) => {
      await client.query('UPDATE documents SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL', [access.doc.id, req.user.id]);
      await audit.record(audit.fromReq(req, { action: 'delete', documentId: access.doc.id, details: { title: access.doc.title } }), client);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/:id/restore  (document owner, document must be in trash)
router.post('/:id/restore', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'manage', action: 'restore', trashed: true });
    if (!access) return;
    await withTransaction(async (client) => {
      await client.query('UPDATE documents SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1', [access.doc.id]);
      await audit.record(audit.fromReq(req, { action: 'restore', documentId: access.doc.id, details: { title: access.doc.title } }), client);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sharing (document owner only)
// ---------------------------------------------------------------------------
router.get('/:id/grants', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'manage', action: 'list_grants' });
    if (!access) return;
    const { rows } = await pool.query(
      `SELECT g.user_id, g.permission, g.created_at, u.name, u.email, u.is_active, gb.name AS granted_by_name
         FROM grants g JOIN users u ON u.id = g.user_id JOIN users gb ON gb.id = g.granted_by
        WHERE g.document_id = $1 ORDER BY u.name`,
      [access.doc.id]
    );
    res.json({
      grants: rows.map((r) => ({
        userId: r.user_id, name: r.name, email: r.email, permission: r.permission,
        active: r.is_active, grantedAt: r.created_at, grantedBy: r.granted_by_name,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const grantSchema = z.object({ permission: z.enum(['read', 'edit']) });

router.put('/:id/grants/:userId', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'manage', action: 'grant' });
    if (!access) return;
    const parsed = grantSchema.safeParse(req.body || {});
    if (!parsed.success) throw new HttpError(400, 'Permission must be "read" or "edit"');
    const targetId = req.params.userId;
    let target = null;
    if (isUuid(targetId)) {
      const t = await pool.query('SELECT id, email, name, role, is_active FROM users WHERE id = $1', [targetId]);
      target = t.rows[0] || null;
    }
    if (!authz.canReceiveGrant(target, access.doc.owner_id)) {
      await audit.record(audit.fromReq(req, {
        action: 'grant', outcome: 'denied', documentId: access.doc.id, targetUserId: target ? target.id : null,
        details: { reason: 'invalid_recipient', permission: parsed.data.permission },
      }));
      throw new HttpError(400, 'This person cannot be given access');
    }
    const result = await withTransaction(async (client) => {
      const prev = await client.query('SELECT permission FROM grants WHERE document_id = $1 AND user_id = $2 FOR UPDATE', [access.doc.id, target.id]);
      const before = prev.rows[0] ? prev.rows[0].permission : null;
      if (before === parsed.data.permission) return { changed: false };
      await client.query(
        `INSERT INTO grants (document_id, user_id, permission, granted_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (document_id, user_id) DO UPDATE SET permission = EXCLUDED.permission,
           granted_by = EXCLUDED.granted_by, created_at = now()`,
        [access.doc.id, target.id, parsed.data.permission, req.user.id]
      );
      await audit.record(audit.fromReq(req, {
        action: before ? 'grant_change' : 'grant', documentId: access.doc.id, targetUserId: target.id,
        details: { email: target.email, from: before, to: parsed.data.permission },
      }), client);
      return { changed: true };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/grants/:userId', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'manage', action: 'revoke' });
    if (!access) return;
    if (!isUuid(req.params.userId)) throw new HttpError(404, 'That person does not have access');
    const removed = await withTransaction(async (client) => {
      const del = await client.query(
        `DELETE FROM grants g USING users u
          WHERE g.document_id = $1 AND g.user_id = $2 AND u.id = g.user_id
        RETURNING g.permission, u.email`,
        [access.doc.id, req.params.userId]
      );
      if (!del.rows[0]) return null;
      await audit.record(audit.fromReq(req, {
        action: 'revoke', documentId: access.doc.id, targetUserId: req.params.userId,
        details: { email: del.rows[0].email, permission: del.rows[0].permission },
      }), client);
      return del.rows[0];
    });
    if (!removed) throw new HttpError(404, 'That person does not have access');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/:id/activity - who did what to this document (document owner)
router.get('/:id/activity', async (req, res, next) => {
  try {
    const access = await documentAccess(req, res, { need: 'manage', action: 'view_activity' });
    if (!access) return;
    const { rows } = await pool.query(
      `SELECT seq, occurred_at, actor_email, action, outcome, target_user_id, details
         FROM audit_log WHERE document_id = $1 ORDER BY seq DESC LIMIT 300`,
      [access.doc.id]
    );
    res.json({
      events: rows.map((r) => ({
        seq: Number(r.seq), at: r.occurred_at, actor: r.actor_email, action: r.action,
        outcome: r.outcome, details: r.details,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
