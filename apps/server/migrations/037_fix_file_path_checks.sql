-- Migration 037: Fix the file-path CHECK constraints and the paths they guard.
--
-- The old constraints used `NOT LIKE '%\%%'`. In PostgreSQL LIKE, backslash is
-- the escape character, so that pattern actually means "contains a percent
-- sign": a backslash passed and a percent sign was refused. Uploads stored
-- 'ard-results/<name>.pdf' (or with a backslash on Windows), so the forward-slash
-- form was rejected on Linux and every upload was a 500.
--
-- position() has no escape rules, which is the point. Idempotent: running it
-- twice leaves the database unchanged the second time.

-- 1. ARD result files: drop the broken constraint, strip any folder from stored
--    paths, then re-add a correct constraint.
ALTER TABLE ard_assignment_results
  DROP CONSTRAINT IF EXISTS ard_assignment_results_file_path_check;

UPDATE ard_assignment_results
   SET file_relative_path = regexp_replace(file_relative_path, '^.*[/\\]', '')
 WHERE file_relative_path ~ '[/\\]';

ALTER TABLE ard_assignment_results
  ADD CONSTRAINT ard_assignment_results_file_path_check
  CHECK (file_relative_path IS NULL
         OR (position('/' in file_relative_path) = 0
             AND position(E'\\' in file_relative_path) = 0
             AND position('..' in file_relative_path) = 0));

-- 2. TRF documents: same replacement for the older constraint (relative_path is
--    NOT NULL there).
ALTER TABLE trf_documents
  DROP CONSTRAINT IF EXISTS chk_trf_documents_relative_path_no_traversal;

UPDATE trf_documents
   SET relative_path = regexp_replace(relative_path, '^.*[/\\]', '')
 WHERE relative_path ~ '[/\\]';

ALTER TABLE trf_documents
  ADD CONSTRAINT chk_trf_documents_relative_path_no_traversal
  CHECK (position('/' in relative_path) = 0
         AND position(E'\\' in relative_path) = 0
         AND position('..' in relative_path) = 0);