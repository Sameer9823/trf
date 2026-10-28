-- Migration 021: Add Generic Name to products, Dosage Form options, and Test Requested multi-select
-- This migration adds:
-- 1. generic_name column to products table
-- 2. dosage_form_options lookup table with 17 predefined options
-- 3. test_requested_options lookup table with 28 predefined test options
-- 4. trf_test_requested junction table for multi-select test requests on TRFs

-- 1. Add generic_name to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS generic_name TEXT;

-- 2. Create dosage_form_options lookup table
CREATE TABLE IF NOT EXISTS dosage_form_options (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dosage_form_options_active ON dosage_form_options (is_active, display_order);
CREATE TRIGGER trg_dosage_form_options_updated BEFORE UPDATE ON dosage_form_options
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Insert the 17 predefined dosage form options
INSERT INTO dosage_form_options (name, display_order) VALUES
  ('Granules', 1),
  ('Powders', 2),
  ('Effervescent Granules', 3),
  ('Effervescent Powder', 4),
  ('Uncoated tablets', 5),
  ('Coated tablets', 6),
  ('Emulsion', 7),
  ('Suspension', 8),
  ('Effervescent Tablets', 9),
  ('Dispersible Tablets', 10),
  ('Gummies', 11),
  ('Ready-to-drink sachet', 12),
  ('Sachet', 13),
  ('Capsules', 14),
  ('Ready-to-Mix Sachet', 15),
  ('Soft Gel Capsules', 16),
  ('Liquid Shots', 17)
ON CONFLICT (name) DO NOTHING;

-- 3. Create test_requested_options lookup table
CREATE TABLE IF NOT EXISTS test_requested_options (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_test_requested_options_active ON test_requested_options (is_active, display_order);
CREATE TRIGGER trg_test_requested_options_updated BEFORE UPDATE ON test_requested_options
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Insert the 28 predefined test requested options
INSERT INTO test_requested_options (name, display_order) VALUES
  ('Appearance / Description', 1),
  ('Identification', 2),
  ('Loss On Drying', 3),
  ('Assay', 4),
  ('Particle Size Distribution by sieve shaker', 5),
  ('Particle Size Distribution by Anton Paar', 6),
  ('Microbial Test', 7),
  ('Residual Solvents', 8),
  ('pH', 9),
  ('Dissolution', 10),
  ('Multimedia Dissolution', 11),
  ('BD, TD', 12),
  ('Sedimentation', 13),
  ('Redispersibility', 14),
  ('Water Content', 15),
  ('Globule Size Determination using Anton Paar', 16),
  ('Zeta Potential', 17),
  ('XRPD Analysis', 18),
  ('DSC Analysis', 19),
  ('Melting Point', 20),
  ('SEM', 21),
  ('TEM', 22),
  ('Saturated Solubility & Solution Stability', 23),
  ('Related Substances', 24),
  ('Surface Free Oil', 25),
  ('Complete analysis as per COA', 26),
  ('Complete analysis as per specification', 27),
  ('Blend Uniformity', 28)
ON CONFLICT (name) DO NOTHING;

-- 4. Create trf_test_requested junction table for multi-select test requests on TRFs
CREATE TABLE IF NOT EXISTS trf_test_requested (
  id                    BIGSERIAL PRIMARY KEY,
  trf_id                INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  test_requested_option_id INTEGER NOT NULL REFERENCES test_requested_options(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            INTEGER REFERENCES employees(id),
  UNIQUE (trf_id, test_requested_option_id)
);
CREATE INDEX idx_trf_test_requested_trf ON trf_test_requested (trf_id);
CREATE INDEX idx_trf_test_requested_option ON trf_test_requested (test_requested_option_id);

-- 5. Add generic_name to trfs table for denormalized storage (for reporting/printing)
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS generic_name TEXT;

-- 6. Update existing products with generic names from the mapping
-- This will be done via a separate seed script or manually