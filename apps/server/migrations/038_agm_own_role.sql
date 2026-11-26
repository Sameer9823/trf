-- Migration 038: AGM designation resolves to its own AGM role (not Admin).
-- GM and COO designations resolve to Admin role.
--
-- This reverses the "AGM is a designation, not a role" decision of migration 017,
-- which folded AGM into the Admin role. AGM now has its own role and cannot
-- give the final approval or lock a TRF; only role Admin can.
--
-- Idempotent: running it twice leaves the database unchanged the second time.
-- Aborts if, after the role changes, there would be no active Admin.
-- Does not touch shared team accounts.

-- 1. Widen the role check constraint to include 'AGM' before updating roles.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
  CHECK (role IN ('Admin', 'AGM', 'Manager', 'Analyst', 'Viewer'));

-- 2. AGM designation holders with role Admin become role AGM.
--    Exclude shared team accounts explicitly.
UPDATE employees
SET role = 'AGM'
WHERE designation = 'AGM'
  AND role = 'Admin'
  AND is_active = TRUE
  AND account_type <> 'SHARED_TEAM';

-- 3. GM and COO designation holders whose role is not Admin become Admin.
--    This covers legacy role 'GM' and any other non-Admin role.
--    Exclude shared team accounts explicitly.
UPDATE employees
SET role = 'Admin'
WHERE designation IN ('GM', 'COO')
  AND role <> 'Admin'
  AND is_active = TRUE
  AND account_type <> 'SHARED_TEAM';

-- 4. Extend the shared-team-not-admin check to cover AGM as well.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_shared_not_admin_check;
ALTER TABLE employees ADD CONSTRAINT employees_shared_not_admin_check
  CHECK (account_type <> 'SHARED_TEAM' OR role NOT IN ('Admin', 'AGM'));

-- 5. Abort if, after the changes, there would be no active Admin.
--    (Skip when the table has no active employees at all, e.g. a fresh install.)
DO $$
DECLARE
  admin_count INTEGER;
  employee_count INTEGER;
BEGIN
  SELECT count(*) INTO employee_count
  FROM employees WHERE is_active = TRUE;
  IF employee_count > 0 THEN
    SELECT count(*) INTO admin_count
    FROM employees
    WHERE role = 'Admin' AND is_active = TRUE;
    IF admin_count = 0 THEN
      RAISE EXCEPTION 'Migration 038 aborted: no active Admin would remain after moving AGM designations to the AGM role. Ensure at least one active Admin exists before running.';
    END IF;
  END IF;
END $$;
