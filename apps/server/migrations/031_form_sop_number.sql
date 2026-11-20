-- Migration 031: the controlled TRF form is SOP QAQN-003:F1. An earlier default read QAGN:003:F1.
-- Only the old default is replaced; a number an administrator has typed is left alone.
UPDATE system_settings SET value = 'QAQN-003:F1' WHERE key = 'FORM_SOP_NO' AND value IN ('QAGN:003:F1', '');
