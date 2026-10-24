'use strict';
// The demo seed, and the one-time rename of databases seeded with the earlier demo names.
const h = require('./helpers');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../src/audit');
const { seed, applyDemoRenames, RENAMES } = require('../db/seed');

before(async () => { await h.resetDb(); });
after(async () => { await h.pool.end(); });

describe('Demo seed and demo names', () => {
  it('a fresh database gets the current demo names', async () => {
    assert.equal(await seed(), true);
    const { rows } = await h.pool.query('SELECT email, name FROM users ORDER BY email');
    assert.deepEqual(rows.map((r) => r.name).sort(), ['Darshak', 'Sai', 'Srinu', 'Thanmaie', 'Yugu']);
    const t = await h.pool.query("SELECT title FROM documents WHERE title LIKE 'Salary letter%'");
    assert.equal(t.rows[0].title, 'Salary letter - Sai');
  });

  it('a database seeded with the OLD names is renamed once, audited, and the chain stays intact', async () => {
    // Put the old seed values back, as on a database seeded before the rename.
    for (const r of RENAMES.users) await h.pool.query('UPDATE users SET name = $2 WHERE email = $1', [r.email, r.from]);
    for (const d of RENAMES.documents) {
      await h.pool.query(`UPDATE documents SET ${d.field} = $2 WHERE ${d.field} = $1`, [d.to, d.from]);
    }
    // Someone renamed one person by hand: that must be left alone.
    await h.pool.query("UPDATE users SET name = 'Custom Name' WHERE email = 'viewer2@trustvault.demo'");

    const changed = await applyDemoRenames();
    assert.equal(changed, 4 + 3);
    const { rows } = await h.pool.query('SELECT email, name FROM users ORDER BY email');
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.name]));
    assert.equal(byEmail['admin@trustvault.demo'], 'Thanmaie');
    assert.equal(byEmail['owner@trustvault.demo'], 'Yugu');
    assert.equal(byEmail['owner2@trustvault.demo'], 'Darshak');
    assert.equal(byEmail['viewer@trustvault.demo'], 'Sai');
    assert.equal(byEmail['viewer2@trustvault.demo'], 'Custom Name');

    const renames = await h.auditRows("details->>'reason' = 'demo_rename'");
    assert.equal(renames.length, 7);
    assert.equal((await audit.verifyChain(h.pool)).ok, true);

    // Running again changes nothing.
    assert.equal(await applyDemoRenames(), 0);
  });
});
