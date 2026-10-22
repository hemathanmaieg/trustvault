'use strict';
// Rule three: taking access away works immediately, for anything issued before.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

let w;
before(async () => { w = await h.standardWorld(); });
after(async () => { await h.pool.end(); });

describe('T03 revoking a grant works on the very next request', () => {
  it('a reader in the middle of a session loses access the moment it is revoked', async () => {
    assert.equal((await w.as.vic.get(`/api/documents/${w.aliceDoc}/download`)).status, 200);
    assert.equal((await w.as.alice.delete(`/api/documents/${w.aliceDoc}/grants/${w.users.vic.id}`)).status, 200);
    // Same signed-in session, no new login:
    assert.equal((await w.as.vic.get(`/api/documents/${w.aliceDoc}/download`)).status, 404);
    assert.equal((await w.as.vic.get(`/api/documents/${w.aliceDoc}`)).status, 404);
    const list = await w.as.vic.get('/api/documents');
    assert.deepEqual(list.body.documents, []);
  });
  it('downgrading edit to read removes editing at once', async () => {
    await h.grant(w.as.alice, w.aliceDoc, w.users.bob.id, 'read');
    assert.equal((await w.as.bob.patch(`/api/documents/${w.aliceDoc}`).send({ title: 'nope' })).status, 404);
    assert.equal((await w.as.bob.get(`/api/documents/${w.aliceDoc}/download`)).status, 200);
  });
  it('deleting a document cuts off every grantee at once', async () => {
    const doc = await h.upload(w.as.alice, { title: 'Short lived' });
    await h.grant(w.as.alice, doc, w.users.eve.id, 'read');
    assert.equal((await w.as.eve.get(`/api/documents/${doc}/download`)).status, 200);
    await w.as.alice.delete(`/api/documents/${doc}`);
    assert.equal((await w.as.eve.get(`/api/documents/${doc}/download`)).status, 404);
  });
});

describe('T04 disabling a person ends everything they hold', () => {
  it('a disabled user\'s open session stops working immediately', async () => {
    const u = await h.createUser('viewer');
    const c = await h.signIn(u);
    await h.grant(w.as.alice, w.aliceDoc, u.id, 'read');
    assert.equal((await c.get(`/api/documents/${w.aliceDoc}/download`)).status, 200);
    const r = await w.as.admin.patch(`/api/admin/users/${u.id}`).send({ active: false });
    assert.equal(r.status, 200);
    assert.equal((await c.get(`/api/documents/${w.aliceDoc}/download`)).status, 401);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
  it('a disabled user cannot sign in again', async () => {
    const u = await h.createUser('viewer', { active: false });
    const r = await h.client().post('/api/auth/login').send({ email: u.email, password: h.PASSWORD });
    assert.equal(r.status, 401);
  });
  it('even if session rows survived, an inactive account is refused on every request', async () => {
    const u = await h.createUser('viewer');
    const c = await h.signIn(u);
    // Flip the flag directly in the database, leaving the session row in place.
    await h.pool.query('UPDATE users SET is_active = false WHERE id = $1', [u.id]);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
});

describe('T05 a role change applies at once', () => {
  it('demoting an owner to viewer ends their session and blocks uploads', async () => {
    const u = await h.createUser('owner');
    const c = await h.signIn(u);
    assert.equal((await w.as.admin.patch(`/api/admin/users/${u.id}`).send({ role: 'viewer' })).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    const again = await h.signIn(u);
    const r = await again.post('/api/documents').attach('file', h.makePdf('x'), 'x.pdf');
    assert.equal(r.status, 403);
  });
  it('promoting someone to admin removes their document grants', async () => {
    const u = await h.createUser('viewer');
    await h.grant(w.as.alice, w.aliceDoc, u.id, 'read');
    await w.as.admin.patch(`/api/admin/users/${u.id}`).send({ role: 'admin' });
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM grants WHERE user_id = $1', [u.id]);
    assert.equal(rows[0].n, 0);
  });
});

describe('T06 sessions expire', () => {
  it('a session past its absolute lifetime is refused and removed', async () => {
    const u = await h.createUser('viewer');
    const c = await h.signIn(u);
    await h.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u.id]);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id]);
    assert.equal(rows[0].n, 0);
  });
  it('a session idle for longer than the idle limit is refused', async () => {
    const u = await h.createUser('viewer');
    const c = await h.signIn(u);
    await h.pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1", [u.id]);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
  it('signing out ends the session on the server, not just in the browser', async () => {
    const u = await h.createUser('viewer');
    const c = await h.signIn(u);
    const cookie = c.agent.jar.getCookie('tv_session', { path: '/', domain: '127.0.0.1', secure: false, script: false });
    assert.ok(cookie && cookie.value, 'test needs the real cookie value');
    // The cookie works before logout...
    const before = await h.request(h.app).get('/api/auth/me').set('Cookie', `tv_session=${cookie.value}`);
    assert.equal(before.status, 200);
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    // Replay the old cookie value after logout:
    const replay = await h.request(h.app).get('/api/auth/me').set('Cookie', `tv_session=${cookie.value}`);
    assert.equal(replay.status, 401);
  });
});

describe('T26 password changes and resets end other sessions', () => {
  it('changing your password signs out your other devices', async () => {
    const u = await h.createUser('viewer');
    const laptop = await h.signIn(u);
    const phone = await h.signIn(u);
    const r = await laptop.post('/api/auth/password').send({ currentPassword: h.PASSWORD, newPassword: 'BrandNewPass2026' });
    assert.equal(r.status, 200);
    assert.equal((await laptop.get('/api/auth/me')).status, 200);
    assert.equal((await phone.get('/api/auth/me')).status, 401);
  });
  it('an admin password reset signs the user out everywhere', async () => {
    const u = await h.createUser('viewer');
    const c = await h.signIn(u);
    assert.equal((await w.as.admin.post(`/api/admin/users/${u.id}/password`).send({ password: 'ResetByAdmin2026' })).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
});

describe('T25 stolen database rows do not give working sessions', () => {
  it('the sessions table stores a hash, never the cookie value', async () => {
    const u = await h.createUser('viewer');
    const c = await h.signIn(u);
    const cookie = c.agent.jar.getCookie('tv_session', { path: '/', domain: '127.0.0.1', secure: false, script: false });
    assert.ok(cookie && cookie.value.length >= 40);
    const { rows } = await h.pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [u.id]);
    assert.notEqual(rows[0].token_hash, cookie.value);
    const asCookie = await h.request(h.app).get('/api/auth/me').set('Cookie', `tv_session=${rows[0].token_hash}`);
    assert.equal(asCookie.status, 401);
  });
  it('the authz rule on its own refuses expired, idle and inactive sessions', () => {
    const authz = require('../src/authz');
    const future = new Date(Date.now() + 60000);
    const past = new Date(Date.now() - 60000);
    assert.equal(authz.isSessionUsable({ is_active: true, expires_at: future, idle_expires_at: future }), true);
    assert.equal(authz.isSessionUsable({ is_active: false, expires_at: future, idle_expires_at: future }), false);
    assert.equal(authz.isSessionUsable({ is_active: true, expires_at: past, idle_expires_at: future }), false);
    assert.equal(authz.isSessionUsable({ is_active: true, expires_at: future, idle_expires_at: past }), false);
    assert.equal(authz.isSessionUsable(null), false);
  });
});
