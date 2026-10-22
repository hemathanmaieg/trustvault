# Step 05 — Independent security review and fixes

**Date:** 2026-10-22
**Goal:** have someone who did not write the code attack it the way the judges will, then fix everything found.

## How the review was done

A separate AI agent, which had not written any of the code, was told to act as a hostile judge. It read the security code and attacked the running server with `curl` using the demo accounts. It was not allowed to change any files. Its brief is in PROMPTS.md ("How the independent review was set up").

At that point all 131 tests passed. **None of them caught what it found.**

## What it found, and the fix for each

| # | Severity | Finding | Fix | Regression test |
| --- | --- | --- | --- | --- |
| 1 | Critical | Requesting a document id in UPPERCASE made the audit chain report "altered". PostgreSQL stores uuids lowercase, but the seal was computed over the uppercase text. Anyone signed in could make the evidence worthless. | Values are brought to their stored form before sealing; each new entry is read back and re-verified before commit, and a mismatch rolls the action back. Ids are lowercased once per route. | hardening T19 (6) |
| 2 | High | An editor revoked halfway through a slow upload still added the new version. | Re-check the grant inside the write transaction with a row lock that grant/revoke also take. Downloads read bytes with the access check in the same SQL statement. | hardening T03 |
| 3 | Medium | Renaming a document wiped its description (a schema default leaked into edits). | Separate strict edit schema, no defaults; unknown fields refused. | hardening T08, permissions T07 |
| 4 | Medium | Anonymous requests could flood the audit log and slow everyone (one global audit lock). | Rate limits: 300/min per address, 30/min when not signed in, one audit entry per window when hit. | hardening T39 (2) |
| 5 | Medium | NUL bytes, broken Unicode, undecodable URLs and dates like `2026-13-45` gave 500 and left **no audit record**. | Clean text before sealing; refuse bad text with 400; log undecodable URLs as `malformed_request`; real calendar-date check. | hardening T20 (3) |
| 6 | Low | Restoring from trash silently gives access back. | Kept by design; the restore audit entry now lists everyone who regains access. | hardening T42 |
| 7 | Low | The login limiter counted successful sign-ins (judges on one network could lock each other out) and did not log its refusals. | Counts failures only; one audit entry when hit. | – |
| 8 | Low | `file-type` 16 had a moderate advisory. | Upgraded to 22 (ES module, loaded with `import()`); `npm audit`: 0 vulnerabilities. | upload tests + new Word/Excel tests |
| 9 | Info | Promoting someone who owns documents to admin would leave their documents unmanageable. | Refused with a clear message. | hardening T05 |

Found by the AI while fixing #1: the admin "cannot demote yourself" check compared ids as raw text, so typing your own id in capitals skipped it. Fixed by the same id normalisation, with its own test.

## A side effect worth knowing

After adding the second permission check inside writes (fix 2), the removal script reported **32 of 34**. Removing the *first* check on edit and new-version was no longer caught, because the second check also refused. Nothing leaked, but the first check has its own job (refusing before a 10 MB body is read). A test now asserts **which** check refused, using the audit reason. Result: **34 of 34 caught, 149 tests.**

## Checked

```text
npm test                    149 passing
npm run test:authz-removal  34/34 caught
npm audit                   0 vulnerabilities
```

The review left the development database's audit chain broken (that was the attack in finding 1). It was reset afterwards; the live Render database starts fresh anyway.
