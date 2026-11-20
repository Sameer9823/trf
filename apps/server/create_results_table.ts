import { pool } from './src/db.js';

const sql = `-- Create ard_assignment_results table (stores test results for each assignment)
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
END $$;`;

console.log('Creating ard_assignment_results table...');
try {
  await pool.query('BEGIN');
  await pool.query(sql);
  await pool.query('COMMIT');
  console.log('Table created successfully');
} catch (err) {
  await pool.query('ROLLBACK');
  console.error('Failed:', (err as Error).message);
}
await pool.end();
