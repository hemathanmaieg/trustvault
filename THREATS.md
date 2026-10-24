# THREATS.md

How we think TrustVault could be broken, what we did about each, and what we knowingly accepted.

**How to read this.** Each threat has an id. Test names in `server/test/` start with the same id, so `npm test` output can be traced back here. "Tested" means automated tests fail if the protection is removed; `npm run test:authz-removal` proves this separately for every permission check (34 of 34 caught, see `docs/authz-removal-report.md`). An independent hostile review attacked the running system; its findings are fixed below and listed in PROMPTS.md entries 6–12. "Accepted" means we know the weakness is there and explain why we left it.

Status key: **Closed** (prevented and tested), **Mitigated** (made hard or detectable, not impossible), **Accepted** (known, deliberately left).

---

## A. Reaching a document you were not given (rule one)

| Id | Threat | How someone would try it | What we did | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| T01 | Insecure direct object reference | Change the document id in any URL or API call: view, download, edit, new version, delete, grants, activity | Every document route calls `documentAccess()` (guards.js), which loads the caller's grant from the database on that request and asks `authz.js`. No route touches a document any other way. | Closed | isolation T01 (10 tests), plus a removal test for each route |
| T02 | Direct file access | Guess a storage path, bucket URL or static file path | Files are stored inside PostgreSQL (`document_versions.content`). There is no file on disk, no bucket, no static route. The only way out is the checked download route. | Closed | isolation T02 |
| T09 | Search and list leaks | Search another user's titles, filter by their name, use SQL wildcards `%` `_` | Visibility is a SQL condition applied before any filter, **and** a second per-row check in code; wildcards are escaped. Each layer is tested on its own. | Closed | isolation T09 (8 tests) |
| T10 | Id probing | Compare responses for real and fake ids; send malformed or injected ids | Missing and forbidden both return the same `404 "Document not found"`. Ids are random UUIDs; anything else is rejected before the database. | Closed | isolation T10 |
| T11 | Reaching trashed documents | A grantee keeps using a deleted document; another user restores it; trash lists other people's deletions | Deleted documents fail `isDocumentLive` on every live route. Restore needs owner level. Trash lists only your own. | Closed | permissions T11 (5 tests) |
| T12 | Old versions as a side door | Request `?version=1` of a document after a new version | Every version goes through the same check as the latest. | Closed | isolation T12 |
| T13 | Administrator reads documents | Admin opens or downloads a document, or a grant row is planted for an admin | `roleMayHoldDocuments` refuses admins even if a grant row exists. There is no admin download route; the admin overview has titles and counts only. | Closed | isolation T13 (3 tests) |
| T22 | Unauthenticated access | Call any API without a session, or with a forged cookie | All `/api/documents`, `/api/users`, `/api/admin` routes require a valid server-side session; random cookies match nothing. | Closed | isolation T22 (8 tests) |
| T08 | Edit permission abused | An editor shares, revokes, raises their own access, deletes, or reads the access list | "Edit" only allows content and details. Sharing, revoking, delete, restore, access list and activity need `owner`. | Closed | permissions T08 (6 tests) |
| T07 | Role escalation and mass assignment | Viewer uploads; owner calls admin API; send `role: "admin"`, `owner_id` or `__proto__` in a body | Roles are checked on the server for every route. Edits use a strict schema that refuses unknown fields with 400; `owner_id` always comes from the session. | Closed | permissions T07 (4 tests) |
| T14 | Granting to the wrong person | Grant to an admin, to yourself, to a disabled or non-existent user, or with a made-up level | `canReceiveGrant` only allows active owners/viewers other than the owner; levels are `read` or `edit` only. | Closed | permissions T14 (7 tests) |
| T23 | People directory leaks | List all users, including admins, as a viewer | Only owners can use it (they need it to share); it never returns admins, the caller, or any hash. Max 20 results. | Closed | permissions T23 |

## B. Taking access away (rule three)

| Id | Threat | How someone would try it | What we did | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| T03 | Revoked user keeps access | Keep an open page or session after being removed; reuse an old download link | No signed URLs, no permissions inside tokens, no caching. The grant is read from the database on every request, so the next request after revoke is refused. | Closed | revocation T03 (3 tests) |
| T04 | Disabled employee keeps working | A disabled user's session stays open | Disabling deletes all their sessions, and every request re-checks `is_active` even if a session row survived. Disabled accounts cannot sign in. | Closed | revocation T04 (3 tests) |
| T05 | Old role keeps working | A demoted owner keeps uploading | The role is read from the database on every request; a role change ends all sessions. Promotion to admin removes grants, and is refused for anyone who still owns documents (they would be left with no manager). A demoted owner keeps managing documents they already own (by design: ownership belongs to the document). | Closed | revocation T05, hardening T05 |
| T06 | Sessions that never end | Reuse a stolen or forgotten session much later | 30-minute idle and 8-hour absolute limits, enforced on the server; expired rows are deleted. Logout deletes the session on the server. | Closed | revocation T06 (3 tests) |
| T26 | Password change leaves other sessions open | Attacker who knew the old password stays signed in | Changing a password ends every other session; an admin reset ends all of them. | Closed | revocation T26 (2 tests) |
| T27 | Revoke during a request already in progress | Start a slow upload or edit, get revoked halfway | Uploads and edits re-check the grant **inside** their transaction under a row lock that grant/revoke also take, so a revoke either completes first (and the write is refused and logged as `access_removed_during_request`) or waits for it. Downloads read the file bytes with the access condition in the **same SQL statement**. What remains: bytes already read from the database at the moment of revoke are still sent (microseconds). | Mitigated | hardening T03 (half-sent upload, revoke, rest of upload: refused) |

**What "immediately" costs:** one extra database read on every request, and no caching of documents or permissions anywhere. We chose correctness over speed.

## C. Proving who reached it (rule two)

| Id | Threat | How someone would try it | What we did | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| T21 | Missing evidence | An upload, download, change, deletion or access change leaves no record | Every one is recorded with who, what, which document, which version, file hash, IP and time, in the same transaction as the change. A download is recorded **before** the file is sent; if recording fails, nothing is sent. | Closed | audit T21 (7 tests) |
| T20 | Refused attempts not recorded | Probe ids, try to edit, call admin routes, guess passwords, send NUL bytes or broken UTF-8 so the log write itself fails | Every refusal is recorded with the reason, including anonymous requests, made-up ids (kept as `requested_id`), undecodable URLs (`malformed_request`) and failed sign-ins. Text is cleaned before storing so the log write cannot be made to crash. Owners see refusals on their own documents. | Closed | audit T20 (8), hardening T20 (3) |
| T19 | Quietly editing or deleting the log | `UPDATE`, `DELETE` or `TRUNCATE` audit rows | Database triggers refuse all three. There is no API that edits the log. | Closed | audit T19 (4 tests) |
| T44 | Breaking the chain on purpose with normal input | Send an id in UPPERCASE so the stored value differs from what was sealed, making verification fail and evidence worthless | Values are brought to their stored form before sealing, and every new entry is re-verified against the stored row before commit; any mismatch rolls the action back instead of entering the chain. | Closed | hardening T19 (6 tests) |
| T19b | Bypassing the triggers | Someone with database owner rights disables the trigger and edits a row, deletes one, or rewrites rows and recomputes hashes | Each row stores `HMAC-SHA256(key, previous hash + row)`. The key lives in the app's environment, not the database. Edits, deletions and re-hashing without the key are detected and the check names the entry. Sequence numbers have no gaps by design, so a missing number is visible. | Mitigated | audit T19 (3 tests simulate this attacker) |
| T28 | Attacker has the database **and** the secret key | Rewrite history and recompute every hash | Not preventable inside one server. We print each new head hash to the host's log stream (`[audit-anchor]`), which is stored outside the database. A rewritten chain no longer matches those lines. | Accepted | – |
| T29 | Deleting only the newest entries | Remove the last few rows, so no later row breaks | Same `[audit-anchor]` lines: compare the database head (`npm run verify-audit`) with the last anchor in the host's logs. | Mitigated | – |
| T24 | Admin cannot see what matters | Suspicious activity goes unnoticed | Alerts for retries after revoke, 5+ refusals in 24 h, 10+ downloads in an hour, locked accounts, and the count of access changes; filterable log; one-click chain check, itself logged. | Closed | audit T24 (3 tests) |

## D. Accounts and sessions

| Id | Threat | How someone would try it | What we did | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| T18 | Password guessing | Try many passwords, in parallel, or learn which emails exist | Same message for every failure; bcrypt runs even for unknown emails (measured: same timing for known and unknown); 5 failures lock the account for 15 min (atomic counter, safe in parallel); 20 **failed** tries per 15 min per address (successes do not count, so one office network does not lock itself out); strong password rule. | Closed | auth T18 (6 tests) |
| T17 | Cross-site request forgery | A malicious site makes the browser delete or share a document, or sign in as the attacker | SameSite=Strict cookie, plus a required custom header on every change; we never answer CORS preflights. | Closed | auth T17 (4 tests) |
| T25 | Stolen session tokens | Read session tokens from a database copy | Only SHA-256 hashes of tokens are stored; a hash used as a cookie does not work. | Closed | revocation T25 (2 tests) |
| T30 | Session stolen through the page | Script on the page reads the cookie | HttpOnly cookie; strict Content Security Policy (`script-src 'self'`); React escapes all text. | Closed | auth (header tests) |
| T31 | Session sent over plain HTTP | Network sniffing | In production the cookie is `Secure` with the `__Host-` prefix and HSTS is on. | Closed | – (production setting, checked by hand) |
| T32 | Clickjacking | Load TrustVault in a hidden frame | `frame-ancestors 'none'`. | Closed | auth (header test) |
| T33 | Administrator impersonates an owner | Admin resets Yugu's password and signs in as Yugu to read his files | Not prevented. It is recorded (`password_reset` then `login` from the admin's IP), and Yugu is signed out everywhere, so he notices. A real fix needs a reset link sent to the user or a second approver. | Accepted | – |

## E. Uploads and downloads

| Id | Threat | How someone would try it | What we did | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| T15 | Malicious or disguised uploads | Rename a program or HTML to `.pdf`; upload SVG/HTML/JS; empty or huge files; names like `../../etc/passwd` or right-to-left tricks | Allow-list of 7 types; the file's bytes must match its extension; 10 MB limit enforced while reading; names stripped of folders, control characters, quotes and bidirectional overrides (decoded as UTF-8). Same rules for new versions. | Closed | upload T15 (14 tests) |
| T16 | Uploaded file runs in the browser (stored XSS) | Upload HTML or SVG and make a victim open it | Downloads are always `attachment`, `application/octet-stream`, `nosniff`, with a `sandbox` CSP and `no-store`. Nothing is ever displayed inline by the site. | Closed | upload T16 |
| T34 | Malware inside an allowed file | A PDF or DOCX carrying an exploit | No virus scanning on the free host. Files are only ever downloaded, never opened by the server or the site. | Accepted | – |
| T35 | Files unencrypted at rest | Someone obtains a database backup | We rely on the host's storage protection. Encrypting with a key on the same server adds little; a separate key service would be the real fix. | Accepted | – |

## F. Platform and code

| Id | Threat | How someone would try it | What we did | Status | Tests |
| --- | --- | --- | --- | --- | --- |
| T36 | SQL injection | Quotes and SQL in ids, search fields, filters | Every query is parameterised; ids must be UUIDs; dates must match `YYYY-MM-DD`; categories come from a fixed list. | Closed | isolation T10, search tests |
| T37 | Error messages leak internals | Send broken JSON or odd input to see stack traces | One error handler returns plain messages only; no stack, SQL or paths. | Closed | auth tests |
| T38 | Secrets in the public repository | Read keys or passwords from GitHub | `.env` is git-ignored; the audit key is generated by Render; seed passwords are set in Render's dashboard. The demo passwords in the README are public **on purpose** (the brief requires them) and only unlock demo data. | Closed | – |
| T39 | Denial of service and audit flooding | Flood the API, fill the audit log with anonymous refusals, upload many large files | 300 requests/min per address, 30/min for callers not signed in, one audit entry per address per window when a limit is hit; bodies capped (50 KB JSON, 10 MB file); permission checked before a file body is read. A distributed flood from many addresses is not stopped (that needs a CDN or firewall in front). | Mitigated | hardening T39 (2 tests) |
| T40 | Vulnerable dependencies | Known bugs in npm packages | Few, widely used dependencies. The review's `npm audit` found one moderate advisory in `file-type` 16; upgraded to 22, after which `npm audit` reports 0 vulnerabilities. Re-run before submitting. | Closed | – |
| T41 | Metadata visible to people with access | Grantees see the owner's name and email; owners see who tried their document; admins see titles | By design: within a company these are needed to work. Admins see titles but never contents. | Accepted | – |
| T42 | Restore brings back old access | Owner trashes a document to cut someone off, later restores it | By design (restore is "undo"). The trash dialog says so, and the restore entry in the audit log lists every person who regains access. To cut someone off, the owner removes their access. | Accepted | hardening T42 |
| T43 | AI widening access | An AI suggestion, or instructions hidden in a document, grant access | We did not build the optional AI feature. If added: suggestions only, a person confirms, both logged. | Not applicable | – |

---

## How the tests prove they test something

`npm run test:authz-removal` takes each of the 34 marked checks (every function in `authz.js`, each guard in `guards.js` including the in-transaction re-check, the route mounts in `app.js`, and the `documentAccess()` call in each of the 10 document routes), removes **one**, runs all 151 tests on a copy of the code, and records whether a test failed. All 34 removals are caught. The report with the failing test for each is in `docs/authz-removal-report.md`.

## Attacks tried by the independent review that held

Run against the live server by a separate reviewer who had not written the code:

- **Another user's document, by id:** view, download, `?version=1`, grants, activity, edit, delete, grant and revoke as a viewer and as an admin. All refused with the same 404 for real and fake ids, each recorded with its reason.
- **An editor stepping outside edit:** listing access, reading activity, deleting, granting or revoking. All refused.
- **Path tricks:** trailing slash, `/DOWNLOAD`, `;x`, `%2F`, `//`, `./`, `../` with `--path-as-is`, `HEAD`. All gave 404 or nothing; `OPTIONS` reveals only the allowed methods.
- **CSRF:** `X-HTTP-Method-Override`, a `text/plain` body, header value `"1, 1"`, and login/logout without the header. All refused.
- **Type confusion and prototype pollution:** `permission` as an array, an object, `"owner"` or `"EDIT"`; `__proto__` and `constructor.prototype` payloads; a title as an array. All refused; no role change happened.
- **Search:** wildcards, array parameters, owner/category/scope combinations, search after revoke. Nothing outside the user's own visible set appeared.
- **Version parameter:** `0`, `-1`, huge numbers, empty, letters, duplicates. All refused. Odd spellings of `1` read version 1 only after the permission check.
- **Sessions:** forged cookies, session fixation (a fresh token on every login), disabling a user mid-session (refused on the next request).
- **Lockout:** 8 parallel wrong passwords. The account locked, and the correct password was then refused.
- **Uploads:** disguised PDFs and DOCX files, a program renamed `.pdf`, right-to-left-override names, empty, oversized and multiple files, binary disguised as CSV. All refused.
- **Download headers:** attachment, `octet-stream`, `nosniff`, sandbox CSP, `no-store`.
- **Client:** nothing security-relevant stored in the browser; no raw HTML rendering; every action re-checked by the server.
- **Audit under concurrency:** 200 parallel writes left no gaps in the sequence and an intact chain.
