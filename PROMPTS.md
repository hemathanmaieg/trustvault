# PROMPTS.md — how AI was used, and where it was wrong

This project was built with an AI assistant (Claude). This file is written as the work happens, and each entry links to the commit where the fix went in.

Each entry says **who caught the problem**: the person directing the work, a test, or the AI reviewing its own earlier output. All of them are counted here, because the point is that no AI output was trusted without being checked.

> Before submission: the candidate should add entries of her own from reviewing and running this code (for example anything she changes after reading `authz.js`). Entries must be real.

---

## Reused prompt / context (used at the start of every working session)

```text
You are helping build TrustVault, a document platform judged mainly on security.
Non-negotiable rules:
1. A document is reachable only by someone granted it, through ANY route. The server decides every time.
2. We can prove who reached it, including refused attempts. The audit trail must be tamper-evident.
3. Revoking access works immediately; anything issued earlier stops working.
Working rules for you:
- Every permission decision goes in server/src/authz.js. Routes call it; they never compare roles themselves.
- Every check gets an "// AUTHZ:<name> -> <removed version>" marker and a test that fails without it.
- Never use signed URLs, permission-carrying tokens or caches for access decisions.
- Answer 404 for forbidden and missing documents alike, and audit every refusal.
- Prefer a smaller feature set that holds over a bigger one with a hole.
- When you write code, list what could be wrong with it before I accept it.
```

---

## Entry 1 — 2026-10-22 — Failed-login counter could be bypassed (authentication)

- **Asked:** "Write the login route: generic error, lock the account after 5 wrong passwords for 15 minutes, audit every attempt."
- **Produced:** a route that read `failed_logins` from the user row, added one in JavaScript, and wrote the new value back with a second query.
- **What was wrong:** a read-then-write race. Ten wrong guesses sent at the same moment all read the same old count, so the account never reached 5 and never locked. Password guessing could continue without limit.
- **Caught by:** the AI, re-reading its own route before the first commit, prompted by the "list what could be wrong" rule above.
- **What we did instead:** a single atomic SQL statement, `SET failed_logins = CASE WHEN failed_logins + 1 >= 5 ... END`, which also sets `locked_until` in the same statement. Added the test `parallel guesses cannot slip past the lock` (12 guesses at once, then the right password must still fail).
- **Commit:** `7d76f58` (fix included before the first commit) and test in `ccf85d2`.

## Entry 2 — 2026-10-22 — "Removing" the admin check did not actually remove it (access control)

- **Asked:** "Mark every authorisation check so a script can remove each one and prove a test fails."
- **Produced:** markers that replace the `return` value of a line, including `if (user.role === 'admin') return null; // -> return undefined`.
- **What was wrong:** replacing `return null` with `return undefined` still returns early, so the admin was still blocked and the "removal" removed nothing. The script would have reported that check as tested when it had never been switched off.
- **Caught by:** the AI, while designing the removal script.
- **What we did instead:** every check became a yes/no function (`roleMayHoldDocuments`, `canReceiveGrant`, ...) whose removed version is an unconditional `return true`. Markers now carry the whole replacement line. The script then showed 33/33 removals caught.
- **Commit:** `ccf85d2`

## Entry 3 — 2026-10-22 — Upload file names decoded with the wrong character set (upload validation)

- **Asked:** "Validate uploads: allowed types by magic bytes, size limit, and a safe file name with no folders, control characters or right-to-left override."
- **Produced:** a correct-looking filter that removed `‮` (right-to-left override) from the name.
- **What was wrong:** multer decodes file names as Latin-1 by default. The UTF-8 bytes of `‮` arrived as three different characters, so the filter never matched. `invoice‮fdp.txt` would be stored and shown as `invoicetxt.pdf`. Non-English names were also garbled.
- **Caught by:** a test (`control characters, quotes and right-to-left tricks are removed`) failing with the actual value `invâ\x80®fdp.txt`.
- **What we did instead:** set `defParamCharset: 'utf8'` on multer, so names are decoded correctly before filtering.
- **Commit:** `ccf85d2`

## Entry 4 — 2026-10-22 — A revocation test that could pass for the wrong reason (session / revocation)

- **Asked:** "Test that logging out ends the session on the server, not just in the browser."
- **Produced:** a test that read the cookie from the test agent, logged out, then replayed `tv_session=${cookie ? cookie.value : 'missing'}` and expected 401.
- **What was wrong:** if reading the cookie failed, the test replayed the word `missing`, which is also refused, so the test passed without testing anything.
- **Caught by:** the AI, reviewing the tests after they all passed on the first run (all passing first time was treated as a reason to check, not to relax).
- **What we did instead:** the test now asserts it has the real cookie value, proves that cookie works **before** logout, and only then proves it fails after.
- **Commit:** `ccf85d2`

## Entry 5 — 2026-10-22 — "No direct file path" test would break for the wrong reason (file storage)

- **Asked:** "Prove there is no URL that serves stored files directly."
- **Produced:** a test asserting that `/uploads/`, `/files/` and similar return a status other than 200.
- **What was wrong:** once the React app is built, the server returns the app's `index.html` for every unknown path (status 200), so the test would fail even though nothing leaks. That would push someone to "fix" the test by deleting it.
- **Caught by:** the AI, checking how the test would behave after the frontend step.
- **What we did instead:** the test now checks what actually matters: no file content (`%PDF`), no source code, no secrets and no `package.json` contents are ever returned, whatever the status.
- **Commit:** `ccf85d2`
