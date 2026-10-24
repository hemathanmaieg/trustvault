# Interview preparation

The brief says shortlisted candidates walk through their own code and make a change live. It also says one question is certain, and that if you cannot answer it, nothing else helps. Start there.

---

## 1. "Where is the authorisation decision made when someone downloads a file, and what happens if that line is removed?"

Walk it top to bottom, opening each file:

1. **`server/src/app.js`**: `/api/documents` is mounted behind `requireAuth`. No session means a 401.
2. **`server/src/auth/session.js` → `loadSession`**: on every request it hashes the cookie, finds the session row, joins the user, and calls `authz.isSessionUsable` (not expired, not idle, user still active). Otherwise `req.user` stays empty.
3. **`server/src/routes/documents.js`**, the download route. **This line is the decision:**
   ```js
   const access = await documentAccess(req, res, { need: 'read', action: 'download' });
   ```
4. **`server/src/guards.js` → `documentAccess`**: it runs `authz.documentAccessQuery`, which loads the document **and this user's grant from the database right now**. It then asks `authz.isDocumentLive`, `authz.levelFor` and `authz.canRead`. If any says no, it writes a `denied` audit entry and answers 404.
5. Back in the route, the file bytes are read with the access condition **repeated in the same SQL statement**. The download is written to the audit log **before** the file is sent.

**If that line were removed:** any signed-in user could download any document by its id, including old versions. 17 tests fail when it is removed (`docs/authz-removal-report.md`, row `route_download`). Show this live:

```bash
npm run test:authz-removal -- route_download
```

## 2. Questions you will likely get, with short answers

**Why per-document grants and not folders?**
Folder inheritance is how someone "given one file can now see forty". Per-document grants are easy to reason about and test. Groups would be next, expanded into per-document grants.

**What does "remove access immediately" mean in your design, and what does it cost?**
No signed URLs, no permissions inside tokens, no caching. Every request reads the grant from the database. Writes in progress re-check it inside their transaction under a row lock that revoke also takes. Cost: one extra database read per request, and nothing can be cached.

**How is the audit trail protected?**
Three layers:
- Database triggers refuse `UPDATE`, `DELETE` and `TRUNCATE`.
- Each row stores an HMAC of the previous row's hash plus its own content. The key is outside the database, so editing, deleting or re-hashing is detected, and the check names the entry.
- Each new head hash is printed to the host's logs, outside the database, so deleting the newest rows can also be caught.

What remains: someone with the database **and** the key. Say that openly; it is in THREATS.md (T28).

**Why store files in the database?**
No file path or bucket URL exists to leak, so the checked route is the only way out. It also works on free hosting with no disk. Cost: database size, so uploads are capped at 10 MB.

**Can the admin read documents?**
No. Admins cannot be given grants, and `roleMayHoldDocuments` refuses them even if a grant row is planted in the database (tested). The weakness to admit: an admin can reset an owner's password and sign in as them. It is logged and signs the owner out, but it is not prevented (T33).

**How do you know your tests test anything?**
`npm run test:authz-removal` removes each of the 34 checks one at a time and runs all 151 tests. Every removal is caught.

**Why Node/Express and PostgreSQL?**
Small and readable, so every route can be traced in an interview. PostgreSQL gives transactions and row locks (versions, revoke races), triggers for the append-only log, and it stores the files.

**Where was the AI wrong?**
Pick two from PROMPTS.md and explain them in your own words:
- **Entry 6:** an uppercase id broke the audit chain.
- **Entry 7:** a revoked editor's upload still went through.

Explain how each was found, and how the test now proves it is fixed.

## 3. Likely "make a change live" tasks, and where to make them

| Task | Where | Then |
| --- | --- | --- |
| Add a new permission level (e.g. `comment`) | `schema.sql` enum `grant_permission`; `authz.js` `LEVELS` and a `canComment`; grant schema in `routes/documents.js`; dropdown in `DocumentDetail.jsx` | Add a test like the T08 ones; add an `// AUTHZ:` marker |
| Let editors see the access list | `routes/documents.js` grants GET: `need: 'manage'` → `need: 'edit'` | Update the T08 test that expects 404 |
| Add a new category | `server/src/categories.js` and the `CATEGORIES` lists in the client | – |
| Make documents expire after N days | Add `expires_at` to `documents`; check it in `authz.isDocumentLive` | One test: expired document gives 404 |
| Add an alert | `routes/admin.js` `/alerts`, one more query; one card in `Admin.jsx` | – |
| Change the lockout to 3 attempts | `config.js` `login.maxFailures` | The T18 test loops 5 times; change it to 3 |

Always finish with `npm test`.

## 4. Practise beforehand

1. Run the app locally and sign in as each demo account.
2. Read `server/src/authz.js` from top to bottom. It is short, and every check has a comment.
3. Break one check on purpose (for example make `canRead` return `true`), run `npm test`, and read which tests fail. Then undo it.
4. Explain the download path (section 1) out loud, without notes, in under two minutes.
