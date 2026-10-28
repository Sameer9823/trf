-- Migration 017: Admin-only approvals with a final lock, designations, Sample Received By,
-- and a team login that can no longer be mistaken for an employee.
--
-- Idempotent: running it twice leaves the database unchanged the second time.

-- 1. Sample Received By is an employee, like Sample Submitted By. It is the last item of the ARD block.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS sample_received_by_id INTEGER REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_trfs_sample_received_by_id ON trfs (sample_received_by_id);

-- 2. GM and AGM are designations, not roles. Both become Admin, as does COO.
UPDATE employees SET role = 'Admin' WHERE role IN ('GM', 'AGM');
UPDATE employees SET role = 'Admin' WHERE designation IN ('AGM', 'GM', 'COO') AND role <> 'Admin';
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
  CHECK (role IN ('Admin', 'Manager', 'Analyst', 'Viewer'));

-- 3. An administrator signs in as themselves, never through a shared team login,
--    so every approval names one person.
UPDATE employees SET account_type = 'INDIVIDUAL', team = NULL, pin_hash = NULL,
       pin_failed_attempts = 0, pin_locked_until = NULL
 WHERE role = 'Admin' AND account_type = 'SHARED_TEAM';
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_shared_not_admin_check;
ALTER TABLE employees ADD CONSTRAINT employees_shared_not_admin_check
  CHECK (account_type <> 'SHARED_TEAM' OR role <> 'Admin');

-- 4. Approvals and the lock. The Formulation approval keeps living in remarks_status
--    (Pending / Approved / Rejected); these columns record who decided and when.
ALTER TABLE trfs
  ADD COLUMN IF NOT EXISTS formulation_decided_by INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS formulation_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS final_approval_status TEXT NOT NULL DEFAULT 'None',
  ADD COLUMN IF NOT EXISTS final_decided_by INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS final_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES employees(id);
ALTER TABLE trfs DROP CONSTRAINT IF EXISTS trfs_final_approval_status_check;
ALTER TABLE trfs ADD CONSTRAINT trfs_final_approval_status_check
  CHECK (final_approval_status IN ('None', 'Pending', 'Approved', 'Rejected'));
CREATE INDEX IF NOT EXISTS idx_trfs_final_approval ON trfs (final_approval_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trfs_locked ON trfs (locked_at) WHERE locked_at IS NOT NULL;

-- The decision log can be written by an administrator who has no team account.
ALTER TABLE trf_approvals ALTER COLUMN requested_by_account_id DROP NOT NULL;
ALTER TABLE trf_approvals DROP CONSTRAINT IF EXISTS trf_approvals_status_check;
ALTER TABLE trf_approvals ADD CONSTRAINT trf_approvals_status_check
  CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Returned', 'Reopened'));
ALTER TABLE trf_approvals ADD COLUMN IF NOT EXISTS decided_by_account_id INTEGER REFERENCES team_accounts(id);

-- 5. Team login. A refresh token belongs to an employee or to a team account, never both,
--    and for a team account it remembers which member is acting so a refresh keeps them.
ALTER TABLE refresh_tokens ALTER COLUMN employee_id DROP NOT NULL;
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS team_account_id INTEGER REFERENCES team_accounts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS acting_employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_owner_check;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_owner_check
  CHECK ((employee_id IS NOT NULL) <> (team_account_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_team ON refresh_tokens (team_account_id, acting_employee_id);

-- A shared password is the most valuable one in the system: lock it after repeated failures.
ALTER TABLE team_accounts
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- 6. The audit trail outlives the people in it. Removing an employee must never be blocked by,
--    or delete, the record of what they did: the row keeps the name it was written with.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_employee_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_employee_id_fkey
  FOREIGN KEY (actor_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_account_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES team_accounts(id) ON DELETE SET NULL;
