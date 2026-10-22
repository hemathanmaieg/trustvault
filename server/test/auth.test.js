'use strict';
// Sign-in, password guessing, cross-site requests and security headers.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

let w;
before(async () => { w = await h.standardWorld(); });
after(async () => { await h.pool.end(); });

const login = (email, password) => h.client().post('/api/auth/login').send({ email, password });

describe('T18 password guessing', () => {
  it('wrong password and unknown email give the same message', async () => {
    const a = await login('alice@test.local', 'WrongPassword1');
    const b = await login('nobody@test.local', 'WrongPassword1');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(a.body, b.body);
  });
  it('the account locks after 5 wrong passwords, even for the right password', async () => {
    const u = await h.createUser('viewer');
    for (let i = 0; i < 5; i += 1) assert.equal((await login(u.email, `Wrong${i}Password`)).status, 401);
    const r = await login(u.email, h.PASSWORD);
    assert.equal(r.status, 401);
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'account_locked' AND target_user_id = $1", [u.id]);
    assert.equal(rows[0].n, 1);
  });
  it('parallel guesses cannot slip past the lock', async () => {
    const u = await h.createUser('viewer');
    await Promise.all(Array.from({ length: 12 }, (_, i) => login(u.email, `Parallel${i}Guess`)));
    assert.equal((await login(u.email, h.PASSWORD)).status, 401);
  });
  it('an admin can unlock the account', async () => {
    const u = await h.createUser('viewer');
    for (let i = 0; i < 5; i += 1) await login(u.email, `Wrong${i}Password`);
    assert.equal((await w.as.admin.patch(`/api/admin/users/${u.id}`).send({ unlock: true })).status, 200);
    assert.equal((await login(u.email, h.PASSWORD)).status, 200);
  });
  it('the login rule on its own refuses locked and disabled accounts', () => {
    const authz = require('../src/authz');
    const soon = new Date(Date.now() + 60000);
    assert.equal(authz.canAttemptLogin({ is_active: true, locked_until: null }), true);
    assert.equal(authz.canAttemptLogin({ is_active: true, locked_until: soon }), false);
    assert.equal(authz.canAttemptLogin({ is_active: false, locked_until: null }), false);
  });
  it('the password hash is never sent to the browser', async () => {
    const r = await w.as.admin.get('/api/admin/users');
    assert.ok(!JSON.stringify(r.body).includes('$2'));
    assert.ok(r.body.users.every((u) => u.password_hash === undefined && u.passwordHash === undefined));
  });
});

describe('T17 cross-site requests', () => {
  it('a change without the TrustVault header is refused, even with a valid session', async () => {
    const id = await h.upload(w.as.alice, { title: 'CSRF target' });
    const r = await w.as.alice.agent.delete(`/api/documents/${id}`); // no header
    assert.equal(r.status, 403);
    assert.equal((await w.as.alice.get(`/api/documents/${id}`)).status, 200);
    const g = await w.as.alice.agent.put(`/api/documents/${id}/grants/${w.users.eve.id}`).send({ permission: 'read' });
    assert.equal(g.status, 403);
    assert.equal((await w.as.eve.get(`/api/documents/${id}`)).status, 404);
  });
  it('sign-in itself needs the header (stops login CSRF)', async () => {
    const r = await h.request(h.app).post('/api/auth/login').send({ email: 'alice@test.local', password: h.PASSWORD });
    assert.equal(r.status, 403);
  });
  it('the CSRF rule on its own needs the exact header value', () => {
    const authz = require('../src/authz');
    const req = (v) => ({ get: (n) => (n === 'X-TrustVault-Request' ? v : undefined) });
    assert.equal(authz.hasCsrfHeader(req('1')), true);
    assert.equal(authz.hasCsrfHeader(req(undefined)), false);
    assert.equal(authz.hasCsrfHeader(req('true')), false);
  });
  it('the server never approves cross-origin requests', async () => {
    const r = await h.request(h.app).options('/api/documents').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'DELETE');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });
});

describe('Session cookie and security headers', () => {
  it('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const r = await login('alice@test.local', h.PASSWORD);
    const cookie = r.headers['set-cookie'].join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });
  it('pages cannot be framed and have a content security policy', async () => {
    const r = await h.request(h.app).get('/api/health');
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal(r.headers['cache-control'], 'no-store');
  });
  it('errors do not leak internals', async () => {
    const r = await w.as.alice.post('/api/documents').set('Content-Type', 'application/json').send('{"bad json');
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.body).match(/at |node_modules|SELECT/));
  });
});

describe('Admin account management', () => {
  it('admin can create a user with a strong password, and it is logged', async () => {
    const r = await w.as.admin.post('/api/admin/users').send({ email: 'new@test.local', name: 'New', role: 'viewer', password: 'StrongPassw0rd' });
    assert.equal(r.status, 201);
    const { rows } = await h.pool.query("SELECT * FROM audit_log WHERE action = 'user_create' AND details->>'email' = 'new@test.local'");
    assert.equal(rows[0].actor_email, 'admin@test.local');
  });
  it('weak passwords and duplicate emails are refused', async () => {
    assert.equal((await w.as.admin.post('/api/admin/users').send({ email: 'weak@test.local', name: 'W', role: 'viewer', password: 'short' })).status, 400);
    assert.equal((await w.as.admin.post('/api/admin/users').send({ email: 'ALICE@test.local', name: 'A', role: 'viewer', password: 'StrongPassw0rd' })).status, 409);
  });
  it('an admin cannot disable or demote themselves', async () => {
    assert.equal((await w.as.admin.patch(`/api/admin/users/${w.users.admin.id}`).send({ active: false })).status, 400);
    assert.equal((await w.as.admin.patch(`/api/admin/users/${w.users.admin.id}`).send({ role: 'viewer' })).status, 400);
  });
});
