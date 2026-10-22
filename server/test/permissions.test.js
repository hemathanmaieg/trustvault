'use strict';
// Read vs edit vs owner, roles, and who may receive a grant.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

let w;
before(async () => { w = await h.standardWorld(); });
after(async () => { await h.pool.end(); });

describe('T08 read and edit grants allow exactly what they say', () => {
  it('a reader cannot change details, upload a version, delete or share', async () => {
    assert.equal((await w.as.vic.patch(`/api/documents/${w.aliceDoc}`).send({ title: 'x' })).status, 404);
    assert.equal((await w.as.vic.post(`/api/documents/${w.aliceDoc}/versions`).attach('file', h.makePdf('x'), 'x.pdf')).status, 404);
    assert.equal((await w.as.vic.delete(`/api/documents/${w.aliceDoc}`)).status, 404);
    assert.equal((await w.as.vic.put(`/api/documents/${w.aliceDoc}/grants/${w.users.eve.id}`).send({ permission: 'read' })).status, 404);
    assert.equal((await w.as.eve.get(`/api/documents/${w.aliceDoc}`)).status, 404);
  });
  it('an editor can change details and upload a version', async () => {
    const p = await w.as.bob.patch(`/api/documents/${w.aliceDoc}`).send({ description: 'edited by bob' });
    assert.equal(p.status, 200);
    const v = await w.as.bob.post(`/api/documents/${w.aliceDoc}/versions`).attach('file', h.makePdf('bob v2'), 'v2.pdf');
    assert.equal(v.status, 201);
    assert.equal(v.body.version, 2);
  });
  it('an editor cannot share, revoke, list access, see activity, delete or restore', async () => {
    assert.equal((await w.as.bob.put(`/api/documents/${w.aliceDoc}/grants/${w.users.eve.id}`).send({ permission: 'read' })).status, 404);
    assert.equal((await w.as.bob.delete(`/api/documents/${w.aliceDoc}/grants/${w.users.vic.id}`)).status, 404);
    assert.equal((await w.as.bob.get(`/api/documents/${w.aliceDoc}/grants`)).status, 404);
    assert.equal((await w.as.bob.get(`/api/documents/${w.aliceDoc}/activity`)).status, 404);
    assert.equal((await w.as.bob.delete(`/api/documents/${w.aliceDoc}`)).status, 404);
    // eve was never granted and vic still has read
    assert.equal((await w.as.eve.get(`/api/documents/${w.aliceDoc}`)).status, 404);
    assert.equal((await w.as.vic.get(`/api/documents/${w.aliceDoc}`)).status, 200);
  });
  it('an editor cannot raise their own grant', async () => {
    assert.equal((await w.as.bob.put(`/api/documents/${w.aliceDoc}/grants/${w.users.bob.id}`).send({ permission: 'edit' })).status, 404);
  });
  it('the owner can do everything on their own document', async () => {
    assert.equal((await w.as.alice.get(`/api/documents/${w.aliceDoc}/grants`)).status, 200);
    assert.equal((await w.as.alice.get(`/api/documents/${w.aliceDoc}/activity`)).status, 200);
    const d = await w.as.alice.get(`/api/documents/${w.aliceDoc}`);
    assert.deepEqual(d.body.can, { edit: true, manage: true });
  });
  it('the details page tells a reader they cannot edit or manage', async () => {
    const d = await w.as.vic.get(`/api/documents/${w.aliceDoc}`);
    assert.deepEqual(d.body.can, { edit: false, manage: false });
  });
});

describe('T07 roles cannot be exceeded', () => {
  it('a viewer cannot upload', async () => {
    const r = await w.as.vic.post('/api/documents').field('title', 'x').attach('file', h.makePdf('x'), 'x.pdf');
    assert.equal(r.status, 403);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM documents WHERE owner_id = $1', [w.users.vic.id]);
    assert.equal(rows[0].n, 0);
  });
  it('an admin cannot upload', async () => {
    const r = await w.as.admin.post('/api/documents').field('title', 'x').attach('file', h.makePdf('x'), 'x.pdf');
    assert.equal(r.status, 403);
  });
  it('owners and viewers cannot use any admin endpoint', async () => {
    for (const c of [w.as.alice, w.as.vic]) {
      assert.equal((await c.get('/api/admin/users')).status, 403);
      assert.equal((await c.get('/api/admin/audit')).status, 403);
      assert.equal((await c.get('/api/admin/alerts')).status, 403);
      assert.equal((await c.get('/api/admin/documents')).status, 403);
      assert.equal((await c.get('/api/admin/audit/verify')).status, 403);
      assert.equal((await c.post('/api/admin/users').send({ email: 'x@y.z', name: 'x', role: 'admin', password: 'Password12345' })).status, 403);
      assert.equal((await c.patch(`/api/admin/users/${c.user.id}`).send({ role: 'admin' })).status, 403);
    }
    const { rows } = await h.pool.query("SELECT role FROM users WHERE id = ANY($1)", [[w.users.alice.id, w.users.vic.id]]);
    assert.ok(rows.every((r) => r.role !== 'admin'));
  });
  it('extra fields in a request (like owner_id or role) are refused and change nothing', async () => {
    const id = await h.upload(w.as.alice, { title: 'Alice extra' });
    const r = await w.as.alice.patch(`/api/documents/${id}`).send({ title: 'renamed', owner_id: w.users.eve.id, role: 'admin' });
    assert.equal(r.status, 400);
    const { rows } = await h.pool.query('SELECT owner_id, title FROM documents WHERE id = $1', [id]);
    assert.equal(rows[0].owner_id, w.users.alice.id);
    assert.equal(rows[0].title, 'Alice extra');
    const me = await w.as.alice.get('/api/auth/me');
    assert.equal(me.body.user.role, 'owner');
  });
});

describe('T14 access can only be given to a valid person', () => {
  const put = (to, permission = 'read') => w.as.alice.put(`/api/documents/${w.aliceDoc}/grants/${to}`).send({ permission });
  it('cannot grant to an administrator', async () => {
    assert.equal((await put(w.users.admin.id)).status, 400);
  });
  it('cannot grant to yourself', async () => {
    assert.equal((await put(w.users.alice.id)).status, 400);
  });
  it('cannot grant to a disabled account', async () => {
    const off = await h.createUser('viewer', { active: false });
    assert.equal((await put(off.id)).status, 400);
  });
  it('cannot grant to a user that does not exist or a malformed id', async () => {
    assert.equal((await put(h.NOT_A_DOC)).status, 400);
    assert.equal((await put('not-a-uuid')).status, 400);
  });
  it('cannot grant a permission level that does not exist', async () => {
    assert.equal((await put(w.users.eve.id, 'owner')).status, 400);
    assert.equal((await put(w.users.eve.id, 'admin')).status, 400);
  });
  it('none of the refused grants were stored', async () => {
    const { rows } = await h.pool.query('SELECT user_id FROM grants WHERE document_id = $1 ORDER BY user_id', [w.aliceDoc]);
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [w.users.bob.id, w.users.vic.id].sort());
  });
  it('the authz rule on its own refuses admins, self and disabled users', () => {
    const authz = require('../src/authz');
    const ownerId = w.users.alice.id;
    assert.equal(authz.canReceiveGrant({ id: 'x', role: 'admin', is_active: true }, ownerId), false);
    assert.equal(authz.canReceiveGrant({ id: ownerId, role: 'owner', is_active: true }, ownerId), false);
    assert.equal(authz.canReceiveGrant({ id: 'y', role: 'viewer', is_active: false }, ownerId), false);
    assert.equal(authz.canReceiveGrant({ id: 'z', role: 'viewer', is_active: true }, ownerId), true);
  });
});

describe('T23 the people directory', () => {
  it('owners can search people to share with, but never see admins or themselves', async () => {
    const r = await w.as.alice.get('/api/users/directory');
    assert.equal(r.status, 200);
    const emails = r.body.users.map((u) => u.email);
    assert.ok(emails.includes('vic@test.local'));
    assert.ok(!emails.includes('admin@test.local'));
    assert.ok(!emails.includes('alice@test.local'));
    assert.ok(r.body.users.every((u) => u.password_hash === undefined));
  });
  it('viewers and admins cannot use it', async () => {
    assert.equal((await w.as.vic.get('/api/users/directory')).status, 403);
    assert.equal((await w.as.admin.get('/api/users/directory')).status, 403);
  });
});

describe('T11 deleted documents', () => {
  let doc;
  before(async () => {
    doc = await h.upload(w.as.alice, { title: 'To be trashed' });
    await h.grant(w.as.alice, doc, w.users.vic.id, 'read');
    assert.equal((await w.as.alice.delete(`/api/documents/${doc}`)).status, 200);
  });
  it('a grantee cannot reach a trashed document', async () => {
    assert.equal((await w.as.vic.get(`/api/documents/${doc}`)).status, 404);
    assert.equal((await w.as.vic.get(`/api/documents/${doc}/download`)).status, 404);
    const list = await w.as.vic.get('/api/documents');
    assert.ok(!list.body.documents.some((d) => d.id === doc));
  });
  it('even the owner cannot download it until it is restored', async () => {
    assert.equal((await w.as.alice.get(`/api/documents/${doc}/download`)).status, 404);
  });
  it('trash shows only your own deleted documents', async () => {
    assert.ok((await w.as.alice.get('/api/documents/trash')).body.documents.some((d) => d.id === doc));
    assert.deepEqual((await w.as.bob.get('/api/documents/trash')).body.documents, []);
    assert.deepEqual((await w.as.vic.get('/api/documents/trash')).body.documents, []);
  });
  it('nobody else can restore it', async () => {
    assert.equal((await w.as.bob.post(`/api/documents/${doc}/restore`)).status, 404);
    assert.equal((await w.as.vic.post(`/api/documents/${doc}/restore`)).status, 404);
    const { rows } = await h.pool.query('SELECT deleted_at FROM documents WHERE id = $1', [doc]);
    assert.notEqual(rows[0].deleted_at, null);
  });
  it('the owner can restore it, and existing grants come back', async () => {
    assert.equal((await w.as.alice.post(`/api/documents/${doc}/restore`)).status, 200);
    assert.equal((await w.as.vic.get(`/api/documents/${doc}/download`)).status, 200);
  });
});
