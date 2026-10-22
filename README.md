# TRF & Analysis Management System

Status: **all 12 phases complete**, plus the TRF screen rework that reorders the fields and separates the Stage from the Final Status (Phase 13 below) — scaffold, API skeleton, database migrations, connection-status shell, authentication, employees, roles and permissions, TRF management, work assignment, analysis results, certificates of analysis, dashboard, Excel reports and export, audit log, deployment, logging, backups, installer packaging, ARD tracking, the TRF form rework, and the final integration pass.
Deployment is documented in `docs/deployment.md`, packaging in `docs/installer.md`, and testing in `docs/testing.md`.

## Documentation
- [`docs/deployment.md`](docs/deployment.md) — installing the server, creating the first administrator, running it as a service, health checks, backups and restores, upgrading, troubleshooting.
- [`docs/installer.md`](docs/installer.md) — building the per-PC installer and pointing it at a server.
- [`docs/testing.md`](docs/testing.md) — running the tests, including how to point them at a throwaway database.

## Layout
- `packages/shared` – types and constants used by both sides (roles, statuses, permissions)
- `apps/server` – Node/TypeScript API (Express) that owns all PostgreSQL access
- `apps/desktop` – Electron + React + Vite client; talks only to the API, never to PostgreSQL

## Development setup
1. Install Node.js 20+ and PostgreSQL 14+ (development only; employees need neither).
2. Create a database and user:
   `CREATE USER trf_app WITH PASSWORD '...'; CREATE DATABASE trf_system OWNER trf_app;`
3. `cp apps/server/.env.example apps/server/.env` and fill in the `DATABASE_*` values.
4. `npm install`
5. `npm run dev:server` (applies pending migrations on start; `npm run migrate` runs them alone)
6. In a second terminal: `npm run dev:desktop`
   The desktop app defaults to `http://localhost:4000`; change it under Settings, or set `TRF_API_URL`.

## First run: create the administrator
Set `JWT_SECRET` (32+ characters) and the `ADMIN_*` values in `apps/server/.env`, then:
`npm run seed:admin`
It creates the first Admin only when no active Admin exists, marks the password as "must change at first sign-in", and never runs on server start. Remove `ADMIN_PASSWORD` from `.env` afterwards.

## Checks
- `npm run typecheck` runs TypeScript checks for all workspaces.
- `npm test` runs the server test suite **and** the desktop UI tests (vitest + jsdom). Tests that need a database report as *skipped* when PostgreSQL is not reachable, so a green run never claims untested coverage. See `docs/testing.md` for how to point the suite at a throwaway test database.

## Behaviour implemented in the TRF Management rework (Phase 14)
- **Test Requested and Test Details sit after Stage.** The ARD columns run in exactly this order everywhere they appear — the list's "Columns" toggle, the Excel TRF Master sheet and the ARD card on the form, detail page and printable TRF: A.R. No. → **Stage → Test Requested → Test Details** → Analyst Name → Date of Analysis → Reporting → COA → ARD Remark (and its Status) → TAT → Final Status. In the list and in Excel they appear **once**, in that position, and not a second time in the Part A column group: they are the same `requested_analysis` and `special_instructions` values, read from the same TRF row, never stored again and never editable from the ARD side. Part A still holds the editable inputs; the ARD card shows them read-only with a padlock and the note "Carried forward from the Formulation request". The list API returns both fields and both are searchable.
- **Stage is a master table, not a fixed list.** `ard_stage` stays TEXT but its CHECK constraint is gone; the values now live in a new `ard_stages` table (`id`, `name`, `is_active`, `created_by`, `created_at`) with a case-insensitive unique index on the name. It is seeded with **Initial** as the only active stage. The dropdown offers the active stages and ends with **"Other (type new)"**; choosing it reveals a text box whose Add button (or the Enter key) creates the stage through `POST /api/lookups/stages` and selects it, without saving the TRF. New TRFs default to **Initial**.
- **Nothing is lost.** The workflow statuses older rows still hold in `ard_stage` (Received, In Progress, Completed, Cancelled) were inserted into `ard_stages` as **inactive legacy values**: those TRFs still display their value, but only active stages are offered in the dropdown. On the development database **8 TRF rows** carried a legacy stage value (7 × "Received", 1 × "In Progress").
- **Stages are added by the ARD team only.** `GET /api/lookups/stages` is open to anyone who can see a TRF; `POST /api/lookups/stages` requires Part B rights (`canEditTrfPartB`). The name is trimmed and its whitespace collapsed, must be 2–60 characters, and a case-insensitive duplicate reuses the existing record and tells the user. Every creation is audited. Saving a TRF with a stage that is not in `ard_stages` is a **400 with a field message**, never a 500. Stage stays editable only by ARD users (plus Admin/Manager), with the version check and per-field audit rows.
- **"Remark status" is now "Status".** Everywhere users see it — form, detail page, printable TRF, list, filters, Excel headers, validation messages and tooltips — the Formulation `remarks_status` and the ARD `ard_remarks_status` are simply called **Status**. The column names and the API field names are unchanged. Because the list already has a "Status" column for the TRF status, the list and the Excel sheet head the two columns **"Remarks / Status"** and **"ARD Remarks / Status"**; on the forms the plain label "Status" is enough.
- **Reporting offers Approved, Rejected and Pending.** The dropdown is Pending, Draft, Submitted, Reviewed, Approved, **Rejected**; the old values stayed valid and only `Rejected` was added. Reporting is shown as a coloured pill — Approved green, Rejected red, Pending amber, the rest neutral — on the form, the detail page, the list, the printable TRF and the Excel sheet. Only ARD users edit it, and an unknown reporting value is a 400 with a field message.
- **Migration 012** (`012_ard_stages_master_and_reporting.sql`) does all of that on the database: it drops the `ard_stage` CHECK constraint, creates `ard_stages` with its unique index, seeds "Initial" and the inactive legacy values, sets the `ard_stage` default to "Initial", and widens the `reporting_status` CHECK with "Rejected". It is idempotent — `npm run migrate` twice leaves the database unchanged the second time.

## Behaviour implemented in the TRF screen rework (Phase 13)
- **One TRF, one screen, two cards.** The TRF screen is a single record: **Part A — Formulation** on top, the **ARD — Analysis Details** block below it, with an ARD badge and its own tinted card. There is no separate ARD page. Both cards are always shown; a field the signed-in user may not change is greyed out and carries a padlock whose tooltip names the owner (Formulation, ARD or the system).
- **One field order, everywhere.** `packages/shared/src/trf-fields.ts` is the single list of fields, their labels and their owners. The form, the detail page, the printable TRF, the list's "Columns" toggle and the Excel TRF Master sheet are all built from it, so they cannot drift apart.
- **Part A order:** TRF No. (read-only), Date of Request, Product Name, Batch Number, Batch Size, Market/Customer, Dosage Form, Manufacturing Location, Label Claim, Pack Size, Pack Type, Storage Condition, Storage Period, Manufacturing Date, Expiry Date, Test Requested, Test Details / Special Instructions, Analysis Required For / Purpose, Required Completion Date, Sample Quantity, **Sample Submitted By**, **Status** (with its free-text note beside it), **Signature / Date**.
- **ARD block order:** A.R. No. (read-only), Stage, Test Requested (read-only, carried forward from Part A), Test Details (read-only, carried forward), Analyst Name, Date of Analysis, Reporting, COA, Status (with the ARD free-text remark beside it), TAT (read-only), Final Status, then Sample Received By and Sample Received Date. The carried-forward Test Requested and Test Details are shown from the same record and are never stored twice.
- **Sample Submitted By is an employee, not free text.** Migration `011_sample_submitted_by_and_ard_stages.sql` adds `sample_submitted_by_id INTEGER REFERENCES employees(id)` and backfills it by matching the old `sample_given_by` text to `employees.full_name` case-insensitively and exactly; unmatched rows stay NULL. The legacy column is kept, never overwritten. A row that still has only the old text shows it read-only as "Previously entered: …" and lets the user pick an employee to replace it. The dropdown lists active employees, is searchable, shows the name and the department, and the list can be searched by that name.
- **A read-only employee lookup, not a looser permission.** `GET /api/employees/for-select` returns only `{ id, fullName, designation, departmentName }` for anyone who may see a TRF. `employees.manage` was not touched.
- **Stage and Final Status are two different things.** The Stage dropdown lists the stages of the `ard_stages` master table (see Phase 14) while the Final Status dropdown keeps the four workflow values (Received, In Progress, Completed, Cancelled) and is shown as a coloured pill. The two live in separate columns and are never mixed.
- **Final Status rules.** Setting **Completed** requires an Analyst Name and a Date of Analysis; without them the server answers 400 and names the field. Reaching Completed (or Cancelled) stamps `finalized_at`, which freezes the TAT. Moving back out of a terminal state clears `finalized_at` and the TAT counts to today again. Every change is written to `ard_status_history` and audited.
- **TAT is computed, never stored.** It is the number of calendar days from the Date of Analysis to `finalized_at` (or to today while the request is open), and is empty when there is no Date of Analysis.
- **Ownership is enforced on the server and shown in the UI.** Formulation users (plus Admin and Manager) edit everything in Part A, including Sample Submitted By and the Formulation Status. ARD users (plus Admin and Manager) edit only ARD items 2, 5, 6, 7, 8, 9 and 11. Items 1, 3, 4 and 10 are read-only for everybody. An ARD Analyst can set the Final Status — the ard-status route never asks for `trf.changeStatus`.
- **The form reads like a form.** Two titled cards, a responsive two-column grid, inline field errors, clear read-only styling, a sticky Save bar and a progress stepper that highlights the current Final Status.

## Behaviour implemented in Phase 12
- **ARD Tracking on the TRF record.** ARD Analysis Details (Part B) live as columns directly on the `trfs` table — no separate `ards` table. An `ard_number` (`ARD-YYYY-NNNNN`) is generated when a TRF is created and stored on the same row. TAT is computed in SQL (`analysis_start_date` to today, or to the `finalized_at` timestamp on terminal states) and never stored. An `ard_status_history` table records every workflow transition.
- **Department-based permissions.** Formulation department members (plus any Admin) may create and edit TRF fields (Part A). ARD department members (plus Admin and Manager) may edit ARD fields (Part B) and drive the ARD workflow. Analysts can view ARDs but cannot edit them; the existing test Analysts created without a department are still refused at the server.
- **Workflow transitions and terminal lock.** ARDs move Received → In Progress → Completed (or Cancelled). Only Admin, Manager and ARD department users can reach the terminal states, which are locked thereafter: no further edits or transitions are accepted.
- **Reworked TRF form.** Thirteen new columns from the Formulation Team's paper form are surfaced on the create and edit screens: batch size, dosage form, manufacturing location, label claim, pack size, pack type, storage condition, storage period, manufacturing date, expiry date, analysis purpose, sample given by, and signature date. The form splits into a Part A (Formulation) and Part B (ARD) section, with each section shown only to the department that owns it. Date validation rejects an expiry date at or before the manufacturing date and a required-completion date before the TRF date.
- **Soft delete.** TRFs in `New` status can be soft-deleted (Admin or Formulation department only). The row is retained with `deleted_at` set so the number is never reused, but is hidden from every list and detail view.
- **Printable TRF.** A print view renders the full TRF on a single document with a dedicated print stylesheet and a Print button on both the detail and edit pages.
- **TRF list shows ARD status.** The TRF list now includes ARD Stage, ARD Analyst and TAT columns. Per-row edit and delete buttons appear based on department, and clicking a TRF number opens the detail page with an ARD Analysis Details panel and an ARD History tab.

## Behaviour implemented in Phase 11
- **Global search does what the README said it would.** Phase 3 promised the top-bar box would grow to cover analysis tests and certificate numbers; it had not, so a person holding a `COA-…` reference had nowhere to paste it. `GET /api/search` now answers all three record types in one call and returns three grouped lists: TRFs (number, product, batch, customer), analysis tests (name, parent TRF, result text) and certificates (number, or the TRF they belong to).
- **Search cannot widen what a person can see.** Each group applies the same scope rule as the list it mirrors — `trf.viewAll` for TRFs, `analysis.viewAll` for tests — so a search result is never a record the list page would refuse. Certificates follow the certificate list, which is not role-scoped; `coa.view` still has to be held to reach the route at all.
- **A draft certificate is still findable.** It has no number until issue, so it is matched on its TRF number and shown as "Draft (not numbered)" rather than as an empty row.
- **A search that fails says so.** A dropped connection is reported as a failed search, not as "no matches", because a silently empty result list reads as a correct answer.
- Enter opens the list of whichever group matched most, and each group's "see all" line drops the term into that list's own search filter, so the search box and the list always agree.
- The placeholder component for unbuilt modules is gone: every module in the navigation is now a real one.

## Behaviour implemented in Phase 10
- **The API writes a log.** `LOG_DIR` was configured but never used, so a deployed server had nothing on disk to look at. Each day's lines now go to `api-YYYY-MM-DD.log`, with 30 days kept and older files removed on their own. Rotating by date rather than by size means "yesterday's log" is always one file, whatever the traffic was.
- **Passwords and tokens never reach the log.** `Authorization` headers, `password`, `newPassword` and `refreshToken` are redacted at the logger, so the log can be attached to a support request.
- **Readiness is not liveness.** `/api/health/live` answers whenever the process is up, for a restart policy. `/api/health/ready` returns 200 only when PostgreSQL is reachable **and** migrations are applied, for a load balancer or an installer. A server that cannot reach its database returns 503 rather than a cheerful 200.
- **Shutdown drains.** On `SIGINT`/`SIGTERM` the server stops accepting connections, lets in-flight requests finish, and only then closes the database pool — in that order, so no request being served fails against a closed pool. A 20-second limit stops a stuck request from blocking a deployment.
- **An unhandled crash is logged and the process ends the way a supervisor expects**, rather than printing a stack trace to a console nobody is watching.
- **`npm run backup` makes a real backup.** `pg_dump` in custom format, named for the database and the moment, with 30 days of copies kept and zero-byte dumps discarded rather than left to look like a backup.
- **The dump tool is matched to the server's version.** A dump written by a newer `pg_dump` uses an archive format the server's own `pg_restore` refuses outright, so the script picks the matching installation and reports which it used. On a machine with two PostgreSQL versions this is the difference between a backup that restores and one that does not.
- `npm run backup:counts` prints the row counts per table, so a restore can be checked without trusting the file. Verified here by restoring a dump into a scratch database and comparing counts.
- The password reaches `pg_dump` through the environment, never the command line, and no process is run through a shell.
- **The installer is configured** (`electron-builder`, per-user NSIS, no administrator rights needed) and ships only the renderer, the main process and a default server address — no PostgreSQL, no credentials and no server code.
- The desktop app refuses to open a second window or navigate away, sends external links to the system browser, and adds `X-Content-Type-Options` beside its content-security policy.

## Behaviour implemented in Phase 9
- `GET /api/audit` reads the trail: search, filters for module, action, person, record and date range, sorting, paging, and a summary counted over **the same filter set as the list**, so a count beside a filter describes what selecting it would show.
- **The trail is read-only.** The router defines `GET` routes and nothing else, so there is no verb that can edit or delete a row. A gap in the record would be indistinguishable from a change nobody made.
- Only `audit.view` reads it: Admin and Manager. An Analyst and a Viewer are refused, which is also why the Audit Log export sheet is withheld from them.
- Every row reads as a person, a moment, a plain-English label and a tone. A failed sign-in or a lockout is red, an access change is amber, ordinary work is blue or green, and the tone is **derived from the action**, never stored, so a colour cannot disagree with what happened.
- A field change is shown as **field, was, became** — "Remarks: nothing → Phase 9 trail sample" — rather than as an opaque JSON blob. Only the fields that actually changed are listed, so a one-field edit does not print the whole record.
- A single-field edit is stored as `{ field, value }` on both sides. The reader recognises that shape, so the entry names the field rather than reporting a field called "value".
- A row with no previous state (a result recorded, a note added) reads as a summary instead of a list of changes from nothing.
- `GET /api/audit/record/:type/:ref` gives one record's history, newest first. This is the view that answers "why is this TRF like this?" without reading the whole trail.
- `GET /api/audit/vocabulary` offers only the modules and actions this installation has actually used, so a filter never lists a value nothing has written.
- Filters live in the URL, so a trail someone is reading can be shared internally. Sort fields are looked up against a fixed map, so an unknown field is refused rather than interpolated.
- **Sign-out is now recorded.** The employee is read from the refresh token before it is revoked, because afterwards there is nothing left to identify the sign-out by. A token that matches nothing is a safe no-op and is never attributed to anyone.
- The Audit Log exports to Excel with the filters currently applied, and its "When" column keeps the time to the second: two edits on the same day can be told apart.

## Behaviour implemented in Phase 8
- `GET /api/reports/export.xlsx` builds a real `.xlsx` workbook with ExcelJS on the server: **TRF Master, Analysis, Assignments, Employees, COA, Dashboard Data, Audit Log**. The renderer never receives the bytes.
- **The file is the list.** Export takes the same filter names the list endpoints read (search, status, employee, TRF number, date range, delayed, overdue), so what a person exports is what they were looking at. `mineOnly` on a list narrows the export too.
- **An export is not a backup.** Column headings are the words used in the lab, with no database id, version number or internal timestamp anywhere in the workbook.
- Every sheet has a frozen header row, an autofilter, landscape fit-to-width printing and status cells coloured the same as the on-screen badges. Dates are written as real Excel dates (`dd-mm-yyyy`), not text.
- **Scope is applied in SQL, per sheet.** A role without `trf.viewAll` (an Analyst) gets only their own TRFs, tests, assignments and certificates, and no Employees or Audit Log sheet at all.
- **A sheet is never granted that its own permission would refuse.** `sheetsFor` gates Employees on `employees.view` and Audit Log on `audit.view`, so a Viewer — who may read every TRF — still cannot obtain the employee directory or the audit trail through an export.
- Asking for a sheet the role may not have is **refused with a message**, not answered with a silently empty sheet.
- Over the **50,000-row ceiling the export is refused** and the employee is told to narrow the filters. A report someone will act on must not quietly lose its tail, so it is never truncated; the metadata records `truncated: false`.
- Every export writes one `report.exported` audit row naming the sheets, the filters as applied and the row count of each sheet. The row is written in its own transaction, so it survives independently of the read.
- The desktop app asks Electron for a save location first, downloads the workbook in the main process and writes it to disk directly. A large file never crosses the IPC boundary as a string, and nothing is written without the employee choosing where it lands.
- Export buttons appear on the TRF, Assignments, Analysis and COA lists and on a Reports screen, shown only to roles holding `reports.export`; the server re-checks regardless.
- `GET /api/reports/export-options` states the caller's scope, the sheets they may receive and the row ceiling, so the client never offers a button the server would refuse.

## Behaviour implemented in Phase 7
- `GET /api/dashboard` returns the whole dashboard in one response. Every figure is a SQL aggregate on the server; the client never counts or sorts anything itself, so a card cannot disagree with the list it links to.
- Scope follows the same rule as the lists: a role without `trf.viewAll` (an Analyst) sees only their own TRFs, their own tests and only the certificates they drafted or approved. The scope is applied inside each query, not to the result, so nothing leaks through a chart, a tooltip or a workload row.
- Twelve months of TRF receipts come from `generate_series`, so months with no work appear as zero instead of vanishing and stretching the axis.
- Every status appears exactly once per chart even at zero, so a bar chart never silently drops a state.
- Overdue and delayed use the same SQL expressions as the TRF and analysis lists. The dashboard is a second reading of one definition, not a second definition.
- The workload chart splits completed work into passed and failed using the shared outcome expression, so it matches the analysis list's Pass/Fail counts.
- Cards and chart bars are links into the list that produced them, carrying the same filter: "Overdue" opens `?overdueOnly=true`, "Delayed tests" opens the analysis list filtered to delayed.
- Colours carry meaning: blue is work in hand, amber is late, green is finished. An empty dashboard says what to do rather than showing a blank page.

## Behaviour implemented in Phase 6
- One certificate per TRF. Drafting is refused until every test is complete, and the TRF moves `Analysis Completed` → `COA Pending` in the same transaction.
- `coa_lines` is a **snapshot** of the results at the moment of drafting, not a join to the live result. A later re-test changes the analysis but never an issued certificate, so what a customer holds is what was measured that day.
- The certificate moves `Draft` → `Under Review` → `Approved` → `Issued` along the shared transition table. A step out of order is refused with the list of moves that are actually allowed.
- A send-back needs a written reason and clears the review stamp, so a returned draft has to be looked at again rather than slipping through on the same signature.
- **Separation of duties is enforced on the server**: the person who prepared a certificate cannot approve it.
- The number `COA-YYYY-NNNNN` is minted only on issue, inside the same transaction as the status change, from a locked counter. A withdrawn draft never burns a number. The database refuses an Issued certificate with no number at all.
- Issuing moves the TRF to `Completed` and writes the status history.
- An issued certificate is final: status steps and remarks edits are both refused, and only a version-checked update gets through. Every step is audited in the same transaction as the change.
- Certificate screen: summary counts over the current filters, search, status and date filters, sortable columns, paging, a draft picker limited to TRFs waiting for a certificate, and the printable certificate.
- Printing goes through the Electron main process and the print stylesheet: only the certificate reaches the printer, and the dialog is offered only for an issued certificate.
- A Viewer may read certificates and their history but may not draft, approve or issue. The certificate list can be exported as Excel (Phase 8).

## Behaviour implemented in Phase 5
- Each assigned test carries its own start date, completion date and remarks, and its measured value lives in `analysis_results`: a number or a reading in words, with unit, method used, specification limits and remarks.
- **Pass / Fail / Not Specified / Not Tested** is computed in SQL from the value and its limits, never stored, so the badge, the filter and a later COA cannot disagree. A result with no limits is *Not Specified*, which is deliberately not a pass.
- Values are stored exactly as read: plain `NUMERIC`, so `2.5` stays `2.5` with no invented trailing zeros and no lost precision.
- Only the analyst a test is assigned to may record a result or change its status. A Manager may reassign the work but may not enter a number on someone's behalf, so every result belongs to a named person.
- Status moves only along the shared transition table: start → record → complete, or request a re-test from a completed test. A re-test needs a written reason, clears the stored result and keeps the original start date so turnaround time still measures the whole job.
- A test cannot be completed without a recorded result, and a cancelled or completed test cannot be edited.
- The TRF follows its tests: starting work moves it `Assigned` → `In Progress`, and finishing the last test moves it to `Analysis Completed`, both inside the same transaction and both written to the status history.
- One result row per test: saving again corrects the reading rather than adding a second one, and the change is audited with the old and new value.
- Analysis screen: summary counts, search, status and outcome filters, sortable columns, "my work" versus "all analysis", and a result dialog. Counts come from the server over the same scope as the list, so they can never disagree with it.
- Analysts see only their own tests; the scope is applied in the query, not by filtering afterwards.
- Analysis can be exported as Excel, filtered exactly as the list is (Phase 8).

## Behaviour implemented in Phase 4
- `analysis_tests` is the unit of work: one row per test per TRF, with its own method, specification, employee, assigned date, due date and status. A unique index on `(trf_id, lower(test_name))` means a test cannot be assigned twice to the same TRF, whatever the employee or date.
- Assign several tests at once. The whole batch is one transaction: if any test is refused, none of them is assigned and the TRF is left exactly as it was. The TRF itself moves `New` → `Assigned` inside that same transaction, using the normal transition table, and the change is written to the status history.
- Assignment screens in three views: by TRF (TRF → test → employee), analyst workload (pending, in progress, delayed and completed counts per person), and my work. All filtering, sorting and pagination happen in SQL; the client never counts or sorts a list itself.
- **Delayed** is computed, not stored: a due date in the past on work that is neither completed nor cancelled. It is a filter and a badge, never a column that can disagree with the record.
- Reassignment, due-date changes and cancellation are version-checked and audited, naming the old and new employee.
- A Viewer or an inactive employee cannot be given a test; the form says so before the request is sent.
- `test_catalog` is an Admin-managed list of tests with a default method and specification. Naming a test that is in the catalogue fills in those defaults, so the same test is spelled the same way every time. Only an Admin edits the catalogue.
- A Completed or Cancelled TRF takes no further assignments, and a cancelled assignment cannot be edited afterwards.
- Analysts see only their own assignments, enforced in the query. The export carries the same scope.

## Behaviour implemented in Phase 3
- TRF list with server-side pagination, sorting on every column, search across TRF No., product, batch, customer and employee, and filters for status, priority, customer, product, department, date range and overdue. Filters live in the URL, so a filtered list can be shared internally.
- Create and edit TRFs. Customers and products can be created inline from the form by an Admin.
- Detail page with a status-history tab, employee assignment, and status changes limited to what the transition table allows.
- TRF numbers are generated as `TRF-YYYY-NNNNN` from a locked counter row inside the creating transaction: fifty simultaneous creates get fifty different, gap-free numbers.
- Overdue is computed in SQL from the due date and status, never stored, so it can never disagree with the record.
- Every edit is version-checked; a second save of a stale record gets the standard "changed by someone else" message and the client offers a reload instead of overwriting.
- Analysts and Viewers only receive their own TRFs, restricted inside the query rather than by filtering afterwards.
- Global search in the top bar searches TRFs live, and covers analysis tests and certificate numbers too (Phase 11).
- The list can be exported as Excel with the filters currently applied (Phase 8).

## Behaviour implemented in Phase 2
- Login screen. The top bar shows the signed-in employee's name, role and department, with a Sign out button.
- Tokens live only in the Electron main process's memory, are never written to disk or localStorage, and are refreshed automatically before they expire. A failed refresh returns to the login screen.
- A user with a pending password change is held on the change-password screen until it is done.
- Sidebar items are filtered by role; the server re-checks every request with the permission matrix in `packages/shared`.
- Employee module (Admin manages, Manager may list): pagination, search, role/status filters, create, edit, activate/deactivate, admin password reset, last-administrator protection.
- Brute-force protection locks an account for a configurable number of minutes after repeated failures; the form shows one generic message for unknown user, wrong password and inactive account.
- Deactivating a user ends their sessions immediately.

## Behaviour implemented in Phase 1
- Header shows SERVER CONNECTED / SERVER OFFLINE (polled every 10 s; offline also when the API's database is down).
- When offline, data screens show "Company server is unavailable. Please connect to the company network." Settings stays reachable, including before sign-in.
- No local database and no local copy of company data on the PC.
- During the build, modules not yet delivered were labelled "Not implemented yet" with the phase that would deliver them. That placeholder is gone as of Phase 11: every module in the sidebar is a working one.
