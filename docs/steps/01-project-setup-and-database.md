# Step 01 — Project setup and database design

**Date:** 2026-10-22
**Goal:** create the project, choose the stack, and design the database so the security rules are built in from the start.

## What was done

1. Created the repository `trustvault/` with Git.
2. Chose the stack: **Node.js 20+ / Express** (API), **PostgreSQL** (data and files), **React + Vite** (screens, built in a later step).
3. Installed server packages:

   | Package | Why |
   | --- | --- |
   | express | Web server and routing |
   | pg | PostgreSQL client |
   | bcryptjs | Password hashing |
   | helmet | Security headers (CSP, no framing, HSTS) |
   | multer | Reading uploaded files into memory |
   | file-type | Checking a file's real type from its bytes |
   | cookie-parser | Reading the session cookie |
   | express-rate-limit | Slowing down password guessing |
   | zod | Validating every input |
   | dotenv | Loading settings from `.env` |
   | supertest (dev) | Calling the API from tests |

4. Wrote `server/db/schema.sql` with six tables:

   | Table | Holds |
   | --- | --- |
   | `users` | People, their role (admin / owner / viewer), active flag, failed-login counter |
   | `sessions` | One row per signed-in browser. Only a SHA-256 of the token is stored |
   | `documents` | Title, category, owner, deleted flag |
   | `document_versions` | Every version of every file, **the file bytes themselves**, size, SHA-256 |
   | `grants` | Who may `read` or `edit` which document |
   | `audit_log` | Every action and every refused attempt, hash-chained |

5. Wrote `server/db/migrate.js` (applies the schema, safe to run twice).

## Key decisions and why

- **Files are stored inside the database**, not on disk or in a public bucket. There is no URL that reaches a file directly; the only way out is the download endpoint, which checks permission first. It also survives Render's free tier, where disk is wiped on every deploy. Cost: the database grows with the files, so uploads are capped at 10 MB.
- **Per-document grants only.** Categories organise documents but never give access. This avoids the "given one folder, now sees forty files" problem from the brief.
- **Audit log is append-only.** Database triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log`. `document_id` has no foreign key on purpose, so attempts against made-up IDs are still recorded.
- **Sessions are stored on the server.** Logging someone out, disabling them, or changing their role deletes their session rows, which takes effect on their next click.

## How it was checked

```
node server/db/migrate.js   # run twice: both succeed
psql ... -c "update audit_log set action='y'"
# ERROR:  audit_log is append-only: UPDATE is not allowed
```

## Files

- `server/db/schema.sql`, `server/db/migrate.js`
- `server/src/config.js`, `server/src/db.js`
- `.env.example`, `.gitignore`, `package.json`
