# TrustVault API

Base path: `/api`. All bodies are JSON unless marked *multipart*.

## Rules that apply to every endpoint

- **Sign-in:** a session cookie (`__Host-tv_session` in production, `tv_session` locally), HttpOnly, Secure, SameSite=Strict. The session and the user's current role and active flag are re-read from the database on **every** request.
- **Changes need a header:** every `POST`, `PUT`, `PATCH` and `DELETE` must send `X-TrustVault-Request: 1`, or it gets `403` (cross-site request protection).
- **Document routes answer `404 "Document not found"`** both when the document does not exist and when you may not touch it, so ids cannot be probed. Every refusal is written to the audit log.
- **Rate limits:** 300 requests a minute per address; 30 a minute for callers who are not signed in. Over the limit: `429`.
- **Ids:** document and user ids are UUIDs, accepted in any letter case.
- **Text:** NUL characters and broken Unicode in queries or bodies are refused with `400`.
- **Who decides:** every permission decision is a function in `server/src/authz.js`, applied by `server/src/guards.js`.

### Access levels on a document

| Level | Who | Allows |
| --- | --- | --- |
| `owner` | The person who uploaded it | Everything below, plus share, change access, revoke, see access list and activity, delete, restore |
| `edit` | Granted by the owner | Read, plus upload new versions and change title, category, description |
| `read` | Granted by the owner | View details and versions, download any version |

Administrators never hold any level on any document.

---

## Authentication

| Method | Path | Who may call | Body / query | Result |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/login` | Anyone (20 **failed** tries per 15 min per address) | `{ email, password }` | `200 { user }` and sets the cookie. `401` with one generic message for wrong password, unknown email, locked or disabled account. 5 wrong passwords lock the account for 15 minutes. |
| POST | `/api/auth/logout` | Anyone | – | Deletes the session on the server and clears the cookie. |
| GET | `/api/auth/me` | Signed in | – | `{ user: { id, email, name, role } }` |
| POST | `/api/auth/password` | Signed in | `{ currentPassword, newPassword }` | Changes password (12+ characters, letters and numbers) and signs out every other session. |
| GET | `/api/health` | Anyone | – | `{ ok: true }` (used by the host) |

## Documents

| Method | Path | Who may call | Body / query | Result |
| --- | --- | --- | --- | --- |
| GET | `/api/documents` | Owner, viewer (admins always get an empty list) | `q` (name), `owner` (name or email), `category`, `from`, `to` (YYYY-MM-DD), `scope` = `all` \| `mine` \| `shared` | Only documents you own or were granted, each with `myAccess`. |
| GET | `/api/documents/categories` | Signed in | – | The fixed category list. |
| POST | `/api/documents` | Role **owner** only | *multipart*: `file`, `title`, `category`, `description` | `201 { id }`. File checked: max 10 MB; pdf, png, jpg, docx, xlsx, txt, csv; content must match the extension; name cleaned. |
| GET | `/api/documents/trash` | Signed in (shows only documents **you own**) | – | Your deleted documents. |
| GET | `/api/documents/:id` | Level **read** or higher | – | Details, version list, and `can: { edit, manage }`. Logged as `view`. |
| PATCH | `/api/documents/:id` | Level **edit** or higher | any of `{ title, category, description }` (any other field: 400) | Changes only the fields sent; old and new values are logged. Access is re-checked inside the write. |
| POST | `/api/documents/:id/versions` | Level **edit** or higher | *multipart*: `file` | `201 { version }`. Permission is checked before the file is read, and again inside the write: if access was removed during the upload, it is refused. |
| GET | `/api/documents/:id/download?version=N` | Level **read** or higher | `version` optional (default latest) | The file, as an attachment (`application/octet-stream`, `nosniff`, sandbox CSP, no caching). The download is logged **before** the file is sent. |
| DELETE | `/api/documents/:id` | Level **owner** | – | Moves to trash. Every grantee loses access at once. |
| POST | `/api/documents/:id/restore` | Level **owner**, document must be in trash | – | Restores it, with its earlier grants. |
| GET | `/api/documents/:id/grants` | Level **owner** | – | Who has access, at which level, granted by whom. |
| PUT | `/api/documents/:id/grants/:userId` | Level **owner** | `{ permission: "read" \| "edit" }` | Grants or changes access. The person must be an active owner or viewer, not an admin and not yourself; otherwise `400`. |
| DELETE | `/api/documents/:id/grants/:userId` | Level **owner** | – | Removes access. Takes effect on that person's very next request. |
| GET | `/api/documents/:id/activity` | Level **owner** | – | Audit entries for this document, including refused attempts. |

## People directory

| Method | Path | Who may call | Query | Result |
| --- | --- | --- | --- | --- |
| GET | `/api/users/directory` | Role **owner** only | `q` (name or email) | Up to 20 active owners and viewers (never admins, never yourself), for choosing who to share with. |

## Administration (role admin only)

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | – | All users (never password hashes), with lock status. |
| POST | `/api/admin/users` | `{ email, name, role, password }` | Creates a user. Strong password required; duplicate email `409`. |
| PATCH | `/api/admin/users/:id` | any of `{ name, role, active, unlock: true }` | Role change or disable **ends all of that person's sessions immediately**. Promoting to admin removes their grants. You cannot change your own role or disable yourself. |
| POST | `/api/admin/users/:id/password` | `{ password }` | Sets a new password and ends all their sessions. |
| GET | `/api/admin/audit` | `action`, `outcome`, `actor`, `document` (id), `from`, `to`, `page` | Audit entries, newest first, 100 per page. |
| GET | `/api/admin/audit/verify` | – | `{ ok, checked, headSeq, headHash }` or `{ ok: false, problem }`. Running it is itself logged. |
| GET | `/api/admin/alerts` | – | Retries after revoke, 5+ refusals in 24 h, 10+ downloads in 1 h, locked accounts, access changes in 24 h. |
| GET | `/api/admin/documents` | – | Titles, owner, grant count, downloads, refusals, last activity. **No contents and no download route.** |

There is deliberately **no endpoint that edits or deletes audit entries**.

## Errors

`{ "error": "plain message" }` with status 400 (invalid input), 401 (not signed in), 403 (role not allowed, or missing request header), 404 (not found or not allowed), 409 (duplicate), 413 (body too large), 429 (too many requests), 500 (unexpected; no internals are returned).

## Audit actions

`login`, `logout`, `account_locked`, `password_change`, `password_reset`, `upload`, `new_version`, `view`, `download`, `update_details`, `delete`, `restore`, `grant`, `grant_change`, `revoke`, `list_grants`, `view_activity`, `user_create`, `user_update`, `audit_verify`, `unauthenticated_request`, `csrf_check`, `admin_access`, `user_directory`, `rate_limit`, `malformed_request`. Each has `outcome` = `allowed` or `denied`.
