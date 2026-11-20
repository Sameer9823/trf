-- Migration 016: Audit attribution, system settings, and backfill.
--
-- Continuation of shared team accounts feature.

-- 7. Add acting_employee_id and account_id to audit_logs for attribution
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES team_accounts(id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_employee_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_account ON audit_logs (account_id);

-- 8. Add acting_employee_id and account_id to trf_status_history and ard_status_history
ALTER TABLE trf_status_history
  ADD COLUMN IF NOT EXISTS actor_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES team_accounts(id);

ALTER TABLE ard_status_history
  ADD COLUMN IF NOT EXISTS actor_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES team_accounts(id);

-- 9. Add acting_employee_id and account_id to trfs for created_by/updated_by attribution
ALTER TABLE trfs
  ADD COLUMN IF NOT EXISTS actor_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES team_accounts(id);

-- 10. Add acting_employee_id and account_id to analysis_tests, analysis_results, coas
ALTER TABLE analysis_tests
  ADD COLUMN IF NOT EXISTS actor_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES team_accounts(id);

-- analysis_results table (from migration 005)
ALTER TABLE analysis_results
  ADD COLUMN IF NOT EXISTS actor_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES team_accounts(id);

-- coas table (from migration 006)
ALTER TABLE coas
  ADD COLUMN IF NOT EXISTS actor_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES team_accounts(id);

-- 11. Settings table for REQUIRE_MEMBER_PIN and other shared-team settings
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_system_settings_updated BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO system_settings (key, value, description)
VALUES
  ('REQUIRE_MEMBER_PIN', 'true', 'Require 4-6 digit PIN for team member selection'),
  ('IDLE_LOCK_MINUTES', '10', 'Minutes of inactivity before auto-lock to name selection screen'),
  ('PIN_MAX_ATTEMPTS', '5', 'Maximum failed PIN attempts before lockout'),
  ('PIN_LOCK_MINUTES', '15', 'Minutes to lock PIN after max failed attempts'),
  ('MAIL_ENABLED', 'false', 'Enable/disable email sending (dev switch)')
ON CONFLICT (key) DO NOTHING;

-- 12. Backfill existing FRD/ARD employees: set account_type and team based on department
-- This is a best-effort backfill; Admin should review and correct.
UPDATE employees e
SET account_type = 'SHARED_TEAM',
    team = CASE
      WHEN d.name ILIKE '%formulation%' THEN 'FRD'
      WHEN d.name ILIKE '%ard%' OR d.name ILIKE '%analytical%' OR d.name ILIKE '%quality control%' OR d.name ILIKE '%qc%' THEN 'ARD'
      ELSE NULL
    END
FROM departments d
WHERE e.department_id = d.id
  AND e.account_type = 'INDIVIDUAL'
  AND (d.name ILIKE '%formulation%' OR d.name ILIKE '%ard%' OR d.name ILIKE '%analytical%' OR d.name ILIKE '%quality control%' OR d.name ILIKE '%qc%');

-- Report what was matched
DO $$
DECLARE
  frd_count integer;
  ard_count integer;
BEGIN
  SELECT count(*) INTO frd_count FROM employees WHERE team = 'FRD' AND account_type = 'SHARED_TEAM';
  SELECT count(*) INTO ard_count FROM employees WHERE team = 'ARD' AND account_type = 'SHARED_TEAM';
  RAISE NOTICE 'Backfilled % FRD team members and % ARD team members as SHARED_TEAM', frd_count, ard_count;
END $$;