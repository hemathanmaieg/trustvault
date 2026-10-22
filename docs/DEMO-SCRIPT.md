# Five-minute demo video script

Record on a laptop with two browser windows side by side: a normal window and a private (incognito) window, so two people can be signed in at once. Open the live site once beforehand to wake up the free server.

Aim for about 30 seconds per section. Say the words in *italics*; do the steps in plain text.

---

**0:00 — What it is (20 s)**
*"This is TrustVault, a document platform with three promises: the wrong person can never reach a file, we can prove who did, and taking access away works immediately."*

**0:20 — Owner shares a document (40 s)**
1. Left window: sign in as `owner@trustvault.demo`.
2. Open **Board notes - private**. *"Only Omar can see this; it is shared with nobody."*
3. Open **Salary letter - Vikram**. Point at **Who has access**: Vikram, *Can read*.

**1:00 — Viewer sees only what was shared (40 s)**
1. Right (private) window: sign in as `viewer@trustvault.demo`.
2. *"Vikram sees one document. Searching for 'board' finds nothing, because search only covers what he may open."* Search "board".
3. Open the salary letter and click **Download latest**.

**1:40 — Trying to get around it (40 s)**
1. In the left window copy the address of **Board notes**, paste it in the right window.
2. *"Vikram has the exact link, but the server checks the database on every request. Not found, and the same answer as for a document that does not exist, so ids cannot be probed."*

**2:20 — Revoke works immediately (40 s)**
1. Left window: on the salary letter, click **Remove** next to Vikram.
2. Right window: click **Download latest** again on the page that is still open. *"Same session, same page, no sign-out. Refused straight away."*

**3:00 — Upload validation (25 s)**
1. Left window: **Upload document**, pick a text file renamed to `.pdf`. *"The content is checked, not the name."* Show the error.

**3:25 — Admin and the audit trail (60 s)**
1. Right window: sign out, sign in as `admin@trustvault.demo`.
2. **Alerts**: *"The system noticed Vikram trying again after his access was removed."*
3. **Activity log**: filter Result = Refused. *"Every refused attempt is here: who, which document, when, from where."*
4. Back to **Alerts**, click **Check the chain**. *"Each entry is sealed with a keyed hash of the one before. The database refuses edits and deletions, and if someone bypassed that, this check names the entry that changed."*
5. **Documents** (admin): *"The admin sees titles and activity, but there is no way for an admin to open a document."*

**4:25 — Tests (30 s)**
1. Terminal: `npm test` (show 149 passing), then the summary of `docs/authz-removal-report.md`.
2. *"The judges said they would remove one authorisation check and run our tests. We did that for all 34 checks; every removal makes tests fail."*

**4:55 — Close (5 s)**
*"Thank you. The threats we closed and the ones we accepted are in THREATS.md."*
