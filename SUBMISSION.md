# TrustVault — Submission answers

The answers given in the Snovasys Fresher Hiring Challenge 2026 submission form, kept here so they can be read alongside the code.

- **Live demo:** https://trustvault-7apy.onrender.com
- **Code:** https://github.com/hemathanmaieg/trustvault
- **Demo logins:** see [README.md](README.md) or [logins.xlsx](logins.xlsx)

---

## Title

TrustVault – Secure Document Sharing with a Tamper-Evident Audit Trail

## One-line description

TrustVault shares confidential documents only with the people you choose, and logs every access.

## Summary

TrustVault is a secure document platform for confidential company files. Owners upload documents and share each one with named people as read or edit; viewers see only what was shared with them; administrators manage people and watch the audit trail but cannot open other people's documents.

The three rules are enforced by the server on every request:

1. A document is reachable only by someone granted it, through any route. There is one central permission check, files are stored in the database with no direct URL, and missing and forbidden documents get the same "not found" answer.
2. Every access and every refused attempt is recorded in an append-only, hash-chained audit log that detects tampering.
3. Revoking access, disabling a user or changing a role takes effect on the very next request.

Built with Node.js/Express, PostgreSQL and React. It has 151 automated tests, plus a script that removes each of the 34 permission checks one at a time and proves a test fails every time. An independent hostile review found 9 issues the tests had missed; all are fixed and documented in PROMPTS.md and THREATS.md.

## Contact

*(her email address or GitHub profile)*

---

## 1. The problem you solved

A company needs to share confidential files with specific people, and be sure nobody else can open them, even by guessing a link or searching. It also needs a record of who opened what that can't be secretly edited, and when access is taken away, it has to stop working straight away, not after a session or link expires.

I built TrustVault around those three rules. The server checks permission on every request, from the database, in one place in the code. Every action, including refused attempts, goes into a log that is hash-chained, so any change to it shows up.

## 2. What actually works right now

Live site: https://trustvault-7apy.onrender.com (logins are in the README; the free server can take up to a minute to wake up).

- Sign in as admin, owner or viewer.
- Owners upload files, add versions, edit details, move to trash and restore.
- Owners share each file with named people as "read" or "edit", and can remove access. Removing access works on the person's next click.
- Search by name, owner, category and date. It only ever shows files you're allowed to open.
- Uploads are checked by their real content, not just the file name, and limited to 10 MB.
- A file you're not allowed to see gives the same "not found" as a file that doesn't exist.
- Every upload, download, change, share and refused attempt is logged. The database blocks edits to the log, and the admin can check its integrity with one button.
- The admin manages users, sees the full log and alerts (for example, someone retrying after losing access), but cannot open documents.
- 151 automated tests. A script removes each of the 34 permission checks one at a time, and a test fails every time.

Not done or weak: no virus scanning, no public sharing links, no AI feature. An admin can reset someone's password; this is logged but not prevented. Rate limiting is per IP address only.

## 3. How to run it on our machine

Needs Node.js 20+, PostgreSQL 14+ and Git.

```bash
git clone https://github.com/hemathanmaieg/trustvault.git
cd trustvault
psql -U postgres -f server/db/create-local-db.sql
cp .env.example .env
npm install
npm run setup
npm run build
npm start
```

Then open http://localhost:3000 and sign in with a README account.

- Tests: `npm test`
- Check that every permission check is tested (about 5 minutes): `npm run test:authz-removal`

## 4. Which AI tools you used

Claude (Anthropic), used as the main coding assistant for design, implementation, tests and documentation. A second, separate Claude agent, which had not written the code, was used as an independent security reviewer that attacked the running application.

## 5. What the AI got wrong, and what you fixed yourself

I used AI to write most of the code, and one thing I learned quickly is that code passing all its tests is not the same as code being correct. So after each part was written, I asked the AI to point out what could be wrong with it. Once the whole system was working, I had a separate AI, one that had not written any of the code, try to break the live application the way a judge would. Several real problems came out of that.

The most serious one was in the activity log. Each record is sealed so that any later change can be detected. But the AI had sealed each record before saving it, and the database quietly changes the format of some values when it stores them. So if someone simply typed a document's ID in capital letters, the log would later claim it had been tampered with. In practice, anyone could have made the evidence trail look untrustworthy. The fix was to seal each record exactly as the database stores it, and to check the seal again before saving, so a record that doesn't match is never written.

The second problem was about removing access. If someone was in the middle of uploading a large file and their access was removed, the upload still went through, because permission was only checked at the start. I changed it so permission is checked again at the moment the file is actually saved. Removing access now stops anything already in progress.

There were smaller ones too. The account lock after five wrong passwords could be avoided by sending guesses all at once. And renaming a document accidentally wiped its description. Both were fixed and now have tests.

I also rejected one of the AI's approaches. It designed a way to prove that every security check is actually tested, but the design could not really switch some checks off, so it would have given a false "all good". I had it redesigned so that each check can genuinely be removed. The tests now catch the removal of every single check.

Each of these is written up, with the change that fixed it, in PROMPTS.md.

## 6. What is not finished

- The five-minute demo video has not been recorded yet.
- No virus or malware scanning of uploaded files; files are type-checked and only ever downloaded as attachments.
- An administrator can reset a user's password and then sign in as that user. This is audited and signs the user out, but it is not prevented.
- Rate limiting is per IP address only; a distributed flood is not stopped.
- Someone with full database access and the server's secret key could rewrite the audit history. This is mitigated, but not prevented.
- Not built by choice: public sharing links, folder or group permissions, the optional AI feature, and two-factor sign-in.
- Free hosting: the server sleeps after 15 minutes of inactivity, and the free database expires after 30 days.
- The commit history covers only a few days.
- The seeded salary letter PDF still contains an earlier demo name inside the file text.
