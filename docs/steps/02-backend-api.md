# Step 02 — Backend: login, permissions, documents, audit

**Date:** 2026-10-22
**Goal:** build the API so that every rule in the brief is enforced by the server.

## The files and what each one does

| File | Role |
| --- | --- |
| `server/src/authz.js` | **Every permission decision.** Nothing else in the code compares roles or owner ids. |
| `server/src/guards.js` | Middleware that applies those decisions: sign-in required, admin only, CSRF header, and `documentAccess()` for every document route |
| `server/src/audit.js` | Writes and verifies the hash-chained audit log |
| `server/src/auth/session.js` | Creates, loads and ends server-side sessions |
| `server/src/auth/passwords.js` | bcrypt hashing and password strength |
| `server/src/upload/validate.js` | Checks every uploaded file |
| `server/src/routes/auth.js` | Sign in, sign out, change password |
| `server/src/routes/documents.js` | Search, upload, details, edit, versions, download, trash, sharing, activity |
| `server/src/routes/users.js` | People directory for owners choosing who to share with |
| `server/src/routes/admin.js` | Users, audit log, chain check, alerts, document overview |
| `server/src/app.js` | Wires it all together with security headers |
| `server/db/seed.js` | 5 demo accounts and 5 documents with different sharing |

## How a download is decided (the interview question)

1. `loadSession` (session.js) reads the cookie, looks the session up in the database, and checks it is not expired and the user is still active (`authz.isSessionUsable`).
2. `requireAuth` refuses anyone not signed in, and logs the attempt.
3. In `routes/documents.js` the download handler calls **`documentAccess(req, res, { need: 'read', action: 'download' })`**.
4. `documentAccess` (guards.js) loads the document **and the caller's grant from the database right now**, then asks `authz.isDocumentLive`, `authz.levelFor` and `authz.canRead`.
5. If any answer is no, it writes a `denied` audit entry and returns **404 "Document not found"**, the same answer as for an id that does not exist.
6. If yes, the download is written to the audit log **before** the file is sent. If that write fails, nothing is sent.

If the `documentAccess` line were removed, any signed-in user could download any document by its id. The tests in Step 03 fail when that happens.

## Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Admin | Create users, change roles, disable/enable, unlock, reset passwords; read the whole audit log; verify the chain; see alerts; see document titles and activity counts | Upload, be granted documents, read or download any document's contents |
| Owner | Upload; manage their own documents; share and revoke; be granted other people's documents | Act on documents they were not granted |
| Viewer | Read or edit documents granted to them | Upload; share anything |

Per document: **owner** (uploader) > **edit** (read + new version + change details) > **read** (view + download). Only the document owner can share, revoke, delete, restore, or see the access list and activity.

## Other protections built in

- Same 404 answer for "missing" and "forbidden" so ids cannot be probed.
- CSRF: `SameSite=Strict` cookie + required `X-TrustVault-Request: 1` header on every change.
- Login: generic error message, bcrypt even for unknown emails (equal timing), atomic failure counter, 15-minute lock after 5 failures, 30 attempts per 15 minutes per IP.
- Sessions: 30-minute idle, 8-hour maximum; role change, disable, and password reset end all sessions.
- Upload: max 10 MB; only pdf, png, jpg, docx, xlsx, txt, csv; the bytes must match the extension; file name stripped of folders and control characters; downloads always sent as an attachment with `nosniff` and a sandbox CSP, so an uploaded file can never run as a web page.
- Search applies the visibility condition in SQL, then checks each row again in code.
- Permission is checked **before** a new version's file body is read.

## Mistake caught while building

The first version of the failed-login counter read the count, added one in JavaScript, and wrote it back. Ten wrong passwords sent at the same moment could all read the same old count and never trigger the lock. Fixed by doing the increment inside one SQL `UPDATE ... SET failed_logins = failed_logins + 1`.

## Manual check on the running server

| Attempt | Result |
| --- | --- |
| Viewer downloads a private document by id | 404, logged as `denied / no_permission` |
| Viewer downloads the salary letter shared with them | File returned, logged as `download / allowed` |
| Owner revokes; viewer retries in the **same session** | 404 immediately, logged as `denied` |
| Delete request without the CSRF header | 403, logged as `csrf_check / denied` |
