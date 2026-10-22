'use strict';
// The core promise: one user cannot reach another user's documents, through any route.
// Test names start with the THREATS.md id they cover.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

let w;
before(async () => { w = await h.standardWorld(); });
after(async () => { await h.pool.end(); });

const notFound = (res) => {
  assert.equal(res.status, 404, `expected 404, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'Document not found');
};

describe('T01 another user\'s document cannot be reached by id', () => {
  it('outsider cannot view details', async () => {
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}`));
  });
  it('outsider cannot download', async () => {
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}/download`));
  });
  it('outsider cannot download an older version', async () => {
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}/download?version=1`));
  });
  it('outsider cannot change details', async () => {
    notFound(await w.as.eve.patch(`/api/documents/${w.aliceDoc}`).send({ title: 'pwned' }));
    const r = await w.as.alice.get(`/api/documents/${w.aliceDoc}`);
    assert.equal(r.body.document.title, 'Alice salary letter');
  });
  it('outsider cannot upload a new version', async () => {
    notFound(await w.as.eve.post(`/api/documents/${w.aliceDoc}/versions`).attach('file', h.makePdf('evil'), 'evil.pdf'));
    const r = await w.as.alice.get(`/api/documents/${w.aliceDoc}`);
    assert.equal(r.body.versions.length, 1);
  });
  it('outsider cannot delete', async () => {
    notFound(await w.as.eve.delete(`/api/documents/${w.aliceDoc}`));
    assert.equal((await w.as.alice.get(`/api/documents/${w.aliceDoc}`)).status, 200);
  });
  it('outsider cannot see, add or remove grants', async () => {
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}/grants`));
    notFound(await w.as.eve.put(`/api/documents/${w.aliceDoc}/grants/${w.users.eve.id}`).send({ permission: 'edit' }));
    notFound(await w.as.eve.delete(`/api/documents/${w.aliceDoc}/grants/${w.users.vic.id}`));
    // eve still has nothing, vic still has read
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}`));
    assert.equal((await w.as.vic.get(`/api/documents/${w.aliceDoc}`)).status, 200);
  });
  it('outsider cannot read the document activity', async () => {
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}/activity`));
  });
  it('one owner cannot reach another owner\'s private document', async () => {
    notFound(await w.as.alice.get(`/api/documents/${w.bobDoc}`));
    notFound(await w.as.alice.get(`/api/documents/${w.bobDoc}/download`));
    notFound(await w.as.alice.delete(`/api/documents/${w.bobDoc}`));
  });
  it('a granted reader can reach exactly what was granted', async () => {
    const r = await w.as.vic.get(`/api/documents/${w.aliceDoc}/download`);
    assert.equal(r.status, 200);
    assert.ok(r.body.toString('latin1').startsWith('%PDF'));
    notFound(await w.as.vic.get(`/api/documents/${w.bobDoc}/download`));
  });
});

describe('T09 lists and search never reveal documents the user cannot open', () => {
  it('outsider sees an empty list', async () => {
    const r = await w.as.eve.get('/api/documents');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.documents, []);
  });
  it('searching another user\'s title by name returns nothing', async () => {
    const r = await w.as.eve.get('/api/documents?q=salary');
    assert.deepEqual(r.body.documents, []);
  });
  it('a SQL LIKE wildcard does not widen the search', async () => {
    const r = await w.as.eve.get('/api/documents?q=%25');
    assert.deepEqual(r.body.documents, []);
    const r2 = await w.as.vic.get('/api/documents?q=_');
    assert.deepEqual(r2.body.documents, []);
  });
  it('searching by owner name does not reveal that owner\'s private documents', async () => {
    const r = await w.as.vic.get('/api/documents?owner=Bob');
    assert.deepEqual(r.body.documents, []);
  });
  it('the reader sees only the shared document', async () => {
    const r = await w.as.vic.get('/api/documents');
    assert.deepEqual(r.body.documents.map((d) => d.id), [w.aliceDoc]);
    assert.equal(r.body.documents[0].myAccess, 'read');
  });
  it('owner sees own and shared documents with the right access level', async () => {
    const r = await w.as.bob.get('/api/documents');
    const byId = Object.fromEntries(r.body.documents.map((d) => [d.id, d.myAccess]));
    assert.deepEqual(byId, { [w.aliceDoc]: 'edit', [w.bobDoc]: 'owner' });
  });
  it('the SQL visibility condition on its own excludes other people\'s documents', async () => {
    const authz = require('../src/authz');
    const { rows } = await h.pool.query(
      `SELECT d.id FROM documents d WHERE ${authz.visibleDocumentsCondition('$1')}`,
      [w.users.eve.id]
    );
    assert.deepEqual(rows, []);
  });
  it('the per-row filter on its own drops rows the user cannot read', () => {
    const authz = require('../src/authz');
    const rows = [
      { id: 'a', owner_id: w.users.alice.id, grant_permission: null },
      { id: 'b', owner_id: w.users.eve.id, grant_permission: null },
      { id: 'c', owner_id: w.users.alice.id, grant_permission: 'read' },
    ];
    assert.deepEqual(authz.filterReadable(w.users.eve, rows).map((r) => r.id), ['b', 'c']);
  });
});

describe('T10 missing and forbidden documents look the same', () => {
  it('a document that does not exist and one that is forbidden give the same answer', async () => {
    const missing = await w.as.eve.get(`/api/documents/${h.NOT_A_DOC}/download`);
    const forbidden = await w.as.eve.get(`/api/documents/${w.bobDoc}/download`);
    assert.equal(missing.status, forbidden.status);
    assert.deepEqual(missing.body, forbidden.body);
  });
  it('malformed ids are refused without an error page', async () => {
    notFound(await w.as.eve.get('/api/documents/1%20OR%201=1/download'));
    notFound(await w.as.eve.get("/api/documents/'%3B--/download"));
  });
});

describe('T12 every version is protected, not just the latest', () => {
  it('an outsider cannot fetch version 1 after a new version is uploaded', async () => {
    const r = await w.as.alice.post(`/api/documents/${w.aliceDoc}/versions`).attach('file', h.makePdf('v2'), 'v2.pdf');
    assert.equal(r.status, 201);
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}/download?version=1`));
    notFound(await w.as.eve.get(`/api/documents/${w.aliceDoc}/download?version=2`));
    assert.equal((await w.as.vic.get(`/api/documents/${w.aliceDoc}/download?version=1`)).status, 200);
  });
});

describe('T13 administrators cannot read document contents', () => {
  it('admin cannot view or download any document', async () => {
    notFound(await w.as.admin.get(`/api/documents/${w.aliceDoc}`));
    notFound(await w.as.admin.get(`/api/documents/${w.aliceDoc}/download`));
    const list = await w.as.admin.get('/api/documents');
    assert.deepEqual(list.body.documents, []);
  });
  it('even a grant row written straight into the database does not give an admin access', async () => {
    await h.pool.query(
      "INSERT INTO grants (document_id, user_id, permission, granted_by) VALUES ($1, $2, 'read', $3)",
      [w.bobDoc, w.users.admin.id, w.users.bob.id]
    );
    notFound(await w.as.admin.get(`/api/documents/${w.bobDoc}/download`));
    const list = await w.as.admin.get('/api/documents');
    assert.deepEqual(list.body.documents, []);
    await h.pool.query('DELETE FROM grants WHERE user_id = $1', [w.users.admin.id]);
  });
  it('admin overview shows titles and counts but has no download route', async () => {
    const r = await w.as.admin.get('/api/admin/documents');
    assert.equal(r.status, 200);
    assert.ok(r.body.documents.length >= 2);
    assert.equal(r.body.documents[0].content, undefined);
  });
});

describe('T22 nothing is reachable without signing in', () => {
  for (const path of ['/api/documents', `/api/documents/${'x'}`, '/api/documents/trash', '/api/users/directory', '/api/admin/users', '/api/admin/audit']) {
    it(`GET ${path} needs a session`, async () => {
      const r = await h.request(h.app).get(path);
      assert.equal(r.status, 401);
    });
  }
  it('anonymous download of a real document id is refused', async () => {
    const r = await h.request(h.app).get(`/api/documents/${w.aliceDoc}/download`);
    assert.equal(r.status, 401);
    assert.equal(r.headers['content-disposition'], undefined);
  });
  it('a forged or random session cookie is not accepted', async () => {
    const r = await h.request(h.app).get(`/api/documents/${w.aliceDoc}/download`).set('Cookie', 'tv_session=abc123');
    assert.equal(r.status, 401);
  });
});

describe('T02 there is no direct path to stored files', () => {
  it('file bytes are only in the database; no static route serves uploads', async () => {
    // (Unknown paths may return the app's index.html page; what matters is that
    //  no file content, source code or secret ever comes back.)
    for (const p of ['/uploads/', '/files/', '/storage/', `/${w.aliceDoc}`, `/uploads/${w.aliceDoc}`, '/server/db/schema.sql', '/.env', '/package.json']) {
      const r = await h.request(h.app).get(p);
      const body = r.text || (r.body && r.body.toString ? r.body.toString('latin1') : '');
      assert.ok(!body.includes('%PDF'), `${p} returned file content`);
      assert.ok(!body.includes('CREATE TABLE') && !body.includes('AUDIT_HMAC_KEY') && !body.includes('"dependencies"'), `${p} returned server files`);
    }
  });
});
