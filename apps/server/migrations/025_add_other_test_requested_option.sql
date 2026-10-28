-- Migration 025: Add "Other" option to test_requested_options
-- This migration adds the "Other" option as the 29th test requested option

INSERT INTO test_requested_options (name, display_order) VALUES
  ('Other', 29)
ON CONFLICT (name) DO NOTHING;

-- Add a column to store custom "Other" test descriptions
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS test_requested_other TEXT;