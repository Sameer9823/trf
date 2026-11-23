-- Migration 036: Allow NULL review_status on ard_assignment_results.
-- A PDF file can be uploaded before the result is submitted, which creates a
-- row with file info but no review decision yet. The result submission later
-- sets review_status = 'Submitted'.

ALTER TABLE ard_assignment_results ALTER COLUMN review_status DROP NOT NULL;
ALTER TABLE ard_assignment_results ALTER COLUMN review_status SET DEFAULT NULL;