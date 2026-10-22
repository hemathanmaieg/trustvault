# Build log

Each step of the build, in order, with what was done, why, and how it was checked.

| Step | Document | Summary |
| --- | --- | --- |
| 01 | [Project setup and database](01-project-setup-and-database.md) | Stack, packages, six tables, files inside the database, append-only audit log |
| 02 | [Backend API](02-backend-api.md) | Every permission decision in `authz.js`; how a download is decided; roles |
| 03 | [Security tests](03-security-tests.md) | 131 tests by threat id; the script that removes each check in turn |
| 04 | [Frontend](04-frontend.md) | React screens for each role; design choices; fixes made after screenshots |
| 05 | [Independent review and fixes](05-independent-review-and-fixes.md) | Hostile review found 9 issues the tests missed; all fixed, 149 tests, 34/34 checks caught |
| 06 | [Hand-over](06-handover.md) | What is finished, and what still needs a person |

Also useful: [INTERVIEW-PREP.md](../INTERVIEW-PREP.md) and [DEMO-SCRIPT.md](../DEMO-SCRIPT.md).
