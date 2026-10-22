# Step 06 — Hand-over: what is done, what needs a person

**Date:** 2026-10-22

## Done (in the repository)

| Hand-in item from the brief | Status | Where |
| --- | --- | --- |
| Public Git repository with history | Code ready, 9 commits so far; **push needed** | – |
| Live URL with seed data, credentials in README | Config ready and tested from a clean clone; **deploy needed** | `render.yaml`, DEPLOY.md, README |
| THREATS.md | Done: 40+ threats, status, tests, what held under attack | THREATS.md |
| PROMPTS.md (5+ dated entries, 2+ on authz/audit) | 12 entries, 7 on access control or audit, each with its commit | PROMPTS.md |
| Automated tests incl. isolation | 149 tests; 34/34 checks proven | `server/test/`, `docs/authz-removal-report.md` |
| Schema, setup scripts, deployment instructions | Done | `server/db/`, DEPLOY.md |
| API documentation with who may call each endpoint | Done | API.md |
| Five-minute demo video | Script ready; **recording needed** | docs/DEMO-SCRIPT.md |
| Short write-up | Done | WRITEUP.md |

## Needs a person

1. **GitHub:** create a public repository in her account and push this one (or give access so it can be pushed). Before pushing, set the commit author to her name if wanted:
   ```bash
   git config user.name "Her Name"
   git config user.email "her@email"
   git rebase -r --root --exec "git commit --amend --no-edit --reset-author"
   ```
   Note: `--reset-author` also resets commit dates to now. Skip this if the original timestamps matter more.
2. **Render:** New > Blueprint > choose the repository; enter the three seed passwords from DEPLOY.md; wait for "Live".
3. **README:** paste the live URL and the video link at the top; commit and push.
4. **Demo video:** record about 5 minutes following DEMO-SCRIPT.md, upload (YouTube unlisted or Google Drive), put the link in the README.
5. **PROMPTS.md:** add 2–3 entries of her own from reading and changing the code. They must be real.
6. **Interview:** work through INTERVIEW-PREP.md, especially section 1, out loud.
7. **Just before submitting:** run `npm test`, `npm run test:authz-removal` and `npm audit`, then open the live URL once to wake it up.
