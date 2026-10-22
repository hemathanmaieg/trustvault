'use strict';
// Validation of what is uploaded, and safe delivery of what is downloaded.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

let w;
before(async () => { w = await h.standardWorld(); });
after(async () => { await h.pool.end(); });

const send = (filename, content, fields = {}) => {
  let req = w.as.alice.post('/api/documents');
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', content, filename);
};

describe('T15 only real, allowed files are accepted', () => {
  it('accepts a genuine PDF, PNG, text and CSV file', async () => {
    assert.equal((await send('ok.pdf', h.makePdf('ok'))).status, 201);
    assert.equal((await send('ok.png', h.PNG_1PX)).status, 201);
    assert.equal((await send('notes.txt', h.makeText('hello'))).status, 201);
    assert.equal((await send('data.csv', h.makeText('a,b\n1,2\n'))).status, 201);
  });
  it('rejects a text file renamed to .pdf', async () => {
    const r = await send('invoice.pdf', h.makeText('I am not a pdf'));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /does not match/);
  });
  it('rejects a PNG renamed to .jpg', async () => {
    assert.equal((await send('photo.jpg', h.PNG_1PX)).status, 400);
  });
  it('rejects a Windows program renamed to .pdf', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
    assert.equal((await send('report.pdf', exe)).status, 400);
  });
  it('rejects a binary file disguised as .txt', async () => {
    assert.equal((await send('readme.txt', h.makePdf('sneaky'))).status, 400);
    assert.equal((await send('readme.txt', Buffer.from([0x41, 0x00, 0x42]))).status, 400);
  });
  it('rejects types that could run in a browser', async () => {
    for (const name of ['page.html', 'page.htm', 'image.svg', 'script.js', 'x.xhtml', 'run.exe', 'noext']) {
      const r = await send(name, h.makeText('<script>alert(1)</script>'));
      assert.equal(r.status, 400, name);
    }
  });
  it('rejects double extensions that end in a blocked type', async () => {
    assert.equal((await send('report.pdf.html', h.makeText('<b>x</b>'))).status, 400);
  });
  it('rejects empty files', async () => {
    assert.equal((await send('empty.txt', Buffer.alloc(0))).status, 400);
  });
  it('rejects files over 10 MB', async () => {
    const big = Buffer.concat([h.makePdf('big'), Buffer.alloc(10 * 1024 * 1024 + 10, 0x20)]);
    const r = await send('big.pdf', big);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /10 MB/);
  });
  it('rejects an unknown category and an over-long title', async () => {
    assert.equal((await send('a.pdf', h.makePdf('a'), { category: 'Secret' })).status, 400);
    assert.equal((await send('a.pdf', h.makePdf('a'), { title: 'x'.repeat(201) })).status, 400);
  });
  it('rejected uploads are recorded as refused', async () => {
    const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'upload' AND outcome = 'denied'");
    assert.ok(rows[0].n >= 5);
  });
  it('a new version is validated the same way', async () => {
    const r = await w.as.alice.post(`/api/documents/${w.aliceDoc}/versions`).attach('file', h.makeText('<html>'), 'evil.html');
    assert.equal(r.status, 400);
  });
});

describe('T15 file names cannot escape or mislead', () => {
  const nameOf = async (id) => (await h.pool.query('SELECT filename FROM document_versions WHERE document_id = $1', [id])).rows[0].filename;
  it('folder parts are removed from the name', async () => {
    const r = await send('../../etc/passwd.txt', h.makeText('x'));
    assert.equal(r.status, 201);
    assert.equal(await nameOf(r.body.id), 'passwd.txt');
    const r2 = await send('..\\..\\windows\\win.txt', h.makeText('x'));
    assert.equal(await nameOf(r2.body.id), 'win.txt');
  });
  it('control characters, quotes and right-to-left tricks are removed', async () => {
    const r = await send('inv‮fdp.txt', h.makeText('x'));
    assert.equal(r.status, 201);
    assert.equal(await nameOf(r.body.id), 'invfdp.txt');
    const r2 = await send('a"b\r\nSet-Cookie: x.txt', h.makeText('x'));
    assert.equal(r2.status, 201);
    assert.ok(!/["\r\n]/.test(await nameOf(r2.body.id)));
  });
});

describe('T16 a downloaded file can never run as part of the site', () => {
  it('downloads are forced to save, never displayed inline', async () => {
    const id = await h.upload(w.as.alice, { title: 'html-ish', filename: 'note.txt', content: h.makeText('<script>alert(document.cookie)</script>') });
    const r = await w.as.alice.get(`/api/documents/${id}/download`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /^attachment;/);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /sandbox/);
    assert.equal(r.headers['cache-control'], 'no-store');
  });
  it('the stored file is byte-for-byte what was uploaded', async () => {
    const pdf = h.makePdf('exact bytes');
    const id = await h.upload(w.as.alice, { content: pdf, filename: 'exact.pdf' });
    const r = await w.as.alice.get(`/api/documents/${id}/download`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.ok(Buffer.compare(r.body, pdf) === 0);
  });
});
