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

---

## How the independent review was set up (reused prompt)

After the first version passed all 131 tests, a **separate AI agent that had not written the code** was given this brief, and access to the running server with the demo accounts:

```text
You are an independent security reviewer acting like a hostile judge. You did not write this code.
Your job is to find ways to break it, not to praise it. [The three rules from the brief.]
Read authz.js, guards.js, routes, session.js, audit.js, validate.js. Actively attack the running
server with curl: IDOR, parameter tampering, path tricks, encoded or differently-cased ids, JSON
type confusion, prototype pollution, races between revoke and download, CSRF bypass, enumeration,
huge or malformed inputs. Do NOT modify files. Report each finding with severity, file:line,
a reproduction, why it matters for the judging rules, and a fix. Separate "confirmed by exploiting"
from "suspected". Also list what you tried that held.
```

Every test still passed while all of the problems below existed. That is the main lesson of this file.

## Entry 6 — 2026-10-22 — Anyone could make the audit chain report tampering (audit trail)

- **Asked (original prompt):** "Write an append-only audit log where each row stores an HMAC of the previous hash plus the row, and a verify function."
- **Produced:** `audit.record()` computed the HMAC over the values **as JavaScript held them**, then inserted them.
- **What was wrong:** PostgreSQL stores `uuid` values in lowercase. A user who requested `/api/documents/9AA197E4-.../download` (uppercase) produced an entry sealed over the uppercase id but stored in lowercase, so verification reported "Entry #43 was altered after it was written". Any signed-in user could break the evidence on demand, after which real tampering could no longer be told apart. The same applied to user ids in revoke and password reset.
- **Caught by:** the independent reviewer, by exploiting it on the running server and recomputing the HMAC by hand.
- **What we did instead:** every value is brought to its stored form before sealing (uuids lowercased, NUL and broken UTF-16 replaced, details round-tripped through JSON). After inserting, the writer **reads the stored row back and re-verifies the seal**, and if it does not match, the whole action rolls back. A representation mismatch can now fail a request, but can never reach the chain. Ids are also normalised once per route with `router.param`.
- **Tests:** `hardening.test.js` T19 (6 tests).
- **Commit:** `7672e87`

## Entry 7 — 2026-10-22 — A revoked editor's upload in progress still went through (revocation)

- **Asked:** "Upload a new version: check edit permission first, then read the file, then store it in a transaction."
- **Produced:** the permission check ran once, before the body was read; the transaction only re-checked that the document was not deleted.
- **What was wrong:** with a throttled upload (`curl --limit-rate 50k`), the owner revoked the editor 2 seconds in, the revoke returned 200, and the upload still committed version 2 four seconds later. The audit log even showed `revoke` followed by `new_version allowed`. That breaks rule three.
- **Caught by:** the independent reviewer, by exploiting it.
- **What we did instead:** inside the write transaction, `recheckInTransaction()` locks the document row (`FOR UPDATE`) and re-reads the grant; grant and revoke take the same lock, so the two are serialised. The same applies to editing details. Downloads now read the file bytes with the access condition repeated **in the same SQL statement**.
- **Tests:** `hardening.test.js` T03 sends half an upload, revokes, sends the rest, and expects 404, no new version and an `access_removed_during_request` audit entry. The new check has its own removal marker.
- **Commit:** `7672e87`

## Entry 8 — 2026-10-22 — Defence in depth hid a check from the removal test (testing)

- **Asked (myself, after entry 7):** "Re-run the removal script with the new check."
- **Produced:** 32/34 caught. Removing the **first** permission check on edit and on new-version was no longer caught, because the new second check also refused.
- **What was wrong:** nothing leaked, but the first gate has its own job: it refuses **before** a 10 MB upload body is read. The tests no longer proved it worked, and the brief's test ("take one check out, run the tests") would have scored those as untested.
- **Caught by:** the removal script.
- **What we did instead:** added a test that checks **which** gate refused: the audit reason must be `no_permission` (first gate), not `access_removed_during_request` (second). 34/34 caught.
- **Commit:** `7672e87`

## Entry 9 — 2026-10-22 — Renaming a document silently wiped its description (data integrity, audit)

- **Asked:** "PATCH /documents/:id to change title, category or description; edit permission required."
- **Produced:** a PATCH schema made with `metaSchema.partial()`, reusing the upload schema.
- **What was wrong:** the upload schema had `description: ...default('')`. `.partial()` keeps defaults, so a PATCH with only a title set the description to `''`, and the audit entry recorded a description change nobody made. An editor renaming a file erased the owner's notes.
- **Caught by:** the independent reviewer.
- **What we did instead:** PATCH has its own schema with no defaults, and `.strict()`, so unknown fields like `owner_id` are refused with 400 instead of being silently ignored. The earlier test expecting them to be ignored was changed to expect a refusal.
- **Tests:** `hardening.test.js` T08, `permissions.test.js` T07.
- **Commit:** `7672e87`

## Entry 10 — 2026-10-22 — Some refused attempts crashed instead of being recorded (audit trail)

- **Asked:** "Record every refused attempt, including malformed ids."
- **Produced:** malformed ids were stored in `details.requested_id`.
- **What was wrong:** an id containing a NUL byte (`%00`) or invalid UTF-8 (`%ED%A0%80`) made PostgreSQL reject the audit insert itself, so the request returned 500 and **left no record**. Impossible dates like `2026-13-45` passed the format check and crashed the date cast. A login email containing `\u0000` crashed before the failed-login entry was written.
- **Caught by:** the independent reviewer.
- **What we did instead:** text is cleaned before it is sealed; a middleware refuses NUL and broken UTF-16 in queries and bodies with 400; undecodable URLs are logged as `malformed_request` and answered with 400; dates are checked as real calendar dates.
- **Tests:** `hardening.test.js` T20 (3 tests).
- **Commit:** `7672e87`

## Entry 11 — 2026-10-22 — Anyone on the internet could flood the audit log (availability, audit)

- **Asked:** "Log unauthenticated requests to document routes."
- **Produced:** one audit write per unauthenticated request, with no limit.
- **What was wrong:** 200 parallel anonymous requests added 200 rows. Every audit write takes one global lock, so a flood also stalled real uploads and downloads. Separately, the login limiter counted **successful** sign-ins, so a few judges behind one office network could lock each other out.
- **Caught by:** the independent reviewer.
- **What we did instead:** a per-address limit on the whole API (300/min), a tighter one for callers who are not signed in (30/min), and a login limit that counts failures only. When a limit is first hit, **one** audit entry is written for that window.
- **Tests:** `hardening.test.js` T39 (2 tests: the cut-off happens at the limit, with exactly one audit entry).
- **Commit:** `7672e87`

## Entry 12 — 2026-10-22 — An admin could demote themselves by typing their id in capitals (access control)

- **Asked:** "An admin must not be able to change their own role or disable themselves."
- **Produced:** `if (req.params.id === req.user.id && ...) refuse`.
- **What was wrong:** a plain string comparison. The same id in uppercase is a different string but the same user, so the check was skipped.
- **Caught by:** the AI, while fixing entry 6 (it went looking for every other place that compared ids as raw strings).
- **What we did instead:** ids are lowercased once at the router (`router.param`) before any handler sees them.
- **Tests:** `hardening.test.js` "an admin cannot demote themselves by writing their own id in UPPERCASE".
- **Commit:** `7672e87`
