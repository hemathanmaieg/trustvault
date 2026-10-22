'use strict';
// Applies server/db/schema.sql. Idempotent: running it twice is safe.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function migrate(db = pool) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => {
      console.log('Schema applied.');
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}
