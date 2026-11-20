-- Phase 1 foundation: shared helpers and lookup tables used by every later phase.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TABLE departments (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_departments_updated BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Gap-free-per-year number generator for TRF and COA numbers (used in Phases 3 and 6).
-- Increment with: INSERT ... ON CONFLICT (series, year) DO UPDATE SET last_value = number_counters.last_value + 1 RETURNING last_value
CREATE TABLE number_counters (
  series      TEXT NOT NULL,
  year        INTEGER NOT NULL,
  last_value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (series, year)
);
