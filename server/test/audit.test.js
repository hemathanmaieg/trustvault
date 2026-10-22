'use strict';
// Rule two: we can prove who reached a document, including refused attempts,
// and the record cannot be quietly altered.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../src/audit');

let w;
before(async () => { w = await h.standardWorld(); });
after(async () => { await h.pool.end(); });

const last = async (action, extra = 'TRUE', params = []) => {
  const rows = await h.auditRows(`action = $1 AND ${extra}`, [action, ...params]);
  return rows[rows.length - 1];
};

describe('T21 every required event is recorded with who, what and when', () => {
  it('upload', async () => {
    const e = await last('upload', 'document_id = $2', [w.aliceDoc]);
    assert.equal(e.actor_email, 'alice@test.local');
    assert.equal(e.outcome, 'allowed');
    assert.match(e.details.sha256, /^[0-9a-f]{64}$/);
    assert.ok(e.occurred_at instanceof Date);
  });
  it('download, with the exact version and file hash', async () => {
    await w.as.vic.get(`/api/documents/${w.aliceDoc}/download`);
    const e = await last('download', 'document_id = $2 AND outcome = $3', [w.aliceDoc, 'allowed']);
    assert.equal(e.actor_email, 'vic@test.local');
    assert.equal(e.details.version, 1);
    assert.match(e.details.sha256, /^[0-9a-f]{64}$/);
  });
  it('changes to details record old and new values', async () => {
    await w.as.bob.patch(`/api/documents/${w.aliceDoc}`).send({ title: 'Renamed letter' });
    const e = await last('update_details', 'document_id = $2', [w.aliceDoc]);
    assert.equal(e.actor_email, 'bob@test.local');
    assert.deepEqual(e.details.changes.title, { from: 'Alice salary letter', to: 'Renamed letter' });
  });
  it('new versions', async () => {
    await w.as.bob.post(`/api/documents/${w.aliceDoc}/versions`).attach('file', h.makePdf('v2'), 'v2.pdf');
    const e = await last('new_version', 'document_id = $2', [w.aliceDoc]);
    assert.equal(e.details.version, 2);
  });
  it('grants, permission changes and revocations, with the person affected', async () => {
    await h.grant(w.as.alice, w.aliceDoc, w.users.eve.id, 'read');
    await h.grant(w.as.alice, w.aliceDoc, w.users.eve.id, 'edit');
    await w.as.alice.delete(`/api/documents/${w.aliceDoc}/grants/${w.users.eve.id}`);
    const g = await last('grant', 'target_user_id = $2', [w.users.eve.id]);
    const c = await last('grant_change', 'target_user_id = $2', [w.users.eve.id]);
    const r = await last('revoke', 'target_user_id = $2', [w.users.eve.id]);
    assert.equal(g.details.to, 'read');
    assert.deepEqual([c.details.from, c.details.to], ['read', 'edit']);
    assert.equal(r.details.permission, 'edit');
    assert.ok(g.seq < c.seq && c.seq < r.seq);
  });
  it('deletion and restore', async () => {
    const doc = await h.upload(w.as.bob, { title: 'Delete me' });
    await w.as.bob.delete(`/api/documents/${doc}`);
    await w.as.bob.post(`/api/documents/${doc}/restore`);
    assert.ok(await last('delete', 'document_id = $2', [doc]));
    assert.ok(await last('restore', 'document_id = $2', [doc]));
  });
  it('a failed write does not leave a false "allowed" entry', async () => {
    const before = await h.auditRows("action = 'upload' AND outcome = 'allowed'");
    await w.as.alice.post('/api/documents').attach('file', h.makeText('not a pdf'), 'fake.pdf');
    const afterRows = await h.auditRows("action = 'upload' AND outcome = 'allowed'");
    assert.equal(afterRows.length, before.length);
  });
});

describe('T20 refused attempts are recorded too', () => {
  it('a refused download by a signed-in user', async () => {
    await w.as.eve.get(`/api/documents/${w.bobDoc}/download`);
    const e = await last('download', 'document_id = $2 AND outcome = $3', [w.bobDoc, 'denied']);
    assert.equal(e.actor_email, 'eve@test.local');
    assert.equal(e.details.reason, 'no_permission');
  });
  it('a probe for a document id that does not exist', async () => {
    await w.as.eve.get(`/api/documents/${h.NOT_A_DOC}/download`);
    const e = await last('download', 'document_id = $2', [h.NOT_A_DOC]);
    assert.equal(e.outcome, 'denied');
    assert.equal(e.details.reason, 'not_found');
  });
  it('a malformed id keeps what was tried', async () => {
    await w.as.eve.get('/api/documents/..%2F..%2Fetc%2Fpasswd/download');
    const e = await last('download', "outcome = 'denied' AND details ? 'requested_id'");
    assert.match(e.details.requested_id, /etc/);
  });
  it('an anonymous attempt, with its address', async () => {
    await h.request(h.app).get(`/api/documents/${w.aliceDoc}/download`);
    const e = await last('unauthenticated_request', 'document_id = $2', [w.aliceDoc]);
    assert.equal(e.outcome, 'denied');
    assert.ok(e.ip);
  });
  it('refused grant, edit and delete attempts', async () => {
    await w.as.vic.put(`/api/documents/${w.aliceDoc}/grants/${w.users.eve.id}`).send({ permission: 'read' });
    await w.as.vic.patch(`/api/documents/${w.aliceDoc}`).send({ title: 'x' });
    await w.as.vic.delete(`/api/documents/${w.aliceDoc}`);
    for (const action of ['grant', 'update_details', 'delete']) {
      const e = await last(action, "actor_email = 'vic@test.local'");
      assert.equal(e.outcome, 'denied', action);
    }
  });
  it('role violations (viewer uploading, owner calling admin)', async () => {
    await w.as.vic.post('/api/documents').attach('file', h.makePdf('x'), 'x.pdf');
    await w.as.alice.get('/api/admin/audit');
    assert.equal((await last('upload', "actor_email = 'vic@test.local'")).outcome, 'denied');
    assert.equal((await last('admin_access', "actor_email = 'alice@test.local'")).outcome, 'denied');
  });
  it('failed sign-ins', async () => {
    await h.client().post('/api/auth/login').send({ email: 'eve@test.local', password: 'wrong-password-1' });
    const e = await last('login', "outcome = 'denied' AND details->>'email' = 'eve@test.local'");
    assert.equal(e.details.reason, 'wrong_password');
  });
  it('the owner sees refused attempts on their document in its activity', async () => {
    const r = await w.as.bob.get(`/api/documents/${w.bobDoc}/activity`);
    assert.ok(r.body.events.some((e) => e.outcome === 'denied' && e.actor === 'eve@test.local'));
  });
});

describe('T19 the audit trail cannot be quietly altered', () => {
  it('the chain verifies when nothing was touched', async () => {
    const r = await audit.verifyChain(h.pool);
    assert.equal(r.ok, true, r.problem);
    assert.ok(r.checked > 10);
  });
  it('the database refuses UPDATE on audit rows', async () => {
    await assert.rejects(h.pool.query("UPDATE audit_log SET actor_email = 'nobody' WHERE seq = 1"), /append-only/);
  });
  it('the database refuses DELETE on audit rows', async () => {
    await assert.rejects(h.pool.query('DELETE FROM audit_log WHERE seq = 1'), /append-only/);
  });
  it('the database refuses TRUNCATE', async () => {
    await assert.rejects(h.pool.query('TRUNCATE audit_log'), /append-only/);
  });

  // The next tests simulate an attacker who CAN bypass the triggers (for example
  // the database owner) and show the hash chain still exposes the change.
  async function asSuperAttacker(sql, params) {
    const c = await h.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      await c.query(sql, params);
      await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }

  it('an edited entry is detected, and the report says which one', async () => {
    const e = await last('download', "outcome = 'allowed' AND actor_email = 'vic@test.local'");
    await asSuperAttacker("UPDATE audit_log SET actor_email = 'someone-else@test.local' WHERE seq = $1", [e.seq]);
    const r = await audit.verifyChain(h.pool);
    assert.equal(r.ok, false);
    assert.match(r.problem, new RegExp(`#${e.seq}`));
    await asSuperAttacker("UPDATE audit_log SET actor_email = 'vic@test.local' WHERE seq = $1", [e.seq]);
    assert.equal((await audit.verifyChain(h.pool)).ok, true);
  });
  it('a deleted entry is detected', async () => {
    const tmp = await h.pool.query('SELECT * FROM audit_log WHERE seq = 5');
    await asSuperAttacker('DELETE FROM audit_log WHERE seq = 5');
    const r = await audit.verifyChain(h.pool);
    assert.equal(r.ok, false);
    assert.match(r.problem, /Missing entry|does not link/);
    // put it back exactly as it was
    const row = tmp.rows[0];
    await asSuperAttacker(
      `INSERT INTO audit_log (seq, occurred_at, actor_id, actor_email, action, outcome, document_id, target_user_id, details, ip, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.seq, row.occurred_at, row.actor_id, row.actor_email, row.action, row.outcome, row.document_id, row.target_user_id, row.details, row.ip, row.prev_hash, row.hash]
    );
    assert.equal((await audit.verifyChain(h.pool)).ok, true);
  });
  it('rewriting an entry AND recomputing hashes fails without the secret key', async () => {
    const { rows } = await h.pool.query('SELECT * FROM audit_log ORDER BY seq');
    // Attacker rewrites row 3 and recomputes every following hash with a guessed key.
    let prev = rows[1].hash;
    const forged = [];
    for (const row of rows.slice(2)) {
      const r = { ...row, actor_email: row.seq === rows[2].seq ? 'forged@test.local' : row.actor_email };
      const hash = audit.computeHash(prev, r, 'guessed-key');
      forged.push({ seq: r.seq, email: r.actor_email, prev, hash });
      prev = hash;
    }
    const c = await h.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      for (const f of forged) {
        await c.query('UPDATE audit_log SET actor_email = $2, prev_hash = $3, hash = $4 WHERE seq = $1', [f.seq, f.email, f.prev, f.hash]);
      }
      const r = await audit.verifyChain(c);
      assert.equal(r.ok, false);
      await c.query('ROLLBACK'); // undo the forgery
    } finally {
      c.release();
    }
    assert.equal((await audit.verifyChain(h.pool)).ok, true);
  });
  it('admins can run the check from the API, and running it is itself logged', async () => {
    const r = await w.as.admin.get('/api/admin/audit/verify');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const e = await last('audit_verify');
    assert.equal(e.actor_email, 'admin@test.local');
  });
  it('there is no API that edits or deletes audit entries', async () => {
    for (const method of ['delete', 'patch', 'put', 'post']) {
      const r = await w.as.admin[method]('/api/admin/audit');
      assert.equal(r.status, 404, method);
    }
  });
});

describe('T24 the administrator\'s view', () => {
  it('admin can filter the log by outcome and person', async () => {
    const r = await w.as.admin.get('/api/admin/audit?outcome=denied&actor=eve');
    assert.equal(r.status, 200);
    assert.ok(r.body.events.length > 0);
    assert.ok(r.body.events.every((e) => e.outcome === 'denied' && e.actor === 'eve@test.local'));
  });
  it('alerts flag someone retrying after their access was revoked', async () => {
    await w.as.vic.get(`/api/documents/${w.aliceDoc}/download`);
    await w.as.alice.delete(`/api/documents/${w.aliceDoc}/grants/${w.users.vic.id}`);
    await w.as.vic.get(`/api/documents/${w.aliceDoc}/download`);
    const r = await w.as.admin.get('/api/admin/alerts');
    assert.ok(r.body.attemptsAfterRevoke.some((a) => a.who === 'vic@test.local' && a.document_id === w.aliceDoc));
  });
  it('alerts flag repeated refusals', async () => {
    for (let i = 0; i < 5; i += 1) await w.as.eve.get(`/api/documents/${w.bobDoc}`);
    const r = await w.as.admin.get('/api/admin/alerts');
    assert.ok(r.body.repeatedDenials.some((a) => a.who === 'eve@test.local' && a.denied >= 5));
  });
});
