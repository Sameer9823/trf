# Running the tests

The suite has two kinds of test:

- **Unit tests** (permissions, password hashing, tokens, transitions) run anywhere.
- **API tests** need a real PostgreSQL database, because they exercise real
  transactions, row locks and unique constraints. They are **skipped**, never
  silently passed, when no database is reachable.

## One-time setup on a development PC

Install PostgreSQL 14 or later, then create a throwaway database:

```sql
CREATE ROLE trf_test LOGIN PASSWORD 'trf_test';
CREATE DATABASE trf_test OWNER trf_test;
```

## Running the suite

```bash
# Windows PowerShell
$env:TEST_DATABASE_HOST='localhost'
$env:TEST_DATABASE_PORT='5432'
$env:TEST_DATABASE_NAME='trf_test'
$env:TEST_DATABASE_USER='trf_test'
$env:TEST_DATABASE_PASSWORD='trf_test'
npm test
```

Set `TEST_DATABASE_PORT` to whatever port your test cluster actually listens
on; use something other than `5432` when an unrelated server already owns it.

Without these variables the database tests report as skipped:

```
ℹ tests 207
ℹ pass 37
ℹ fail 0
ℹ skipped 170
```

With them, the run must end with zero failures and zero skips:

```
ℹ tests 207
ℹ pass 207
ℹ fail 0
ℹ skipped 0
```

Test files run one after another (`--test-concurrency=1`) on purpose: they share
one database, and the TRF number test asserts a gap-free counter. In parallel,
one file's TRFs would consume numbers another file is asserting on.

The export tests read the workbook back with ExcelJS rather than checking the
buffer, so the assertions cover what Excel would actually show: real date cells,
the frozen header, the autofilter and the column headings. They also read the
server from a Manager, an Analyst and a Viewer, because "who may export what" is
the part of this feature most likely to be wrong.

The audit tests check two things a list screen usually gets wrong. First, that the
summary counts are taken over the same filter set as the rows, so a figure beside
a filter can never contradict the list. Second, that the trail is genuinely
read-only: every write verb is attempted and the row count is compared before
and after.

The operations tests (`ops.test.ts`) run without a database, so they cover the
files a deployment depends on: which day's log a line belongs to, that pruning
keeps the newest copies and touches nothing else, and that the backup picks a
`pg_dump` matching the server's major version. The version match is the one that
matters most — a dump written by a newer `pg_dump` cannot be read back by the
server's own `pg_restore`, and it fails only on the day it is needed.

`npm run backup -w @trf/server` and the restore it implies are not covered by
the automated suite. They were verified by hand: a dump was taken, restored into
a scratch database, and the row counts compared.

The search tests (`api.search.test.ts`) read the same route the top-bar box uses
and check the part that is easy to get wrong: that the scope applied to a search
result is the same scope the corresponding list would use, so a search cannot
surface a record the list page would refuse. An Analyst's search is asserted to
exclude another Analyst's TRFs and tests, and an Admin's to include them. The
route is also checked with a term containing SQL, to confirm it is matched as
text and the `trfs` table is still there afterwards.

## What the tests clean up

Each test removes the rows it created. A run that ends with rows left in
`trfs` means a test failed before its cleanup line; reset before re-running:

```sql
TRUNCATE trfs, trf_status_history, ard_status_history, audit_logs, refresh_tokens CASCADE;
```

Migrations are applied once and recorded in `schema_migrations`. During
development, after editing a migration that has already run, clear the record
and undo what it created so it applies again:

```sql
-- Phase 4
DROP TABLE IF EXISTS analysis_tests, test_catalog;
DELETE FROM schema_migrations WHERE name = '004_assignments.sql';

-- Phase 5
DROP TABLE IF EXISTS analysis_results;
ALTER TABLE analysis_tests DROP COLUMN IF EXISTS start_date;
ALTER TABLE analysis_tests DROP COLUMN IF EXISTS completion_date;
ALTER TABLE analysis_tests DROP COLUMN IF EXISTS remarks;
ALTER TABLE analysis_tests DROP CONSTRAINT IF EXISTS ck_analysis_tests_dates;
DROP INDEX IF EXISTS idx_analysis_tests_open;
DROP INDEX IF EXISTS idx_analysis_tests_trf_completion;
DELETE FROM schema_migrations WHERE name = '005_analysis.sql';

-- Phase 6
DROP TABLE IF EXISTS coa_lines, coas;
DELETE FROM schema_migrations WHERE name = '006_coa.sql';

  -- Phase 12 (undo all Phase 12 migrations 007–009 so they re-apply cleanly)
  DROP TABLE IF EXISTS ard_status_history CASCADE;
  DROP TABLE IF EXISTS ards CASCADE;
  ALTER TABLE trfs DROP COLUMN IF EXISTS remarks_status;
  ALTER TABLE trfs DROP COLUMN IF EXISTS sample_received_by;
  ALTER TABLE trfs DROP COLUMN IF EXISTS ard_number;
  ALTER TABLE trfs DROP COLUMN IF EXISTS ard_stage;
  ALTER TABLE trfs DROP COLUMN IF EXISTS ard_analyst_id;
  ALTER TABLE trfs DROP COLUMN IF EXISTS analysis_start_date;
  ALTER TABLE trfs DROP COLUMN IF EXISTS reporting_status;
  ALTER TABLE trfs DROP COLUMN IF EXISTS coa_status;
  ALTER TABLE trfs DROP COLUMN IF EXISTS workflow_status;
  ALTER TABLE trfs DROP COLUMN IF EXISTS ard_remarks;
  ALTER TABLE trfs DROP COLUMN IF EXISTS finalized_at;
  ALTER TABLE trfs DROP COLUMN IF EXISTS deleted_at;
  ALTER TABLE trfs DROP COLUMN IF EXISTS deleted_by;
  ALTER TABLE trfs DROP COLUMN IF EXISTS batch_size;
  ALTER TABLE trfs DROP COLUMN IF EXISTS dosage_form;
  ALTER TABLE trfs DROP COLUMN IF EXISTS manufacturing_location;
  ALTER TABLE trfs DROP COLUMN IF EXISTS label_claim;
  ALTER TABLE trfs DROP COLUMN IF EXISTS pack_size;
  ALTER TABLE trfs DROP COLUMN IF EXISTS pack_type;
  ALTER TABLE trfs DROP COLUMN IF EXISTS storage_condition;
  ALTER TABLE trfs DROP COLUMN IF EXISTS storage_period;
  ALTER TABLE trfs DROP COLUMN IF EXISTS manufacturing_date;
  ALTER TABLE trfs DROP COLUMN IF EXISTS expiry_date;
  ALTER TABLE trfs DROP COLUMN IF EXISTS analysis_purpose;
  ALTER TABLE trfs DROP COLUMN IF EXISTS sample_given_by;
  ALTER TABLE trfs DROP COLUMN IF EXISTS signature_date;
   DELETE FROM schema_migrations WHERE name IN ('007_ard_tracking.sql', '008_ard_columns_on_trfs.sql', '009_idempotent_ard_and_seed.sql');
  ```

## Never point this at a real database

The suite truncates tables and creates employees. Always use a dedicated
test database.