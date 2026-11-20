-- 1. Create manufacturing location options lookup table
CREATE TABLE IF NOT EXISTS manufacturing_location_options (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Insert default locations
INSERT INTO manufacturing_location_options (name, country, display_order) VALUES
  ('Chennai, India', 'India', 1),
  ('Cuddalore, India', 'India', 2),
  ('Mumbai, India', 'India', 3)
ON CONFLICT (name) DO NOTHING;

-- 3. Add index for active lookups
CREATE INDEX IF NOT EXISTS idx_manufacturing_location_options_active
  ON manufacturing_location_options (is_active, display_order);

-- 4. Keep the existing free-text manufacturing_location column on trfs for backward compatibility
-- The new UI will use the dropdown, but existing data remains in the text column

-- 5. Optional: Add a view that combines lookup name with free-text for display
CREATE OR REPLACE VIEW trf_manufacturing_location_display AS
SELECT
  t.id AS trf_id,
  COALESCE(mlo.name, t.manufacturing_location) AS manufacturing_location
FROM trfs t
LEFT JOIN manufacturing_location_options mlo ON mlo.name = t.manufacturing_location
WHERE t.deleted_at IS NULL;