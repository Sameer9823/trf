-- Migration 035: ARD result submission with text or PDF file.
-- Idempotent: running it twice leaves the database unchanged the second time.

-- 1. Result mode: 'text' (default, existing behaviour) or 'pdf' (a file is attached).
ALTER TABLE ard_assignment_results
  ADD COLUMN IF NOT EXISTS result_mode TEXT NOT NULL DEFAULT 'text';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ard_assignment_results_result_mode_check'
                 AND conrelid = 'ard_assignment_results'::regclass) THEN
    ALTER TABLE ard_assignment_results
      ADD CONSTRAINT ard_assignment_results_result_mode_check
      CHECK (result_mode IN ('text', 'pdf'));
  END IF;
END $$;

-- 2. File columns for PDF-mode results. file_relative_path is server-generated
--    and stored under DOCUMENT_DIR/ard-results/, never client-supplied.
ALTER TABLE ard_assignment_results
  ADD COLUMN IF NOT EXISTS file_relative_path TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS file_size INTEGER;

-- 3. Security: file_relative_path must not contain directory traversal (same rule
--    as trf_documents.relative_path in migration 033).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ard_assignment_results_file_path_check'
                 AND conrelid = 'ard_assignment_results'::regclass) THEN
    ALTER TABLE ard_assignment_results
      ADD CONSTRAINT ard_assignment_results_file_path_check
      CHECK (file_relative_path IS NULL
             OR (file_relative_path NOT LIKE '%/%'
                 AND file_relative_path NOT LIKE '%\%%'
                 AND file_relative_path NOT LIKE '%..%'));
  END IF;
END $$;

-- 4. A PDF-mode result must have a file attached.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ard_assignment_results_pdf_needs_file_check'
                 AND conrelid = 'ard_assignment_results'::regclass) THEN
    ALTER TABLE ard_assignment_results
      ADD CONSTRAINT ard_assignment_results_pdf_needs_file_check
      CHECK (result_mode <> 'pdf' OR file_relative_path IS NOT NULL);
  END IF;
END $$;

-- 5. Add RESULT_FILE_UPLOADED to the allowed history actions (migration 032 added the rest).
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'ard_test_assignment_history'::regclass AND contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE ard_test_assignment_history DROP CONSTRAINT ' || quote_ident(constraint_name);
  END LOOP;
  ALTER TABLE ard_test_assignment_history
    ADD CONSTRAINT ard_test_assignment_history_action_check
    CHECK (action IN ('ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'STATUS_CHANGED',
                      'RESULT_ENTERED', 'RESULT_CHANGED', 'RESULT_APPROVED', 'RESULT_REJECTED',
                      'RESULT_FILE_UPLOADED'));
END $$;