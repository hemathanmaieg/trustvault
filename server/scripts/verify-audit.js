'use strict';
// Command-line audit chain check: `npm run verify-audit`.
// Prints the result and the current head, which can be compared with the last
// `[audit-anchor]` line in the host's logs to detect removal of the newest entries.
const { pool } = require('../src/db');
const { verifyChain } = require('../src/audit');

verifyChain()
  .then((r) => {
    if (r.ok) {
      console.log(`Audit chain intact: ${r.checked} entries.`);
      console.log(`Head: #${r.headSeq} ${r.headHash}`);
    } else {
      console.error(`AUDIT CHAIN BROKEN: ${r.problem}`);
      process.exitCode = 2;
    }
    return pool.end();
  })
  .catch((err) => {
    console.error('Could not check the chain:', err.message);
    process.exit(1);
  });
