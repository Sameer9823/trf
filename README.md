# TRF & Analysis Management System

Status: **all 11 phases complete** (scaffold, API skeleton, database migrations, connection-status shell, authentication, employees, roles and permissions, TRF management, work assignment, analysis results, certificates of analysis, dashboard, Excel reports and export, audit log, deployment, logging, backups, installer packaging, and the final integration pass).
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
- `npm test` runs the server test suite. Tests that need a database report as *skipped* when PostgreSQL is not reachable, so a green run never claims untested coverage. See `docs/testing.md` for how to point the suite at a throwaway test database.

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
