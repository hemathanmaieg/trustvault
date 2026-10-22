'use strict';
// Shared test setup. MUST be required first in every test file (it sets NODE_ENV).
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { migrate } = require('../db/migrate');
const { hashPassword } = require('../src/auth/passwords');
const { makePdf, makeText, PNG_1PX } = require('../db/sample-files');

const PASSWORD = 'TestPassword123';
const app = createApp();

/** Wipe the test database and apply the schema fresh. */
async function resetDb() {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
}

let counter = 0;
async function createUser(role, overrides = {}) {
  counter += 1;
  const email = overrides.email || `${role}${counter}@test.local`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role`,
    [email, overrides.name || `${role} ${counter}`, role, await hashPassword(overrides.password || PASSWORD), overrides.active ?? true]
  );
  return rows[0];
}

/** A supertest agent (keeps cookies) that always sends the CSRF header. */
function client() {
  const agent = request.agent(app);
  const wrap = (method) => (url) => agent[method](url).set('X-TrustVault-Request', '1');
  return {
    agent,
    get: (url) => agent.get(url),
    post: wrap('post'),
    put: wrap('put'),
    patch: wrap('patch'),
    delete: wrap('delete'),
  };
}

async function signIn(user, password = PASSWORD) {
  const c = client();
  const res = await c.post('/api/auth/login').send({ email: user.email, password });
  if (res.status !== 200) throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`);
  c.user = user;
  return c;
}

async function upload(c, { title = 'Doc', category = 'General', filename = 'file.pdf', content } = {}) {
  const res = await c
    .post('/api/documents')
    .field('title', title)
    .field('category', category)
    .attach('file', content || makePdf(`content of ${title}`), filename);
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function grant(c, docId, userId, permission = 'read') {
  const res = await c.put(`/api/documents/${docId}/grants/${userId}`).send({ permission });
  if (res.status !== 200) throw new Error(`grant failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function auditRows(where = 'TRUE', params = []) {
  const { rows } = await pool.query(`SELECT * FROM audit_log WHERE ${where} ORDER BY seq`, params);
  return rows;
}

/**
 * Standard cast for most tests:
 *   alice (owner) owns `aliceDoc`, shared read with vic and edit with bob
 *   bob   (owner) owns `bobDoc`, shared with nobody
 *   vic   (viewer), eve (viewer, never granted anything), admin
 */
async function standardWorld() {
  await resetDb();
  const alice = await createUser('owner', { name: 'Alice Owner', email: 'alice@test.local' });
  const bob = await createUser('owner', { name: 'Bob Owner', email: 'bob@test.local' });
  const vic = await createUser('viewer', { name: 'Vic Viewer', email: 'vic@test.local' });
  const eve = await createUser('viewer', { name: 'Eve Outsider', email: 'eve@test.local' });
  const admin = await createUser('admin', { name: 'Ada Admin', email: 'admin@test.local' });
  const as = {
    alice: await signIn(alice),
    bob: await signIn(bob),
    vic: await signIn(vic),
    eve: await signIn(eve),
    admin: await signIn(admin),
  };
  const aliceDoc = await upload(as.alice, { title: 'Alice salary letter', category: 'HR' });
  const bobDoc = await upload(as.bob, { title: 'Bob private drawing', category: 'Engineering' });
  await grant(as.alice, aliceDoc, vic.id, 'read');
  await grant(as.alice, aliceDoc, bob.id, 'edit');
  return { users: { alice, bob, vic, eve, admin }, as, aliceDoc, bobDoc };
}

const NOT_A_DOC = '00000000-0000-4000-8000-000000000000';

module.exports = {
  app, pool, request, PASSWORD, NOT_A_DOC,
  resetDb, createUser, client, signIn, upload, grant, auditRows, standardWorld,
  makePdf, makeText, PNG_1PX,
};
