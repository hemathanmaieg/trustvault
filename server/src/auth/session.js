'use strict';
// Server-side sessions.
// The cookie holds a random 256-bit token. The database stores only its SHA-256,
// so a database leak does not hand out working sessions.
// Every request re-reads the session AND the user row, so disabling a user or
// changing their role takes effect on their very next request.
const crypto = require('crypto');
const config = require('../config');
const { pool } = require('../db');
const authz = require('../authz');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cookieOptions() {
  return {
    httpOnly: true, // not readable by page scripts
    secure: config.isProd, // HTTPS only in production (required by the __Host- prefix)
    sameSite: 'strict', // never sent on cross-site requests
    path: '/',
    maxAge: config.session.absoluteHours * 3600 * 1000,
  };
}

async function createSession(res, user, req, db = pool) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
    [hashToken(token), user.id, config.session.absoluteHours, req.ip, String(req.get('user-agent') || '').slice(0, 300)]
  );
  res.cookie(config.session.cookieName, token, cookieOptions());
}

function clearCookie(res) {
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(config.session.cookieName, opts);
}

/** Middleware: sets req.user (or null) from the session cookie. */
async function loadSession(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[config.session.cookieName];
  if (!token || typeof token !== 'string' || token.length > 100) return next();
  try {
    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      `SELECT s.token_hash, s.expires_at, s.last_seen_at,
              s.last_seen_at + make_interval(mins => $2) AS idle_expires_at,
              u.id, u.email, u.name, u.role, u.is_active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash, config.session.idleMinutes]
    );
    const row = rows[0];
    if (!authz.isSessionUsable(row)) {
      if (row) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      clearCookie(res);
      return next();
    }
    req.user = { id: row.id, email: row.email, name: row.name, role: row.role, is_active: row.is_active };
    req.sessionTokenHash = tokenHash;
    // Slide the idle timeout, at most once a minute to limit writes.
    if (Date.now() - new Date(row.last_seen_at).getTime() > 60 * 1000) {
      await pool.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash]);
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/** End every session a user has (used when they are disabled, re-roled or change password). */
async function endAllSessions(userId, db = pool, exceptTokenHash = null) {
  if (exceptTokenHash) {
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, exceptTokenHash]);
  } else {
    await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }
}

module.exports = { createSession, loadSession, clearCookie, endAllSessions, hashToken };
