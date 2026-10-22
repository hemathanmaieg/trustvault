# TrustVault

Secure document sharing where the wrong person cannot reach a file, and where you can prove exactly who did.

Built for the Snovasys Fresher Hiring Challenge 2026.

- **Live demo:** `https://<your-service>.onrender.com` *(fill in after deploying, see DEPLOY.md)*
- **Demo video:** *(link)*
- **Write-up:** [WRITEUP.md](WRITEUP.md) · **Threats:** [THREATS.md](THREATS.md) · **AI use:** [PROMPTS.md](PROMPTS.md) · **API:** [API.md](API.md) · **Deploy:** [DEPLOY.md](DEPLOY.md)

## Demo accounts

| Role | Email | Password | What to try |
| --- | --- | --- | --- |
| Administrator | `admin@trustvault.demo` | `AdminDemo2026!` | Alerts, activity log, "Check the chain", disable a user |
| Document owner | `owner@trustvault.demo` | `OwnerDemo2026!` | Owns 3 documents; share, revoke, see activity |
| Document owner | `owner2@trustvault.demo` | `OwnerDemo2026!` | Owns 2 documents; can edit Omar's Acme contract |
| Viewer | `viewer@trustvault.demo` | `ViewerDemo2026!` | Can read only the salary letter |
| Viewer | `viewer2@trustvault.demo` | `ViewerDemo2026!` | Can read only Olivia's two documents |

The second owner and viewer exist so "one user cannot reach another user's documents" can be tried by hand. Five wrong passwords lock an account for 15 minutes; an admin can unlock it from **People**.

| Seeded document | Owner | Shared with |
| --- | --- | --- |
| Salary letter - Vikram | owner@ | viewer@ (read) |
| Customer contract - Acme Ltd | owner@ | owner2@ (edit) |
| Board notes - private | owner@ | nobody |
| Bridge drawing notes | owner2@ | viewer2@ (read) |
| Audit papers Q3 | owner2@ | viewer2@ (read) |

## Roles and permissions

| Role | Can | Cannot |
| --- | --- | --- |
| **Administrator** | Add people, change roles, disable/enable, unlock, reset passwords. Read the whole audit log, verify its integrity, see alerts. See document titles and activity counts. | Upload. Be given any document. Open or download any document's contents. |
| **Document owner** | Upload documents and own them. Share each one with named people as *read* or *edit*, change or remove that access, see who opened it, move it to trash and restore it. Be given other people's documents. | Touch documents they own nothing of and were not given. |
| **Viewer** | Read or edit documents that were shared with them, at the level given. | Upload. Share anything. |

On each document: **owner > edit > read**.
- *Read:* view details, download any version.
- *Edit:* read, plus upload a new version and change the title, category and description.
- *Owner:* edit, plus share, change access, revoke, see the access list and activity, delete, restore.

Access is **per document, to named people only**. Categories organise documents; they never grant access, so being given one file never reveals forty others.

## How the three rules are met

1. **Only people who were granted a document can reach it.** Every document request goes through one function, `documentAccess()` in `server/src/guards.js`, which loads the document and the caller's grant from the database at that moment and asks `server/src/authz.js`. Files live inside the database, so no URL leads to them except the checked download route. Missing and forbidden documents get the same `404`.
2. **We can prove who reached it.** Every upload, download, view, change, deletion and access change is recorded, along with every refused attempt (including unauthenticated ones and probes for made-up ids). The log is append-only (database triggers refuse `UPDATE`, `DELETE`, `TRUNCATE`), and each entry carries a keyed hash of the previous one (HMAC-SHA256, key held outside the database). An admin can verify the chain in one click.
3. **Taking access away works immediately.** There are no signed links, no permission-carrying tokens and no caches. Revoking, deleting a document, disabling a person or changing their role takes effect on that person's very next request, in the same session.

**Where is the download decision made?** `server/src/routes/documents.js`, in the download route, at the line `const access = await documentAccess(req, res, { need: 'read', action: 'download' })`. Remove it and any signed-in user could download any document by id. 17 tests fail when that happens (see `docs/authz-removal-report.md`).

## Tests

```bash
npm test                      # 149 tests: isolation, permissions, revocation, audit, uploads, sign-in, hardening
npm run test:authz-removal    # removes each of 34 permission checks, one at a time; every removal is caught
```

Test names start with the THREATS.md id they cover.

The code was also attacked by an independent reviewer that had not written it; what it found and how each was fixed is in PROMPTS.md (entries 6–12) and THREATS.md.

## Run it locally

See [DEPLOY.md](DEPLOY.md). In short, with PostgreSQL running:

```bash
psql -U postgres -f server/db/create-local-db.sql
cp .env.example .env
npm install && npm run setup && npm run build && npm start   # http://localhost:3000
```

## Stack and why

| Part | Choice | Why |
| --- | --- | --- |
| API | Node.js + Express | Small, readable, one language across the app; every route is easy to trace in an interview |
| Database | PostgreSQL | Real transactions and row locks (versions, audit chain), triggers for the append-only log, and it holds the files too |
| Files | Stored in the database (`bytea`) | No public bucket or file path exists to leak; survives free hosting with no disk |
| Screens | React + Vite | Only displays what the API allows; makes no security decisions |
| Hosting | Render (web service + PostgreSQL) | One `render.yaml`, HTTPS by default, free tier |

## Project structure

```text
server/
  src/
    authz.js          every permission decision
    guards.js         applies them: sign-in, roles, CSRF, documentAccess()
    audit.js          hash-chained audit log + verification
    auth/             sessions and passwords
    upload/           upload validation
    routes/           auth, documents, users, admin
    app.js, config.js, db.js, errors.js
  db/                 schema.sql, migrate.js, seed.js, create-local-db.sql
  test/               149 tests
  scripts/            authz-removal-check.js, verify-audit.js
client/               React app
docs/                 build log (steps/), authz removal report, demo script, interview prep
```
