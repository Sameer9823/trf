-- Phase 5: analysis results. A test gains dates and remarks; the measured value
-- lives in analysis_results, one row per test.

ALTER TABLE analysis_tests
  ADD COLUMN start_date      DATE,
  ADD COLUMN completion_date DATE,
  ADD COLUMN remarks         TEXT,
  -- A completion date without a start date would make the turnaround unmeasurable.
  ADD CONSTRAINT ck_analysis_tests_dates CHECK (completion_date IS NULL OR start_date IS NOT NULL);

CREATE TABLE analysis_results (
  id                SERIAL PRIMARY KEY,
  -- One result per test. Re-testing reopens the same row rather than adding history,
  -- because the audit log already keeps what each attempt read.
  analysis_test_id  INTEGER NOT NULL UNIQUE REFERENCES analysis_tests(id) ON DELETE CASCADE,
  -- Numeric where the test produces a number, text where it does not (a colour, a pH).
  -- Plain NUMERIC, not a scaled type: the value is stored exactly as it was read,
  -- with no trailing zeros invented and none of the analyst's digits lost.
  result_value      NUMERIC,
  result_text       TEXT,
  unit              TEXT,
  method_used       TEXT,
  -- Specification limits copied from the catalogue when the test was assigned.
  lower_limit       NUMERIC,
  upper_limit       NUMERIC,
  remarks           TEXT,
  entered_by        INTEGER REFERENCES employees(id),
  entered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A result is either a number or a reading; a numeric result may be judged against limits.
  CONSTRAINT ck_analysis_results_value CHECK (result_value IS NOT NULL OR result_text IS NOT NULL),
  CONSTRAINT ck_analysis_results_limits CHECK (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
);
CREATE INDEX idx_analysis_results_entered_by ON analysis_results (entered_by);
CREATE TRIGGER trg_analysis_results_updated BEFORE UPDATE ON analysis_results
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Speed for "every open test for this analyst" and for the outcome filter.
CREATE INDEX idx_analysis_tests_open ON analysis_tests (assigned_employee_id, status)
  WHERE status NOT IN ('Completed', 'Cancelled');
CREATE INDEX idx_analysis_tests_trf_completion ON analysis_tests (trf_id, completion_date);
