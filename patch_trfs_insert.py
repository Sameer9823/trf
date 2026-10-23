import re

with open('apps/server/src/routes/trfs.ts', 'r') as f:
    content = f.read()

# Fix the INSERT statement - remove sample_received_by from columns and fix placeholders
old_insert = """`INSERT INTO trfs (trf_number, trf_date, customer_id, product_id, batch_number, sample_quantity,
            sample_received_date, required_completion_date, priority, requested_analysis,
            special_instructions, department_id, remarks, batch_size, dosage_form,
            manufacturing_location, label_claim, pack_size, pack_type, storage_condition,
            storage_period, manufacturing_date, expiry_date, analysis_purpose,
            sample_given_by, sample_submitted_by_id, signature_date, created_by, remarks_status, ard_remarks_status, sample_received_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
          RETURNING id`,"""

new_insert = """`INSERT INTO trfs (trf_number, trf_date, customer_id, product_id, batch_number, sample_quantity,
            sample_received_date, required_completion_date, priority, requested_analysis,
            special_instructions, department_id, remarks, batch_size, dosage_form,
            manufacturing_location, label_claim, pack_size, pack_type, storage_condition,
            storage_period, manufacturing_date, expiry_date, analysis_purpose,
            sample_given_by, sample_submitted_by_id, signature_date, created_by, remarks_status, ard_remarks_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
          RETURNING id`,"""

content = content.replace(old_insert, new_insert)

with open('apps/server/src/routes/trfs.ts', 'w') as f:
    f.write(content)

print("Done")