'use strict';
const express = require('express');
const { z } = require('zod');
const { limiter } = require('../ratelimit');
const config = require('../config');
const { pool, withTransaction } = require('../db');
const authz = require('../authz');
const audit = require('../audit');
const { createSession, clearCookie, endAllSessions } = require('../auth/session');
const { verifyPassword, hashPassword, validatePasswordStrength } = require('../auth/passwords');
const { requireAuth } = require('../guards');
const { HttpError } = require('../errors');

const router = express.Router();

// Failed sign-ins per address (successful ones do not count, so a team behind
// one office network does not lock itself out).
const loginLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimit.loginPer15Min,
  skipSuccessfulRequests: true,
  action: 'login',
  message: 'Too many failed sign-ins from this address. Try again in 15 minutes.',
});

const loginSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
});

const GENERIC_LOGIN_ERROR = 'Email or password is incorrect, or the account is locked';

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Email and password are required');
    const { email, password } = parsed.data;

    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    const user = rows[0] || null;
    const allowedToTry = authz.canAttemptLogin(user);
    // Always run bcrypt so timing does not reveal whether the email exists.
    const passwordOk = await verifyPassword(password, user ? user.password_hash : null);

    if (!user || !allowedToTry || !passwordOk) {
      if (user && allowedToTry && !passwordOk) {
        // Atomic increment: parallel guesses cannot each read the same old count.
        const upd = await pool.query(
          `UPDATE users
              SET locked_until = CASE WHEN failed_logins + 1 >= $2
                                      THEN now() + make_interval(mins => $3) ELSE locked_until END,
                  failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
            WHERE id = $1
        RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
          [user.id, config.login.maxFailures, config.login.lockMinutes]
        );
        if (upd.rows[0] && upd.rows[0].locked) {
          await audit.record(audit.fromReq(req, {
            action: 'account_locked', outcome: 'denied', targetUserId: user.id,
            details: { failures: config.login.maxFailures, minutes: config.login.lockMinutes },
          }));
        }
      }
      await audit.record(audit.fromReq(req, {
        action: 'login',
        outcome: 'denied',
        targetUserId: user ? user.id : null,
        details: {
          email: email.slice(0, 200),
          reason: !user ? 'unknown_email' : !user.is_active ? 'disabled' : !allowedToTry ? 'locked' : 'wrong_password',
        },
      }));
      throw new HttpError(401, GENERIC_LOGIN_ERROR);
    }

    // Success: fresh session token (prevents session fixation), reset counters.
    await withTransaction(async (client) => {
      await client.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
      await createSession(res, user, req, client);
      await audit.record({ actorId: user.id, actorEmail: user.email, ip: req.ip, action: 'login', outcome: 'allowed' }, client);
    });
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    if (req.user && req.sessionTokenHash) {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionTokenHash]);
      await audit.record(audit.fromReq(req, { action: 'logout' }));
    }
    clearCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  const { id, email, name, role } = req.user;
  res.json({ user: { id, email, name, role } });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Current and new password are required');
    const { currentPassword, newPassword } = parsed.data;
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(currentPassword, rows[0] && rows[0].password_hash))) {
      await audit.record(audit.fromReq(req, { action: 'password_change', outcome: 'denied', details: { reason: 'wrong_current_password' } }));
      throw new HttpError(400, 'Current password is incorrect');
    }
    const weak = validatePasswordStrength(newPassword);
    if (weak) throw new HttpError(400, weak);
    const hash = await hashPassword(newPassword);
    await withTransaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user.id, hash]);
      // Sign out every OTHER device.
      await endAllSessions(req.user.id, client, req.sessionTokenHash);
      await audit.record(audit.fromReq(req, { action: 'password_change' }), client);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
