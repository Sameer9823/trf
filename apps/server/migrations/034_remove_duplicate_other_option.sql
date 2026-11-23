-- Migration 034: Remove duplicate 'Other' entry from dosage_form_options
-- The MultiSelect component handles the "Other" option via the showOther prop,
-- so having 'Other' in the database creates a duplicate entry in the dropdown.
-- This migration removes the database 'Other' entry.

DELETE FROM dosage_form_options WHERE name = 'Other';