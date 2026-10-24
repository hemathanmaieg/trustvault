'use strict';
// Seed data: one account of each role (plus a second owner and viewer, so
// "one user cannot reach another user's documents" can be tried by hand),
// and a few documents with different sharing.
//
// Runs only when the users table is empty, so it is safe to call on every deploy.
// Passwords come from environment variables; in development they default to
// the values documented in the README.
const crypto = require('crypto');
const config = require('../src/config');
const { pool, withTransaction } = require('../src/db');
const audit = require('../src/audit');
const { hashPassword } = require('../src/auth/passwords');
const { makePdf, makeText } = require('./sample-files');

function pw(name, devDefault) {
  const v = process.env[name];
  if (v) return v;
  if (config.isProd) throw new Error(`Set ${name} before seeding production`);
  return devDefault;
}

const USERS = [
  { key: 'admin', email: 'admin@trustvault.demo', name: 'Thanmaie', role: 'admin', password: () => pw('SEED_ADMIN_PASSWORD', 'AdminDemo2026!') },
  { key: 'owner1', email: 'owner@trustvault.demo', name: 'Yugu', role: 'owner', password: () => pw('SEED_OWNER_PASSWORD', 'OwnerDemo2026!') },
  { key: 'owner2', email: 'owner2@trustvault.demo', name: 'Darshak', role: 'owner', password: () => pw('SEED_OWNER_PASSWORD', 'OwnerDemo2026!') },
  { key: 'viewer1', email: 'viewer@trustvault.demo', name: 'Sai', role: 'viewer', password: () => pw('SEED_VIEWER_PASSWORD', 'ViewerDemo2026!') },
  { key: 'viewer2', email: 'viewer2@trustvault.demo', name: 'Srinu', role: 'viewer', password: () => pw('SEED_VIEWER_PASSWORD', 'ViewerDemo2026!') },
];

const DOCS = [
  {
    owner: 'owner1', title: 'Salary letter - Sai', category: 'HR',
    description: 'Annual compensation letter. Shared only with the employee.',
    file: { name: 'salary-letter-sai.pdf', bytes: () => makePdf('Salary letter for Sai - CONFIDENTIAL') },
    grants: [{ to: 'viewer1', permission: 'read' }],
  },
  {
    owner: 'owner1', title: 'Customer contract - Acme Ltd', category: 'Contracts',
    description: 'Master services agreement, being edited with Darshak.',
    file: { name: 'acme-contract.pdf', bytes: () => makePdf('Acme Ltd master services agreement - CONFIDENTIAL') },
    grants: [{ to: 'owner2', permission: 'edit' }],
  },
  {
    owner: 'owner1', title: 'Board notes - private', category: 'General',
    description: 'Not shared with anyone.',
    file: { name: 'board-notes.txt', bytes: () => makeText('Board notes. Only Yugu should ever see this.\n') },
    grants: [],
  },
  {
    owner: 'owner2', title: 'Bridge drawing notes', category: 'Engineering',
    description: 'Shared with an external partner for review.',
    file: { name: 'bridge-drawing-notes.pdf', bytes: () => makePdf('Bridge drawing notes rev A') },
    grants: [{ to: 'viewer2', permission: 'read' }],
  },
  {
    owner: 'owner2', title: 'Audit papers Q3', category: 'Audit',
    description: 'For the regulator. Read-only for Srinu.',
    file: { name: 'audit-q3.csv', bytes: () => makeText('account,amount\nrevenue,120000\ncosts,80000\n') },
    grants: [{ to: 'viewer2', permission: 'read' }],
  },
];

// Earlier demo names. A database seeded before the rename is updated once on
// the next start; only values still equal to the OLD seed text are changed,
// so anything someone edited by hand is left alone. Every change is audited.
const RENAMES = {
  users: [
    { email: 'admin@trustvault.demo', from: 'Asha Admin', to: 'Thanmaie' },
    { email: 'owner@trustvault.demo', from: 'Omar Owner', to: 'Yugu' },
    { email: 'owner2@trustvault.demo', from: 'Olivia Owner', to: 'Darshak' },
    { email: 'viewer@trustvault.demo', from: 'Vikram Viewer', to: 'Sai' },
    { email: 'viewer2@trustvault.demo', from: 'Vera Viewer', to: 'Srinu' },
  ],
  documents: [
    { ownerEmail: 'owner@trustvault.demo', field: 'title', from: 'Salary letter - Vikram', to: 'Salary letter - Sai' },
    { ownerEmail: 'owner@trustvault.demo', field: 'description', from: 'Master services agreement, being edited with Olivia.', to: 'Master services agreement, being edited with Darshak.' },
    { ownerEmail: 'owner2@trustvault.demo', field: 'description', from: 'For the regulator. Read-only for Vera.', to: 'For the regulator. Read-only for Srinu.' },
  ],
};

async function applyDemoRenames() {
  let changed = 0;
  await withTransaction(async (client) => {
    for (const r of RENAMES.users) {
      const { rows } = await client.query(
        'UPDATE users SET name = $3, updated_at = now() WHERE lower(email) = $1 AND name = $2 RETURNING id',
        [r.email, r.from, r.to]
      );
      for (const u of rows) {
        changed += 1;
        await audit.record({ actorEmail: 'seed-script', action: 'user_update', targetUserId: u.id, details: { email: r.email, changes: { name: { from: r.from, to: r.to } }, reason: 'demo_rename' } }, client);
      }
    }
    for (const d of RENAMES.documents) {
      const field = d.field === 'title' ? 'title' : 'description';
      const { rows } = await client.query(
        `UPDATE documents SET ${field} = $3, updated_at = now()
          WHERE ${field} = $2 AND owner_id = (SELECT id FROM users WHERE lower(email) = $1) RETURNING id`,
        [d.ownerEmail, d.from, d.to]
      );
      for (const doc of rows) {
        changed += 1;
        await audit.record({ actorEmail: 'seed-script', action: 'update_details', documentId: doc.id, details: { changes: { [field]: { from: d.from, to: d.to } }, reason: 'demo_rename' } }, client);
      }
    }
  });
  if (changed) console.log(`Renamed ${changed} demo values.`);
  return changed;
}

async function seed() {
  const existing = await pool.query('SELECT count(*)::int AS n FROM users');
  if (existing.rows[0].n > 0) {
    console.log('Users already exist, skipping seed.');
    await applyDemoRenames();
    return false;
  }
  await withTransaction(async (client) => {
    const ids = {};
    const emails = {};
    for (const u of USERS) {
      const hash = await hashPassword(u.password());
      const { rows } = await client.query(
        'INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [u.email, u.name, u.role, hash]
      );
      ids[u.key] = rows[0].id;
      emails[u.key] = u.email;
      await audit.record({ actorEmail: 'seed-script', action: 'user_create', targetUserId: rows[0].id, details: { email: u.email, role: u.role } }, client);
    }
    for (const d of DOCS) {
      const bytes = d.file.bytes();
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const mime = d.file.name.endsWith('.pdf') ? 'application/pdf' : d.file.name.endsWith('.csv') ? 'text/csv' : 'text/plain';
      const { rows } = await client.query(
        'INSERT INTO documents (owner_id, title, category, description) VALUES ($1, $2, $3, $4) RETURNING id',
        [ids[d.owner], d.title, d.category, d.description]
      );
      const docId = rows[0].id;
      await client.query(
        `INSERT INTO document_versions (document_id, version_no, filename, mime_type, size_bytes, sha256, content, uploaded_by)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
        [docId, d.file.name, mime, bytes.length, sha256, bytes, ids[d.owner]]
      );
      await audit.record({ actorId: ids[d.owner], actorEmail: emails[d.owner], action: 'upload', documentId: docId, details: { title: d.title, filename: d.file.name, size: bytes.length, sha256, version: 1, seeded: true } }, client);
      for (const g of d.grants) {
        await client.query(
          'INSERT INTO grants (document_id, user_id, permission, granted_by) VALUES ($1, $2, $3, $4)',
          [docId, ids[g.to], g.permission, ids[d.owner]]
        );
        await audit.record({ actorId: ids[d.owner], actorEmail: emails[d.owner], action: 'grant', documentId: docId, targetUserId: ids[g.to], details: { email: emails[g.to], from: null, to: g.permission, seeded: true } }, client);
      }
    }
  });
  console.log(`Seeded ${USERS.length} users and ${DOCS.length} documents.`);
  return true;
}

module.exports = { seed, USERS, applyDemoRenames, RENAMES };

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}
