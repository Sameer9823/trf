-- Migration 030: TRF Submit to AGM and AGM Complete Workflow
-- Idempotent: running it twice leaves the database unchanged the second time.

-- 1. Add ARD submission and AGM completion columns to trfs
ALTER TABLE trfs
  ADD COLUMN IF NOT EXISTS ard_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ard_submitted_by INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS ard_submit_note TEXT,
  ADD COLUMN IF NOT EXISTS completed_by_agm INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trfs_ard_submitted ON trfs (ard_submitted_at) WHERE ard_submitted_at IS NOT NULL;

-- 2. Extend trf_approvals status CHECK to include 'Reopened' (idempotent)
DO $$
DECLARE
  constraint_name text;
  existing_check text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'trf_approvals'::regclass
    AND contype = 'c';
  IF constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE trf_approvals DROP CONSTRAINT ' || quote_ident(constraint_name);
  END IF;
  ALTER TABLE trf_approvals
    ADD CONSTRAINT trf_approvals_status_check
    CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Returned', 'Reopened'));
END $$;

-- 3. Extend ard_test_assignment_history action CHECK to include result actions (idempotent)
-- Drop the old constraint if it exists (by any name)
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'ard_test_assignment_history'::regclass
    AND contype = 'c';
  IF constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE ard_test_assignment_history DROP CONSTRAINT ' || quote_ident(constraint_name);
  END IF;
  ALTER TABLE ard_test_assignment_history
    ADD CONSTRAINT ard_test_assignment_history_action_check
    CHECK (action IN ('ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'STATUS_CHANGED', 'RESULT_ENTERED', 'RESULT_CHANGED'));
END $$;

-- 4. Add analysis_start_date, completion_date, completed_by to ard_test_assignments
ALTER TABLE ard_test_assignments
  ADD COLUMN IF NOT EXISTS analysis_start_date DATE,
  ADD COLUMN IF NOT EXISTS completion_date DATE,
  ADD COLUMN IF NOT EXISTS completed_by INTEGER REFERENCES employees(id);

-- 5. Add CHECK: completion_date requires analysis_start_date
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ard_test_assignments_completion_requires_start'
       AND conrelid = 'ard_test_assignments'::regclass
  ) THEN
    ALTER TABLE ard_test_assignments
      ADD CONSTRAINT ard_test_assignments_completion_requires_start
      CHECK (completion_date IS NULL OR analysis_start_date IS NOT NULL);
  END IF;
END $$;

-- 6. Create ard_assignment_results table (stores test results for each assignment)
CREATE TABLE IF NOT EXISTS ard_assignment_results (
  id                      BIGSERIAL PRIMARY KEY,
  assignment_id           BIGINT NOT NULL REFERENCES ard_test_assignments(id) ON DELETE CASCADE,
  result_value            TEXT,
  result_text             TEXT,
  unit                    TEXT,
  method_used             TEXT,
  specification           TEXT,
  lower_limit             TEXT,
  upper_limit             TEXT,
  outcome                 TEXT CHECK (outcome IN ('Pass', 'Fail', 'NA')),
  remarks                 TEXT,
  entered_by              INTEGER REFERENCES employees(id),
  entered_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ard_assignment_results_assignment ON ard_assignment_results (assignment_id);
CREATE INDEX IF NOT EXISTS idx_ard_assignment_results_entered_by ON ard_assignment_results (entered_by);

-- Only create trigger if it does not exist (IF NOT EXISTS on trigger requires PG 15+)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ard_assignment_results_updated'
  ) THEN
    CREATE TRIGGER trg_ard_assignment_results_updated BEFORE UPDATE ON ard_assignment_results
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;