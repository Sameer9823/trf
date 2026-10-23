-- Migration 013: Drop sample_received_by column if empty.
--
-- The "Sample Received By" field has been removed from the application code.
-- This migration checks if any row has a non-NULL sample_received_by value.
-- If the column is empty (all NULL), it is dropped. If it contains data,
-- the column is kept (unused by the application) and a notice is logged
-- so the operator can decide what to do with the orphaned data.

DO $$
DECLARE
  non_null_count integer;
BEGIN
  SELECT count(*) INTO non_null_count
  FROM trfs
  WHERE sample_received_by IS NOT NULL;

  IF non_null_count = 0 THEN
    ALTER TABLE trfs DROP COLUMN IF EXISTS sample_received_by;
    DROP INDEX IF EXISTS idx_trfs_sample_received_by;
    RAISE NOTICE 'sample_received_by column dropped (was empty)';
  ELSE
    RAISE NOTICE 'sample_received_by column NOT dropped: % rows contain data. The column is now unused by the application.', non_null_count;
  END IF;
END $$;