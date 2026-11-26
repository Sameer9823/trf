# Database Migrations

This directory contains SQL migration files that are applied in numerical order to set up and evolve the TRF system database schema.

## Migration Files

The files in this directory are the source of truth; they are applied in
numerical order and `schema_migrations` records which have been applied. This
section used to carry a hand-maintained table of every file, which drifted as
migrations were added — the folder listing wins.

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
- **Migration 038 reverses migration 017's designation folding:** migration 017
  folded AGM into the Admin role; migration 038 gives AGM its own role. Run
  migration 038 only after ensuring at least one active Admin exists (it aborts
  otherwise).

### Before deploying 038

Run these read-only queries against the production database and review the rows
they return before applying the migration:

**GM/COO employees not at Admin role** (will be promoted to Admin by step 3):

```sql
SELECT username, role, designation FROM employees
WHERE is_active AND designation IN ('GM','COO') AND role <> 'Admin';
```

**Inactive AGM employees at role Admin** (would come back as Admin with AGM designation;
step 2 only touches active rows, so these are not changed by the migration):

```sql
SELECT username, role, designation FROM employees
WHERE NOT is_active AND designation = 'AGM' AND role = 'Admin';
```

**Count of active Admins** (the migration aborts if this would be 0 after changes):

```sql
SELECT count(*) FROM employees WHERE is_active AND role = 'Admin';
```

If the first query returns rows you did not intend to promote, correct their role
or designation before running 038. If the second query returns rows, decide whether
they should remain inactive or be corrected before reactivation. If the third query
returns 0 or 1, ensure at least one other active Admin exists first (038 aborts
when no active Admin would remain).

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