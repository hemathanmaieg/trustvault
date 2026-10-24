# TrustVault — write-up

## What we built

A document platform for confidential company files. Owners upload documents and share each one with named people as *read* or *edit*. Viewers see only what was shared with them. Administrators manage people and watch an audit trail they cannot alter, but cannot open any document.

The ten required features, and where each is:

| # | Requirement | Where |
| --- | --- | --- |
| 1 | Three roles, written down | README "Roles and permissions"; `server/src/authz.js` |
| 2 | Upload, organise, search, manage | Documents page; categories, versions, edit details, trash and restore |
| 3 | Per-document read and edit, to named people | `grants` table; "Who has access" panel |
| 4 | Owners grant and take back | `PUT` / `DELETE /api/documents/:id/grants/:userId` |
| 5 | No access means no read, download, change or delete | `documentAccess()` on every document route; 404 for all refusals |
| 6 | Audit of uploads, downloads, changes, deletions, permission changes | `audit_log`, plus views, sign-ins and every refused attempt |
| 7 | Search by name, owner, category, date | Documents page filters; `GET /api/documents` |
| 8 | Upload validation | `server/src/upload/validate.js` (type by content, size, name) |
| 9 | Admin view of activity and permission changes | Alerts, Activity log, Documents overview |
| 10 | Tests that one user cannot reach another's documents | `server/test/isolation.test.js` and 6 more files, 151 tests |

Beyond the floor: version history (every version protected and downloadable), trash with restore, a per-document activity view for owners, admin alerts (retries after revoke, repeated refusals, bulk downloads, locked accounts), a one-click audit chain check, account lockout and admin unlock, password change that signs out other devices, and a script that removes each of the 34 permission checks one at a time to prove the tests catch it.

## The permission model, in our own words

Access belongs to a document, never to a folder or a category. A document has exactly one owner, the person who uploaded it. The owner can add named people to it, each as *read* (open and download) or *edit* (also upload new versions and change the details). Only the owner can share, take access away, see the access list and activity, or delete. Nobody inherits access from anything; if your name is not on that document, it does not exist for you.

Roles sit above that. Only *owners* may upload. *Viewers* can only receive. *Administrators* run the system but are deliberately outside the document world: they cannot upload, cannot be given a document, and the code refuses them even if a grant row were planted in the database for them. That separation means "the admin can see everything" is not a hidden hole in our model.

The decision is made by the server on every request, from the database, at that moment. There is no permission stored in a token, no signed link, no cache. That is what makes revocation immediate, and it is what one function, `documentAccess()`, checks for every document route.

**What "immediately" costs us:** one extra database lookup on every request, and no caching of documents or permissions anywhere, including the browser (`Cache-Control: no-store`). For a document vault we think that is the right trade.

## What we deliberately did not build, and why

| Left out | Why |
| --- | --- |
| Sharing with people outside the company (public links) | The single riskiest feature: a link that works for anyone breaks rule one and makes revocation depend on link expiry. Outside partners can be added as viewer accounts instead. |
| Folder or group permissions | Inheritance is how "given one file, now sees forty" happens. Per-document grants are easier to prove correct. Groups would be the next feature, as a named list expanded into grants. |
| AI suggestions for who should see a document | Optional in the brief. With limited time we chose to spend it on the permission model and tests. If added, it would only suggest; the owner confirms, and both go into the audit log. |
| Self-registration | A company vault should not let strangers create accounts. Admins add people. |
| Permanent deletion and retention rules | Deleted documents stay in trash until restored. Deletion forever would need a retention policy and its own audit rules. |
| Virus scanning | No scanner is available on the free host. Files are checked by content type and always downloaded as attachments, never displayed by the site. |
| Encrypting files ourselves | Files sit in the database on the host's storage. Adding our own encryption with the key on the same server adds little; a separate key service would be the real fix. |
| Two-factor sign-in, single sign-on | Valuable for production, but outside the core of this brief. |

## How we used AI, and where it was wrong

We used an AI assistant (Claude) to plan, write code, write tests and draft documents, with a fixed set of security rules given at the start of every session (in PROMPTS.md). Every piece of output was checked by running it, by tests, or by review before it was accepted.

Where it was wrong (details and commits in PROMPTS.md):

- The **failed-login counter** was a read-then-write that parallel guesses could bypass. Fixed with one atomic SQL update, and a test with 12 parallel guesses.
- The first **"remove a check" markers** could not actually remove one of the checks, so the proof would have been false. Every check was reshaped into a yes/no function.
- **File names were decoded as Latin-1**, which let a right-to-left override character slip past the filter. Found by a test.
- A **logout test could pass without testing anything**. Rewritten to prove the cookie works before logout.
- **`npm test` did not run at all on Node 22**, and the **production build would have skipped Vite** on Render. Both caught before deployment.
- After all that, **a second, independent AI review** attacked the running app as a hostile judge and found what every test had missed:
  - Typing a document id in capital letters made the audit chain report tampering, so anyone could make the evidence worthless.
  - An editor revoked halfway through a slow upload could still add the new version.
  - Renaming a document wiped its description.
  - NUL bytes and invalid dates caused crashes that left no audit record.
  - Anonymous requests could flood the audit log.
  - An admin could demote themselves by typing their own id in capitals.

  All are fixed, each with a regression test (PROMPTS.md entries 6–12).

The lesson we took: code that passes every test deserves the most suspicion. Tests only check what someone thought of; an attacker, or a reviewer told to act like one, checks everything else.

## What is unfinished or weak

Honest list; each is also in THREATS.md with the reason it was accepted.

- An **administrator can reset an owner's password and sign in as them**. This is logged, signs the owner out (so they notice), and is flagged in the audit, but it is not prevented. A real fix needs a second approver or a reset link sent to the user's email.
- Someone with **full database control and the server's secret key** could rewrite the audit history. The keyed chain, the triggers and the head-hash lines in the host's logs make this hard and detectable, but not impossible.
- **Rate limits are per address.** A flood from many addresses at once is not stopped; that needs a firewall or CDN in front.
- **No malware scanning** of uploads.
- The free host **sleeps after 15 minutes**; the first request can take up to a minute.
