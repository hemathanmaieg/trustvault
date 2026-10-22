# Step 04 — Frontend (React)

**Date:** 2026-10-22
**Goal:** screens for every role, built so the browser never makes a permission decision.

## Principle

The React app only **shows** what the server allows. It never decides access. Hiding a button is a convenience; the server refuses the action anyway (that is what Step 03's tests prove). Every request goes through `client/src/api.js`, which sends the session cookie automatically and adds the `X-TrustVault-Request: 1` header to every change.

## Screens

| Screen | Who | What it does |
| --- | --- | --- |
| Sign in | Everyone | Email and password. States that 5 wrong passwords lock the account. |
| Documents | Owner, viewer | Search by name, owner, category and date range. Owners can filter "uploaded by me / shared with me" and upload. Each row shows your access as a stamp: Owner, Can edit, Can read. |
| Document page | Owner, viewer | Download latest or any version (with SHA-256 fingerprint). Editors: upload a new version, edit details. Owner: share with named people, change read/edit, remove access, see the document's activity (including refused attempts), move to trash. |
| Trash | Owner | Documents you deleted; restore brings back the earlier sharing. |
| Alerts | Admin | Retried after access was removed, 5+ refusals in 24 hours, 10+ downloads in an hour, locked accounts, access changes today, and the "Check the chain" button. |
| Activity log | Admin | Every audit entry, numbered, green for allowed and red for refused; filter by person, action, result, dates. |
| People | Admin | Add people, change role, disable/enable, unlock, reset password. |
| Documents (admin) | Admin | Titles, owner, how many people it is shared with, downloads, refusals, last activity. No download link exists for admins. |
| Password | Everyone | Change password; signs out every other device. |

## Design choices

- **Look:** a quiet, institutional registry. Cool grey background, white working surfaces, registry blue for actions. Teal only means "allowed" and red only means "refused", so colour always carries meaning.
- **Type:** Public Sans for the interface, Source Serif 4 for document titles. Both fonts are bundled with the app (no Google Fonts), so the strict Content Security Policy stays `default-src 'self'`.
- **Mobile:** the side menu becomes a tab row; the documents table hides secondary columns and shows a one-line summary instead.
- **Downloads** use plain links (`<a download>`). The browser sends the session cookie because it is same-site; the server makes the decision.

## How it was checked

Headless Chromium screenshots of sign-in, documents (desktop and 390 px phone), document page, alerts and activity log, reviewed by eye. Fixes made after looking:

1. File sizes wrapped onto two lines ("624 / B"): numbers no longer wrap.
2. The access dropdown was cut off: shortened to "Can read / Can edit", with a one-line explanation under it.
3. The phone table was unreadable: secondary columns hidden on small screens.
4. Viewers saw an "Uploaded by me" filter they can never use: the filter now shows only for owners.
5. Alerts text promised links that did not exist: reworded.

## A real bug found during this step

`npm test` was written as `node --test server/test/`. On Node 22 a folder argument is treated as a single file, so the command failed outright. The judges would have hit this on a clean clone. It is now `node --test "server/test/**/*.test.js"`, a quoted pattern Node expands itself, so it also works in Windows terminals.

## Run it

```bash
npm --prefix client install
npm --prefix client run build    # creates client/dist, served by the Express server
npm start                        # http://localhost:3000
# or, for live editing: npm run dev (API) + npm --prefix client run dev (http://localhost:5173)
```
