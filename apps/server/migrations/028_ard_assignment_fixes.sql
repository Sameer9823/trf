-- Migration 028: ARD Assignment Fixes
-- Add version column, deduplicate, add unique constraint

-- 1. Add version column to ard_test_assignments if missing
ALTER TABLE ard_test_assignments
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 2. Deduplicate: keep the lowest id per (trf_id, test_requested_option_id)
--    First, reassign analysts from duplicates to the survivor
-- Use a temporary table to hold duplicate IDs since CTEs are not reusable across statements
CREATE TEMP TABLE temp_duplicates AS
SELECT id
FROM (
    SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY trf_id, test_requested_option_id ORDER BY id) AS rn
    FROM ard_test_assignments
) ranked
WHERE rn > 1;

CREATE TEMP TABLE temp_survivors AS
SELECT trf_id, test_requested_option_id, MIN(id) AS survivor_id
FROM ard_test_assignments
GROUP BY trf_id, test_requested_option_id
HAVING COUNT(*) > 1;

-- Move analysts from duplicates to survivors
UPDATE ard_test_assignment_analysts ataa
SET assignment_id = s.survivor_id
FROM temp_duplicates d
JOIN temp_survivors s ON s.trf_id = (SELECT trf_id FROM ard_test_assignments WHERE id = d.id)
                    AND s.test_requested_option_id = (SELECT test_requested_option_id FROM ard_test_assignments WHERE id = d.id)
WHERE ataa.assignment_id = d.id;

-- Delete duplicate assignment rows
DELETE FROM ard_test_assignments
WHERE id IN (SELECT id FROM temp_duplicates);

DROP TABLE temp_duplicates;
DROP TABLE temp_survivors;

-- 3. Add UNIQUE constraint on (trf_id, test_requested_option_id) if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ard_test_assignments_trf_test_unique'
    ) THEN
        ALTER TABLE ard_test_assignments
            ADD CONSTRAINT ard_test_assignments_trf_test_unique
            UNIQUE (trf_id, test_requested_option_id);
    END IF;
END $$;

-- 4. Add due_date column if missing (for completeness)
ALTER TABLE ard_test_assignments
    ADD COLUMN IF NOT EXISTS due_date DATE;