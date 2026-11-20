# Database Migrations

This directory contains SQL migration files that are applied in numerical order to set up and evolve the TRF system database schema.

## Migration Files

| File | Description |
|------|-------------|
| `001_foundation.sql` | Phase 1 foundation: shared helpers (`set_updated_at()` trigger), lookup tables (`departments`, `number_counters`) |
| `002_employees_auth.sql` | Employee accounts, authentication, roles, designations, password hashing |
| `003_trf.sql` | Core TRF table, status workflow, TRF number generation |
| `004_assignments.sql` | Test assignments, test catalogue, dosage forms |
| `005_analysis.sql` | Analysis tests, results, COA (Certificate of Analysis) |
| `006_coa.sql` | COA templates, signatories, COA workflow |
| `007_ard_tracking.sql` | ARD (Analytical R&D) tracking tables |
| `008_ard_columns_on_trfs.sql` | ARD-specific columns added to TRFs |
| `009_idempotent_ard_and_seed.sql` | Idempotent ARD setup and seed data |
| `010_ard_remarks_status_and_seed.sql` | ARD remarks status, seed ARD stages |
| `011_sample_submitted_by_and_ard_stages.sql` | Sample submitted by field, ARD stages master |
| `012_ard_stages_master_and_reporting.sql` | ARD stages master table, reporting status |
| `013_drop_sample_received_by.sql` | Remove sample_received_by column |
| `014_shared_team_accounts.sql` | Team/shared login accounts |
| `015_approvals_notifications_email.sql` | Approval workflow, notifications, email templates |
| `016_audit_attribution_settings.sql` | Audit log attribution, system settings |
| `017_admin_approvals_designations_team_login.sql` | Admin approvals, designations, team login |
| `018_system_settings.sql` | System settings table |
| `019_trf_documents.sql` | TRF document storage (PDF metadata) |
| `020_trf_performance_indexes.sql` | Performance indexes for TRF queries |
| `021_generic_name_dosage_form_test_requested.sql` | Generic name, dosage form, test requested fields |
| `022_ard_analyst_assignment_workflow.sql` | ARD analyst assignment, workflow |
| `023_ard_approvals_locks.sql` | ARD approvals, TRF locking |
| `024_trf_lock_columns_views.sql` | TRF lock columns, views |
| `025_add_other_test_requested_option.sql` | Add "Other" test requested option |
| `026_trf_dosage_forms_other_and_ard_views.sql` | Dosage form "Other", ARD views |
| `027_manufacturing_location_options.sql` | Manufacturing location options |
| `027_ard_assignment_due_date_and_notifications.sql` | ARD assignment due dates, notifications |
| `028_ard_assignment_fixes.sql` | ARD assignment fixes |
| `030_trf_submit_and_complete.sql` | TRF submit and complete workflow |
| `031_form_sop_number.sql` | Form SOP number |
| `032_assignment_result_review.sql` | Assignment result review workflow |
| `033_trf_documents_secure_path.sql` | TRF documents secure path storage |

## Applying Migrations

Migrations are applied automatically on server startup via `npm run migrate` or by running:

```bash
npm run migrate -w @trf/server
```

Or directly with tsx:

```bash
npx tsx apps/server/src/migrate.ts
```

The migration runner (`migrate.ts`) tracks applied migrations in the `schema_migrations` table and only runs unapplied migrations in numerical order.

## Writing New Migrations

1. Create a new file with the next sequential number: `034_description.sql`
2. Write idempotent SQL (use `IF NOT EXISTS`, `ON CONFLICT`, etc.)
3. Test locally with a fresh database
4. Commit the migration file

## Safety Guidelines

- **Never modify existing migration files** after they have been applied to any environment
- **Always write idempotent SQL** - migrations may be run multiple times
- **Use transactions** where appropriate (the runner wraps each file in a transaction)
- **Test on a copy of production data** before applying to production
- **Back up the database** before running migrations in production

## Rollback

Migrations do not include automatic rollback. To rollback:
1. Restore from a pre-migration backup
2. Or write a new migration that reverses the changes (with a new number)

## Schema Migrations Table

The `schema_migrations` table tracks which migrations have been applied:

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```