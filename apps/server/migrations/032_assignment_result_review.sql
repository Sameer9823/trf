-- Migration 032: test results are submitted by the assigned employee and reviewed (approved / rejected) by an AGM.
-- Idempotent: running it twice leaves the database unchanged the second time.

-- 1. Review state on each result. Results that already exist were accepted under the old flow, so they count as Approved.
ALTER TABLE ard_assignment_results
  ADD COLUMN IF NOT EXISTS review_status  TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by    INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_reason  TEXT;

UPDATE ard_assignment_results SET review_status = 'Approved', submitted_at = COALESCE(submitted_at, entered_at)
 WHERE review_status IS NULL;

ALTER TABLE ard_assignment_results
  ALTER COLUMN review_status SET DEFAULT 'Submitted',
  ALTER COLUMN review_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ard_assignment_results_review_status_check'
                 AND conrelid = 'ard_assignment_results'::regclass) THEN
    ALTER TABLE ard_assignment_results
      ADD CONSTRAINT ard_assignment_results_review_status_check
      CHECK (review_status IN ('Submitted', 'Approved', 'Rejected'));
  END IF;
END $$;

-- 2. One current result per test assignment (a resubmission replaces it; the history table keeps the trail).
DELETE FROM ard_assignment_results r
 USING ard_assignment_results newer
 WHERE r.assignment_id = newer.assignment_id AND r.id < newer.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ard_assignment_results_assignment ON ard_assignment_results (assignment_id);
CREATE INDEX IF NOT EXISTS idx_ard_assignment_results_review ON ard_assignment_results (review_status);

-- 3. History actions for the review decisions.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'ard_test_assignment_history'::regclass AND contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE ard_test_assignment_history DROP CONSTRAINT ' || quote_ident(constraint_name);
  END LOOP;
  ALTER TABLE ard_test_assignment_history
    ADD CONSTRAINT ard_test_assignment_history_action_check
    CHECK (action IN ('ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'STATUS_CHANGED',
                      'RESULT_ENTERED', 'RESULT_CHANGED', 'RESULT_APPROVED', 'RESULT_REJECTED'));
END $$;
