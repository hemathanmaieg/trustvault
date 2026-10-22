# Step 03 — Security tests and the "remove one check" proof

**Date:** 2026-10-22
**Goal:** prove with automated tests that one user cannot reach another's documents, and that the tests really test the permission checks.

## How to run

```bash
npm test                      # all tests (131 at this step; 149 after step 05), needs PostgreSQL (see README)
npm run test:authz-removal    # removes each permission check in turn (about 5 minutes)
```

Tests use a separate database (`trustvault_test`), wiped at the start of each test file.

## Test files

| File | What it proves | Threat ids |
| --- | --- | --- |
| `isolation.test.js` | Another user's document cannot be viewed, downloaded, changed, versioned, deleted, shared or have its activity read. Search and lists never show it. Missing and forbidden look identical. Admins cannot read contents. Nothing works without signing in. | T01, T02, T09, T10, T12, T13, T22 |
| `permissions.test.js` | Read vs edit vs owner do exactly what they say. Roles cannot be exceeded. Extra fields like `owner_id` or `role` are ignored. Grants only go to valid people. Trashed documents are unreachable. | T07, T08, T11, T14, T23 |
| `revocation.test.js` | Revoking works on the next request of the **same** session. Disabling, role change, expiry, logout, password change and reset all end sessions at once. Session tokens are stored hashed. | T03, T04, T05, T06, T25, T26 |
| `audit.test.js` | Every required event is recorded. Refused attempts are recorded. UPDATE / DELETE / TRUNCATE are refused by the database. Edits, deletions and forged re-hashing are detected by the chain check. Alerts work. | T19, T20, T21, T24 |
| `upload.test.js` | Disguised files, programs, HTML/SVG, empty and oversized files are rejected. File names cannot contain folders, control characters or right-to-left tricks. Downloads cannot run in the browser. | T15, T16 |
| `auth.test.js` | Same message for wrong password and unknown email; lock after 5 failures, including 12 guesses in parallel; CSRF header required; cookie flags; security headers; no internal errors leak. | T17, T18 |

Test names start with their threat id, so each THREATS.md entry can be traced to its tests.

## The removal check

The brief says the judges will remove one authorisation check and re-run the tests. Each check in the code has a marker:

```js
return Boolean(level) && LEVELS[level] >= LEVELS.read; // AUTHZ:canRead -> return true;
```

`server/scripts/authz-removal-check.js` copies the server to a temporary folder, swaps in the "check removed" line for **one** marker, runs every test, and records whether a test failed. It does this for all 33 checks: every function in `authz.js`, the guards in `guards.js`, the route mounts in `app.js`, and the `documentAccess` call in every document route.

**Result: 33 out of 33 removals were caught** (34 of 34 after step 05). The full table is in `docs/authz-removal-report.md`.

Layers that back each other up (for example the SQL visibility condition and the per-row filter in search) are each tested on their own, so removing only one of them is still caught.

## Problems found while writing the tests

1. **Upload file names were decoded as Latin-1.** A file named with a hidden right-to-left override character (used to make `exe.txt` look like `txt.exe`) passed the name filter, because the character arrived as three different bytes. Non-English file names were also garbled. Fixed by setting `defParamCharset: 'utf8'` in multer. Found by the test `control characters, quotes and right-to-left tricks are removed`.
2. **The first check-marker format could not remove some checks.** A marker that turned `return null` into `return undefined` still returned early, so "removing" the admin check changed nothing. Every check was reshaped into a yes/no function whose removal is a clean `return true`.
3. **A logout test could pass for the wrong reason.** If the test failed to read the cookie, it replayed the word "missing", which is also refused. The test now asserts it has the real cookie and that the cookie works before logout.
4. **A "no direct file path" test would break once the React app is built**, because unknown paths then return the app's page (status 200). The test now checks that no file content, source code or secret is returned, which is the actual promise.
