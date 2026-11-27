# USER MANUAL — TRF Management System

## Table of contents

1. What this system is
2. Getting started
3. Signing in
4. Sidebar tour
5. Roles and what each can do
6. Task guides
7. Rules people ask about
8. Troubleshooting and FAQ
9. Glossary

---

## 1. What this system is

The TRF Management System is the lab system for Kawman ExAct Ingredients Private Limited, Chennai. It tracks a Test Request Form (TRF) from the moment Formulation raises it until the Certificate of Analysis (COA) is issued.

Workflow:

1. **Formulation** raises a TRF (Part A: product, batch, tests requested).
2. **GM** approves, rejects, or sends back the TRF.
3. **ARD** assigns tests and analysts.
4. **Analysts** enter and submit results (Pass/Fail with limits).
5. **AGM** reviews results, changes analysts when someone is absent, and submits the TRF for final approval.
6. **Admin** gives the final approval, which locks the TRF.
7. A **Certificate of Analysis (COA)** is drafted, reviewed, approved and issued.

Everyone works in the same desktop app on their PC. The app connects to one central server. No PC holds the database.

---

## 2. Getting started

### Installing the desktop app

The app is installed per PC from the installer named **TRF-Setup**. Run it on each PC that needs access.

When you first run the app, Windows may show a SmartScreen warning that the app is not recognised:

- Click **More info**.
- Click **Run anyway**.

This is a standard Windows message for an app that is not yet widely downloaded. It does not mean the app is unsafe.

### Setting the server address

After the app opens, go to **Settings**. Enter the address of the central server. Example:

```
http://192.168.0.124:4000
```

Rules for the address:

- It must start with `http://` (or `https://` if your server uses TLS). Do not leave the prefix out.
- Use the server's IP address or hostname on your local network.
- Port `4000` is the default API port.

### Telling whether the app is connected

At the top of every page there is a connection indicator:

- **Connected**: the app can reach the server. You can work normally.
- **Offline**: the app cannot reach the server. The page shows an offline notice and you cannot load or save anything until the connection returns.

If you see "Company server is unavailable", check that the server address in Settings is correct and that your PC is on the same network as the server.

---

## 3. Signing in

### Employee login

Each person has their own employee account. On the sign-in screen, enter your employee username and password, then click **Sign in**.

### Forgot password

If you forget your password, click **Forgot password** on the sign-in screen. Enter your email address. The system sends a reset link to that email. Open the link and set a new password.

If the reset link does not open anything, ask your administrator to check that email is configured on the server, or to reset your password directly under **Employees**.

### First sign-in forced password change

When an administrator creates your account, or resets your password, your account is marked **must change password**. On your first sign-in with the new password, the app will not let you work until you set a new password of your own.

### Shared team login with "Select member" and PIN

Some teams log in through a shared team account (for example the ARD team desk PC). On the sign-in screen:

1. Choose the team account.
2. Click **Select member** and pick your name from the list.
3. Enter your personal PIN.
4. Click **Sign in**.

This means every action is still attributable to one named person, even though the PC uses a shared login.

### Lockout

If someone enters the wrong password 5 times in a row, the account is locked for 15 minutes. The same rule applies to the shared team PIN: 5 wrong PINs locks the PIN for 15 minutes. The lock time can be changed by the server administrator; 15 minutes is the default.

Wait for the lock to expire, or ask an administrator to unlock the account under **Employees**.

---

## 4. Sidebar tour

### Dashboard

Everyone sees this. It shows charts and counts for TRFs, analysis results, assignments, COAs and audit activity. The figures are counted by the server for your role only, so the numbers always match the lists you can open.

### TRF Management

Everyone sees this. It is the list of all TRFs you are allowed to see. You can search, filter by status, priority, customer, product, department, employee or date range, show or hide columns, page through results, and export to Excel.

Roles with **trf.create** can click **New TRF**. Roles with delete permission can delete a TRF that is still **New** and has no dependent work.

### Assignments

Everyone except Viewer sees this. Managers and roles with `assignments.manage` see the full assignment board and can assign tests to analysts and reassign them. Analysts see their own tests through **My tests**.

### ARD

Only Admin, GM, AGM and Manager see this. It shows every active ARD employee with their workload: tests assigned, in progress, submitted, approved, rejected and overdue. Managers can reassign work from this screen, one person at a time or in bulk.

### FRD

Only Admin, GM and AGM see this. It is the Formulation workspace: TRFs waiting for formulation decisions and formulation team workload.

### Approvals

Only Admin, GM and AGM see this. It lists TRFs waiting for a formulation or ARD decision, and (for AGM) test results waiting for review. Approve or reject each item.

### Employees

Only Admin, GM and Manager see this. Create employees, deactivate them, reset passwords, set PINs and assign roles, departments, designations and teams.

### Reports

Everyone except Viewer sees this (Viewer can view and export). Build Excel reports from the TRF list, analysis results, assignments, ARD tracking, employees, COAs, dashboard counts and audit log. Each sheet keeps the filters of its matching list.

### Audit Log

Only Admin, GM, AGM and Manager see this. A read-only trail of who changed what and when. Filter by module, action, user, record reference and date range. Expand a row to see the field-by-field change.

---

## 5. Roles and what each can do

A person holds one role. Their designation (Trainee through COO) is separate and mainly matters for senior designations (AGM, GM, COO).

| Role | Teams | What they can do |
|------|-------|------------------|
| Admin | Any | Everything. GM and COO designations resolve to this role. Can give final approval and lock a TRF. Can reopen a locked TRF. Manage employees, settings, team accounts. |
| GM | Any | Approve or reject formulation and ARD. Submit for final approval. Cannot give final approval or reopen a locked TRF (Admin only). |
| AGM | ARD | Review test results. Submit ARD for final approval. Cannot approve formulation or give final approval. |
| Manager | Formulation or ARD | Edit ARD block, change status, manage assignments, approve COA. Cannot approve formulation or give final approval. |
| Analyst | Formulation or ARD | Create TRFs, enter and submit test results, see own assignments. Cannot approve anything. |
| Viewer | Any | See TRFs, analysis, COAs, reports and exports. Cannot create, edit or approve anything. |

A shared team login can never hold the Admin role, so an approval is always attributable to one named person.

This table is built from `packages/shared/src/permissions.ts` and `packages/shared/src/designations.ts`. It matches the code exactly.

---

## 6. Task guides

### Create a TRF

1. Go to **TRF Management**.
2. Click **New TRF**.
3. Fill in Part A — Formulation:
   - Date of Request (required)
   - Product Name (required)
   - Batch Number (required)
   - Batch Size
   - Market/Customer
   - Dosage Form (pick from options, or type Other)
   - Manufacturing Location
   - Label Claim
   - Pack Size
   - Pack Type
   - Storage Condition
   - Storage Period
   - Manufacturing Date
   - Expiry Date
   - Test Requested (pick from the list, or type Other)
   - Test Details
   - Analysis Required For / Purpose
   - Required Completion Date
   - Sample Quantity
   - Sample Submitted By
   - Remarks
4. Click **Save**.

The TRF is created with status **New** and Formulation status **Pending**.

Editing: while the TRF is **New** and not locked, you can edit Part A. Open the TRF from the list, click **Edit**, change the fields and save. After the TRF moves past **New** or is locked, Part A is read-only.

### GM approval, rejection and send-back

The GM opens a TRF from **TRF Management** or **Approvals**.

1. Open the TRF.
2. In the Approval bar, click **Approve**, **Reject** or **Return**.
3. For Reject or Return, type a reason.
4. Confirm.

If the GM approves, the Formulation status becomes **Approved** and the TRF moves to ARD. If the GM rejects or returns, the Formulation status becomes **Rejected** or **Returned** and Formulation must revise and resubmit.

Only Admin and GM may approve or reject formulation.

### ARD: assigning tests and analysts

1. Go to **Assignments** (Managers, Admin, GM, AGM) or **ARD** (Managers, Admin, GM, AGM).
2. Find the TRF with Formulation status **Approved**.
3. Click **Assign tests**.
4. Pick the tests to assign and the analyst for each test.
5. Click **Assign**.

Each test gets an assignment record. The analyst sees it in **My tests** and on the Analysis screen.

### ARD: starting a test

The analyst opens **My tests** (inside Assignments) or the Analysis screen.

1. Find the test assigned to you.
2. Click **Start**.
3. The test status moves from **Assigned** to **In Progress**.

### ARD: entering and submitting results

1. Open the test from **My tests** or the Analysis screen.
2. Click **Submit result**.
3. Choose **Text** or **Upload PDF** (max 10 MB).
4. For Text, enter the Result value, Unit, Result text (for descriptive results), Method used and Specification.
5. Choose the Outcome: Pass, Fail, Not Specified or Not Tested.
6. Enter Analysis start date and Completion date.
7. Click **Submit result**.

The result goes to the AGM for review. The test is completed once the AGM approves it. If the AGM rejects it, you must correct and submit it again.

#### Pass/Fail rules including limits on one side only

The system works out Pass/Fail automatically from the result value and the limits on the test:

- **No limits**: outcome is **Not Specified**.
- **Lower limit only**: result at or above the lower limit is **Pass**; below is **Fail**.
- **Upper limit only**: result at or below the upper limit is **Pass**; above is **Fail**.
- **Both limits**: result between the limits (including exactly on either limit) is **Pass**; outside is **Fail**.

### AGM: changing the assigned analyst

#### Single reassignment

1. Go to **Assignments** or **ARD**.
2. Find the assignment.
3. Click **Reassign** (or open the assignment and choose a new analyst).
4. Pick the new analyst.
5. Type a **Reason** (required — for example, "A is absent today").
6. Confirm.

#### Bulk reassignment

1. Go to **ARD**.
2. Find the employee whose work you want to move.
3. Click **Reassign bulk**.
4. Pick the assignments to move and the new analyst for each.
5. Type a **Reason** (required).
6. Click **Reassign**.

A reason is required every time an analyst changes. This is recorded in the audit log.

#### What happens to work already submitted

If an analyst already submitted a result for a test and that test is reassigned, the submitted result stays with the test. The new analyst inherits it. The AGM still reviews it. Reassignment does not delete or overwrite submitted results.

### Final approval and locking

1. The AGM submits the TRF for final approval from the Approval bar (when every test is complete and the COA status allows it).
2. The TRF moves to **Submitted to AGM** then **Completed by AGM**.
3. **Admin** opens the TRF and clicks **Final approve**.
4. The TRF is **locked**. Nobody can edit Part A or the ARD block anymore.
5. The TRF shows **Locked by <name> on <date>**.

Who may do it: **Admin only** (role Admin, which is held by people with GM or COO designations). GM and AGM cannot give final approval.

Unlocking: only Admin or GM can reopen a Formulation-approved TRF. This sets the Formulation status back to **Pending**, unlocks Part A for editing, and locks the ARD block again until re-approved. All ARD data is preserved.

What locked means: no edits to Part A or the ARD block. The status cannot move forward. You can still view the TRF and print it or save it as PDF.

### Printing a TRF and saving as PDF

A TRF can be printed only after final approval (when it is locked).

1. Open the TRF.
2. Click **Print** (on the detail page, or the printer icon on the list row).
3. The system print dialog opens. Choose your printer and click Print.
4. Or click **Save as PDF** to choose a folder and file name.

The printed form shows:

- Header: Kawman ExAct Ingredients Private Limited, Chennai; SOP No. QAQN-003:F1; Revision 00; MASTER; Effective date; Issued by; Department: Quality Assurance.
- **Prepared by**: the person who created the TRF (Sample Submitted By), with the creation date.
- **Approved by**: the GM's name from print settings, with the formulation approval date.
- Page 1 of 1.

If the analysis text is long, the form can spill to a second page. This is a print layout limit; shorten the text or accept two pages.

Every print and every PDF is recorded in the audit trail before anything is printed.

### COA: draft, review, approve, issue

1. Go to **Certificates of Analysis**.
2. Click **Draft a certificate**.
3. Pick a TRF whose analysis is complete (status Analysis Completed or COA Pending).
4. Optionally add remarks.
5. Click **Draft**. The certificate is created with status **Draft** and the results are copied onto it. Results do not change after drafting.

The certificate moves through these steps:

| Step | Button | Who can do it |
|------|--------|---------------|
| Draft | — | Created automatically |
| Send for review | Send for review | Anyone with `coa.prepare` |
| Under Review | — | Automatically after send for review |
| Send back for changes | Send back | Anyone with `coa.prepare` (must give a reason of 3+ characters) |
| Approve | Approve | Anyone with `coa.approve` |
| Issued | Issue certificate | Anyone with `coa.issue`. This assigns the certificate number and completes the TRF. |

Only an **Issued** certificate can be printed. Issued certificates are final — nothing on them can be changed.

### Reports and Excel export

1. Go to **Reports**.
2. Choose the sheets you want: TRF Master, Analysis, Assignments, ARD Tracking, Employees, COA, Dashboard Data, Audit Log.
3. Set filters (search, status, dates, employee, etc.).
4. Click **Export to Excel**.

Each sheet keeps the filters of its matching list, so a saved file can be reproduced later. The server decides what your role may see; the page only asks and reports.

Row limit: if a sheet would have too many rows, the export shows a row limit message and does not export. Narrow the filters and try again.

### Employees: create, deactivate, reset password, set a PIN (admins only)

1. Go to **Employees** (Admin, GM, Manager only).
2. To create: click **New employee**, fill in Employee Code, Full Name, Email, Username, Role, Department, Designation, Phone, Password, Account type (Individual or Shared team), Team (FRD or ARD) and PIN (for shared team). Click **Save**.
3. To deactivate: open the employee, clear **Active**, save. A deactivated employee cannot sign in.
4. To reset password: open the employee, enter a new password, save. The account is marked **must change password** at next sign-in.
5. To set a PIN: open the employee, enter a 4-digit PIN, save. Used for shared team logins.

Admins only can manage employees. GM and Manager can view but not manage.

### Audit Log: what is recorded and how to filter

1. Go to **Audit Log** (Admin, GM, AGM, Manager).
2. Filter by:
   - Search (text across user, module, action, record reference)
   - Module (auth, trf, coa, analysis, assignments, employees, settings, audit, team)
   - Action (create, update, delete, approve, reject, submit, lock, print, export, login, pin, etc.)
   - User
   - Record reference (for example a TRF number)
   - Date from / Date to
3. Click a row to expand it and see the field-by-field change.

Every print, every PDF, every approval, every reassignment and every password reset is recorded.

---

## 7. Rules people ask about

### Who can see which TRF

- **Admin, GM, AGM, Manager** (roles with `trf.viewAll`): see every TRF.
- **Analyst** and **Viewer**: see a TRF when any of these is true:
  1. You created it.
  2. You are assigned to it.
  3. You are an analyst on any test of it.
  4. You are in the ARD team, the TRF is approved and unlocked, and no analyst is assigned to any test of it yet.
- A locked TRF is visible only to viewAll roles and to anyone assigned to a test of it (rule 3 above). Other ARD analysts do not see a locked TRF by rule 4.

### What is editable at each stage

| Stage | Part A editable | ARD block editable | Status can change |
|-------|----------------|--------------------|-------------------|
| New | Yes (creator / Formulation) | No | Yes |
| Assigned / In Progress | No | Yes (ARD team) | Yes |
| Analysis Completed | No | Yes (ARD team) | Yes |
| COA Pending | No | No | Yes |
| Completed | No | No | No |
| Cancelled | No | No | No |

A locked TRF cannot be edited at all. Deletion is allowed only for a **New** TRF with no dependent work, by Admin or Formulation users.

### Notifications

The app shows a notification bell. Notifications tell you about results waiting for review, TRFs assigned to you, results approved or rejected, and TRFs submitted for final approval. Everyone with `notifications.view` sees them.

---

## 8. Troubleshooting and FAQ

| Problem | Cause | What to do |
|---------|-------|------------|
| Cannot connect to the server | Wrong server address in Settings, server stopped, or PC not on the same network | Check Settings shows an address starting with `http://`. From the PC, open `http://<server>:4000/api/health/live`. No response means the service is stopped or the port is blocked. |
| Forgot password | — | Click **Forgot password** on the sign-in screen. If the email does not arrive, ask an administrator to reset your password under **Employees**. |
| Account locked | 5 wrong password attempts (or 5 wrong PINs on a shared team login) | Wait 15 minutes for the lock to expire, or ask an administrator to unlock the account under **Employees**. |
| Cannot see a TRF | You are not the creator, not assigned, not an analyst on a test, not ARD-team with an approved unlocked unassigned TRF, and not a viewAll role | Ask the person who created it or an Admin to assign you, or ask an Admin if you should have viewAll access. |
| Cannot edit a TRF | The TRF is past **New**, or it is locked, or your role/department does not own that part | Part A is editable only while **New** and not locked, by Formulation/Admin/Manager. The ARD block is editable by ARD/Admin/Manager while not locked. A locked TRF cannot be edited. |
| Export says too many rows | The sheet would exceed the row limit | Narrow the filters (date range, status, employee) and export again. |
| The printed form spills to a second page | The analysis text is long | Shorten the text, or accept that the form prints on two pages. |
| Reset email link opens nothing | Email is not configured on the server, or the link expired | Ask an administrator to check email settings on the server, or to reset your password directly under **Employees**. |

---

## 9. Glossary

| Term | Meaning |
|------|---------|
| TRF | Test Request Form. One record for one product batch, raised by Formulation and tracked to a Certificate of Analysis. |
| ARD | Analytical Research and Development. The lab team that assigns tests, records results and drives the TRF to completion. |
| FRD | Formulation Research and Development. The team that raises TRFs and owns Part A. |
| COA | Certificate of Analysis. The document that records the test results for a batch. Drafted, reviewed, approved and issued. |
| AGM | Assistant General Manager. Reviews test results, submits TRFs for final approval, cannot approve formulation or give final approval. |
| GM | General Manager. Approves or rejects formulation and ARD, submits for final approval. Cannot give final approval (Admin only). |
| TAT | Turnaround time. The number of days between sample receipt and completion, shown on the TRF detail. |
| Stage | Where the sample is in the laboratory (for example Initial). Shown on the TRF detail, separate from Final Status. |
| Part A | The Formulation section of the TRF (product, batch, tests requested, etc.). Editable while New and not locked. |
| Part B | The ARD section of the TRF (stage, analyst, results, reporting status, COA status). Editable by the ARD team while not locked. |
| Final approval | Admin's decision that locks the TRF. After this, nothing can be edited and the TRF can be printed. |
| Locked | A TRF that has been finally approved. Cannot be edited. |
| Reopen | Admin or GM setting a Formulation-approved TRF back to Pending, unlocking Part A. |
| COA Pending | TRF status meaning analysis is complete and a certificate is expected. |
| Employee dashboard | The Analyst view of their own assigned tests and results. |
| Shared team login | One account used by a team desk PC; each member selects their name and enters a personal PIN. |
| Print log | An audit record made every time a TRF or certificate is printed or saved as PDF. |
