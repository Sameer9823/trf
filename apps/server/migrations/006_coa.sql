-- Phase 6: Certificates of Analysis. One COA per TRF, built from that TRF's
-- completed test results and then frozen once issued.

CREATE TABLE coas (
  id             SERIAL PRIMARY KEY,
  trf_id         INTEGER NOT NULL UNIQUE REFERENCES trfs(id) ON DELETE CASCADE,
  coa_number     TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending', 'Draft', 'Under Review', 'Approved', 'Issued')),
  remarks        TEXT,
  prepared_by    INTEGER REFERENCES employees(id),
  prepared_at    TIMESTAMPTZ,
  reviewed_by    INTEGER REFERENCES employees(id),
  reviewed_at    TIMESTAMPTZ,
  approved_by    INTEGER REFERENCES employees(id),
  approved_at    TIMESTAMPTZ,
  issued_by      INTEGER REFERENCES employees(id),
  issued_at      TIMESTAMPTZ,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A step that stamps a time must also name the person who did it.
  CONSTRAINT ck_coas_preparer CHECK ((prepared_by IS NULL) = (prepared_at IS NULL)),
  CONSTRAINT ck_coas_reviewer CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CONSTRAINT ck_coas_approver CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT ck_coas_issuer CHECK ((issued_by IS NULL) = (issued_at IS NULL)),
  -- Only an Issued certificate carries a number: a draft has nothing to identify yet.
  CONSTRAINT ck_coas_issued_number CHECK (status <> 'Issued' OR coa_number IS NOT NULL)
);
CREATE INDEX idx_coas_status ON coas (status);
CREATE INDEX idx_coas_created ON coas (created_at DESC);

-- The lines are a snapshot taken when the certificate is drafted. An issued
-- certificate must still show what was measured on the day, even if a later
-- re-test changes the live result, so the values are copied rather than joined.
CREATE TABLE coa_lines (
  id             SERIAL PRIMARY KEY,
  coa_id         INTEGER NOT NULL REFERENCES coas(id) ON DELETE CASCADE,
  analysis_test_id INTEGER REFERENCES analysis_tests(id) ON DELETE SET NULL,
  test_name      TEXT NOT NULL,
  test_method    TEXT,
  specification  TEXT,
  result_value   NUMERIC,
  result_text    TEXT,
  unit           TEXT,
  lower_limit    NUMERIC,
  upper_limit    NUMERIC,
  outcome        TEXT NOT NULL
                   CHECK (outcome IN ('Pass', 'Fail', 'Not Specified', 'Not Tested')),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_coa_lines_coa ON coa_lines (coa_id, sort_order);

CREATE TRIGGER trg_coas_updated BEFORE UPDATE ON coas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
