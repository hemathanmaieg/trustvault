'use strict';
const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { requireDirectory } = require('../guards');
const { HttpError } = require('../errors');

const router = express.Router();

// GET /api/users/directory?q=  - people an owner can share with.
// Only active owners/viewers, never admins, never the caller. Max 20 results.
router.get('/directory', requireDirectory, async (req, res, next) => {
  try {
    const parsed = z.object({ q: z.string().trim().max(100).optional() }).safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'Invalid search');
    const q = parsed.data.q ? `%${parsed.data.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : '%';
    const { rows } = await pool.query(
      `SELECT id, name, email, role FROM users
        WHERE is_active AND role <> 'admin' AND id <> $1
          AND (name ILIKE $2 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\')
        ORDER BY name LIMIT 20`,
      [req.user.id, q]
    );
    res.json({ users: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
