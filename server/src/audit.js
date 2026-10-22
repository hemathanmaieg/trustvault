'use strict';
// Tamper-evident audit log.
//
// Every row stores:  hash = HMAC-SHA256(AUDIT_HMAC_KEY, prev_hash + canonical(row))
// * Changing or deleting any row breaks every hash after it.
// * The key lives in the app's environment, not the database, so someone who
//   can only reach the database cannot recompute a valid chain.
// * Database triggers reject UPDATE / DELETE / TRUNCATE on audit_log.
// * `seq` is assigned under an advisory lock, so it has no gaps; a missing
//   number means a row was removed.
// * Each new head hash is also printed to the application log (stdout), which
//   is stored by the host, outside the database. Deleting the newest rows
//   (where no later row exists to break) can be detected by comparing the
//   database head with the last head printed there.
const crypto = require('crypto');
const config = require('./config');
const { pool } = require('./db');

const GENESIS = '0'.repeat(64);
const AUDIT_LOCK_ID = 727274; // arbitrary constant for pg_advisory_xact_lock

function canonical(row) {
  // Fixed field order so the same row always hashes the same way.
  return JSON.stringify([
    String(row.seq),
    new Date(row.occurred_at).toISOString(),
    row.actor_id || null,
    row.actor_email || null,
    row.action,
    row.outcome,
    row.document_id || null,
    row.target_user_id || null,
    row.details || {},
    row.ip || null,
  ]);
}

function computeHash(prevHash, row, key = config.auditHmacKey) {
  return crypto.createHmac('sha256', key).update(prevHash + canonical(row)).digest('hex');
}

// Stable JSON for `details` so key order never changes the hash after a round trip
// through Postgres jsonb (which reorders keys).
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Append one event. Pass `client` to write inside an existing transaction
 * (so the action and its audit row commit or fail together).
 */
async function record(event, client = null) {
  const run = async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_ID]);
    const last = await db.query('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    const prevHash = last.rows[0] ? last.rows[0].hash : GENESIS;
    const seq = last.rows[0] ? Number(last.rows[0].seq) + 1 : 1;
    const row = {
      seq,
      occurred_at: new Date(),
      actor_id: event.actorId || null,
      actor_email: event.actorEmail || null,
      action: event.action,
      outcome: event.outcome || 'allowed',
      document_id: event.documentId || null,
      target_user_id: event.targetUserId || null,
      details: sortKeys(event.details || {}),
      ip: event.ip || null,
    };
    const hash = computeHash(prevHash, row);
    await db.query(
      `INSERT INTO audit_log (seq, occurred_at, actor_id, actor_email, action, outcome,
         document_id, target_user_id, details, ip, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.seq, row.occurred_at, row.actor_id, row.actor_email, row.action, row.outcome,
        row.document_id, row.target_user_id, JSON.stringify(row.details), row.ip, prevHash, hash,
      ]
    );
    if (!config.isTest) {
      // Off-database anchor of the chain head (see header comment).
      console.log(`[audit-anchor] seq=${seq} hash=${hash}`);
    }
    return { seq, hash };
  };

  if (client) return run(client);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await run(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Build an event from the request so routes stay short. */
function fromReq(req, fields) {
  return {
    actorId: req.user ? req.user.id : null,
    actorEmail: req.user ? req.user.email : null,
    ip: req.ip,
    ...fields,
  };
}

/**
 * Walk the whole chain and report the first problem, if any.
 * Returns { ok, checked, headSeq, headHash, problem? }.
 */
async function verifyChain(db = pool, key = config.auditHmacKey) {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY seq ASC');
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (seq !== expectedSeq) {
      return { ok: false, checked: expectedSeq - 1, problem: `Missing entry: expected #${expectedSeq}, found #${seq}` };
    }
    if (row.prev_hash !== prev) {
      return { ok: false, checked: seq - 1, problem: `Entry #${seq} does not link to the entry before it` };
    }
    const expected = computeHash(prev, { ...row, details: sortKeys(row.details) }, key);
    if (expected !== row.hash) {
      return { ok: false, checked: seq - 1, problem: `Entry #${seq} was altered after it was written` };
    }
    prev = row.hash;
    expectedSeq += 1;
  }
  return {
    ok: true,
    checked: rows.length,
    headSeq: rows.length ? Number(rows[rows.length - 1].seq) : 0,
    headHash: prev,
  };
}

module.exports = { record, fromReq, verifyChain, computeHash, GENESIS };
