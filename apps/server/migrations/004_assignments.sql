-- Phase 4: work assignment. analysis_tests is the unit of work; one row per test per TRF.
-- Phase 5 adds the result columns (start_date, completion_date, remarks) and analysis_results.

-- Admin-managed list of tests, so the same test is spelled the same way every time.
CREATE TABLE test_catalog (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  default_method TEXT,
  specification TEXT,
  unit          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive: "Moisture" and "moisture" must be one catalogue entry.
CREATE UNIQUE INDEX uq_test_catalog_name_lower ON test_catalog (lower(name));
CREATE TRIGGER trg_test_catalog_updated BEFORE UPDATE ON test_catalog
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE analysis_tests (
  id                   SERIAL PRIMARY KEY,
  trf_id               INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  -- The same test cannot be assigned twice on one TRF, whatever the employee or due date.
  test_name            TEXT NOT NULL,
  test_method          TEXT,
  specification        TEXT,
  assigned_employee_id INTEGER REFERENCES employees(id),
  assigned_date        DATE,
  due_date             DATE,
  status               TEXT NOT NULL DEFAULT 'Pending'
                         CHECK (status IN ('Pending', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled')),
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_analysis_tests_trf_name UNIQUE (trf_id, test_name)
);
CREATE INDEX idx_analysis_tests_trf ON analysis_tests (trf_id);
CREATE INDEX idx_analysis_tests_employee ON analysis_tests (assigned_employee_id);
CREATE INDEX idx_analysis_tests_status ON analysis_tests (status);
CREATE INDEX idx_analysis_tests_due ON analysis_tests (due_date);
-- Supports "my open work, soonest due first" and the delayed computation.
CREATE INDEX idx_analysis_tests_employee_status_due ON analysis_tests (assigned_employee_id, status, due_date);
CREATE INDEX idx_analysis_tests_trf_status ON analysis_tests (trf_id, status);
CREATE TRIGGER trg_analysis_tests_updated BEFORE UPDATE ON analysis_tests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();