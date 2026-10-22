'use strict';
// Regression tests for the findings of the independent security review
// (see PROMPTS.md entries 6-11). Each of these passed undetected before.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const audit = require('../src/audit');
const { createApp } = require('../src/app');

let w;
before(async () => { w = await h.standardWorld(); });
after(async () => { await h.pool.end(); });

const chainOk = async () => {
  const r = await audit.verifyChain(h.pool);
  assert.equal(r.ok, true, r.problem);
};

describe('T19 nobody can break the audit chain by spelling an id differently', () => {
  it('an UPPERCASE document id is recorded without breaking the chain', async () => {
    const r = await w.as.eve.get(`/api/documents/${w.bobDoc.toUpperCase()}/download`);
    assert.equal(r.status, 404);
    await chainOk();
    const { rows } = await h.pool.query("SELECT document_id FROM audit_log WHERE actor_email = 'eve@test.local' ORDER BY seq DESC LIMIT 1");
    assert.equal(rows[0].document_id, w.bobDoc);
  });
  it('an UPPERCASE id still works for the person who has access', async () => {
    assert.equal((await w.as.vic.get(`/api/documents/${w.aliceDoc.toUpperCase()}/download`)).status, 200);
    await chainOk();
  });
  it('revoking with an UPPERCASE user id works and keeps the chain intact', async () => {
    await h.grant(w.as.alice, w.aliceDoc, w.users.eve.id, 'read');
    const r = await w.as.alice.delete(`/api/documents/${w.aliceDoc}/grants/${w.users.eve.id.toUpperCase()}`);
    assert.equal(r.status, 200);
    assert.equal((await w.as.eve.get(`/api/documents/${w.aliceDoc}`)).status, 404);
    await chainOk();
  });
  it('an admin password reset with an UPPERCASE id keeps the chain intact', async () => {
    const u = await h.createUser('viewer');
    assert.equal((await w.as.admin.post(`/api/admin/users/${u.id.toUpperCase()}/password`).send({ password: 'UpperCaseReset2026' })).status, 200);
    await chainOk();
  });
  it('an admin cannot demote themselves by writing their own id in UPPERCASE', async () => {
    const r = await w.as.admin.patch(`/api/admin/users/${w.users.admin.id.toUpperCase()}`).send({ role: 'viewer' });
    assert.equal(r.status, 400);
    const { rows } = await h.pool.query('SELECT role FROM users WHERE id = $1', [w.users.admin.id]);
    assert.equal(rows[0].role, 'admin');
  });
  it('the audit writer refuses to store an entry whose seal would not verify', async () => {
    // A value Postgres would change on the way in can no longer reach the chain:
    await audit.record({ action: 'test_probe', documentId: w.aliceDoc.toUpperCase(), details: { n: 1.0, s: 'a\u0000b\ud800' } });
    await chainOk();
  });
});

describe('T08 editing one field never changes another', () => {
  it('renaming a document keeps its description', async () => {
    await w.as.alice.patch(`/api/documents/${w.aliceDoc}`).send({ description: 'Keep me' });
    const r = await w.as.bob.patch(`/api/documents/${w.aliceDoc}`).send({ title: 'Renamed by Bob' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.changed, ['title']);
    const { rows } = await h.pool.query('SELECT title, description FROM documents WHERE id = $1', [w.aliceDoc]);
    assert.equal(rows[0].description, 'Keep me');
  });
});

describe('T03 access removed during a slow upload stops that upload', () => {
  it('an editor revoked while their upload is still arriving cannot add the version', async () => {
    const doc = await h.upload(w.as.alice, { title: 'Race target' });
    await h.grant(w.as.alice, doc, w.users.bob.id, 'edit');
    const cookie = w.as.bob.agent.jar.getCookie('tv_session', { path: '/', domain: '127.0.0.1', secure: false, script: false });
    assert.ok(cookie, 'need Bob\'s session cookie');

    const server = createApp().listen(0);
    const port = server.address().port;
    const boundary = 'tvboundary123';
    const content = h.makePdf('slow upload');
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, content, tail]);
    const half = Math.floor(body.length / 2);

    const result = new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: `/api/documents/${doc}/versions`,
        headers: {
          Cookie: `tv_session=${cookie.value}`, 'X-TrustVault-Request': '1',
          'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body.subarray(0, half)); // permission is checked now, body not finished
      setTimeout(async () => {
        try {
          // Owner revokes while the upload is still in flight.
          const rv = await w.as.alice.delete(`/api/documents/${doc}/grants/${w.users.bob.id}`);
          assert.equal(rv.status, 200);
          req.end(body.subarray(half));
        } catch (e) { reject(e); }
      }, 300);
    });

    const r = await result;
    server.close();
    assert.equal(r.status, 404, `upload after revoke must fail, got ${r.status} ${r.body}`);
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1', [doc]);
    assert.equal(rows[0].n, 1);
    const e = (await h.auditRows("action = 'new_version' AND document_id = $1", [doc])).pop();
    assert.equal(e.outcome, 'denied');
    assert.equal(e.details.reason, 'access_removed_during_request');
  });
});

describe('T20 strange input is refused cleanly and still recorded', () => {
  it('a NUL byte or broken text in a document id gives 404, not a crash, and is logged', async () => {
    for (const p of ['/api/documents/%00/download', '/api/documents/%ED%A0%80/download', '/api/documents/a%00b']) {
      const r = await w.as.eve.get(p);
      assert.ok([400, 404].includes(r.status), `${p} gave ${r.status}`);
    }
    await chainOk();
  });
  it('NUL bytes in search, filters or sign-in are refused with 400', async () => {
    assert.equal((await w.as.eve.get('/api/documents?q=%00')).status, 400);
    assert.equal((await w.as.eve.get('/api/documents?owner=a%00')).status, 400);
    const login = await h.client().post('/api/auth/login').send({ email: 'x\u0000@y.z', password: 'abc' });
    assert.equal(login.status, 400);
  });
  it('impossible dates are refused with 400', async () => {
    assert.equal((await w.as.eve.get('/api/documents?from=2026-13-45')).status, 400);
    assert.equal((await w.as.eve.get('/api/documents?to=2026-02-30')).status, 400);
    assert.equal((await w.as.admin.get('/api/admin/audit?from=2026-99-99')).status, 400);
    assert.equal((await w.as.eve.get('/api/documents?from=2026-01-31')).status, 200);
  });
});

describe('T39 rate limits', () => {
  it('an address that is not signed in is cut off after the limit, with ONE audit entry', async () => {
    const small = createApp({ rateLimit: { anonPerMinute: 3 } });
    const before = (await h.auditRows("action = 'rate_limit'")).length;
    const codes = [];
    for (let i = 0; i < 6; i += 1) codes.push((await h.request(small).get(`/api/documents/${h.NOT_A_DOC}`)).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429, 429]);
    const afterRows = await h.auditRows("action = 'rate_limit'");
    assert.equal(afterRows.length - before, 1);
    await chainOk();
  });
  it('signed-in users are not affected by the anonymous limit', async () => {
    const small = createApp({ rateLimit: { anonPerMinute: 1 } });
    const c = h.request.agent(small);
    await c.post('/api/auth/login').set('X-TrustVault-Request', '1').send({ email: 'vic@test.local', password: h.PASSWORD });
    for (let i = 0; i < 4; i += 1) assert.equal((await c.get('/api/documents')).status, 200);
  });
});

describe('T15 Word and Excel files', () => {
  const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));
  it('a real .docx and .xlsx are accepted', async () => {
    assert.equal((await w.as.alice.post('/api/documents').attach('file', fixture('sample.docx'), 'letter.docx')).status, 201);
    assert.equal((await w.as.alice.post('/api/documents').attach('file', fixture('sample.xlsx'), 'sheet.xlsx')).status, 201);
  });
  it('a Word file renamed to .xlsx is refused', async () => {
    assert.equal((await w.as.alice.post('/api/documents').attach('file', fixture('sample.docx'), 'sheet.xlsx')).status, 400);
  });
});

describe('T05 role changes cannot orphan documents', () => {
  it('someone who owns documents cannot be made an administrator', async () => {
    const r = await w.as.admin.patch(`/api/admin/users/${w.users.alice.id}`).send({ role: 'admin' });
    assert.equal(r.status, 400);
    const { rows } = await h.pool.query('SELECT role FROM users WHERE id = $1', [w.users.alice.id]);
    assert.equal(rows[0].role, 'owner');
    assert.equal((await w.as.alice.get('/api/auth/me')).status, 200); // and was not signed out
  });
});

describe('T42 restoring from trash records who regains access', () => {
  it('the restore entry lists every person whose access comes back', async () => {
    const doc = await h.upload(w.as.alice, { title: 'Restore me' });
    await h.grant(w.as.alice, doc, w.users.vic.id, 'read');
    await w.as.alice.delete(`/api/documents/${doc}`);
    await w.as.alice.post(`/api/documents/${doc}/restore`);
    const e = await h.auditRows("action = 'restore' AND document_id = $1", [doc]);
    assert.deepEqual(e[0].details.access_restored_for, ['vic@test.local (read)']);
  });
});
