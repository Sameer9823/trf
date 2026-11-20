import { LIST_FIELD_ORDER, listFieldLabel } from '@trf/shared';

const TRF_MASTER_COLUMN: Record<string, { key: string; width?: number }> = {
  trfNumber: { key: 'trf_number', width: 18 },
  trfDate: { key: 'trf_date' },
  productName: { key: 'product_name', width: 26 },
  batchNumber: { key: 'batch_number', width: 18 },
  batchSize: { key: 'batch_size', width: 14 },
  customerName: { key: 'customer_name', width: 26 },
  dosageForm: { key: 'dosage_form', width: 16 },
  dosageFormOptions: { key: 'dosage_form_options', width: 24 },
  dosageFormOther: { key: 'dosage_form_other', width: 16 },
  manufacturingLocation: { key: 'manufacturing_location', width: 22 },
  labelClaim: { key: 'label_claim', width: 20 },
  packSize: { key: 'pack_size', width: 14 },
  packType: { key: 'pack_type', width: 14 },
  storageCondition: { key: 'storage_condition', width: 18 },
  storagePeriod: { key: 'storage_period', width: 16 },
  manufacturingDate: { key: 'manufacturing_date' },
  expiryDate: { key: 'expiry_date' },
  requestedAnalysis: { key: 'requested_analysis', width: 34 },
  specialInstructions: { key: 'special_instructions', width: 30 },
  analysisPurpose: { key: 'analysis_purpose', width: 24 },
  requiredCompletionDate: { key: 'required_completion_date' },
  sampleQuantity: { key: 'sample_quantity', width: 16 },
  sampleSubmittedByName: { key: 'sample_submitted_by_name', width: 24 },
  sampleReceivedByName: { key: 'sample_received_by_name', width: 24 },
  remarksStatus: { key: 'remarks_status', width: 16 },
  remarks: { key: 'remarks', width: 30 },
  signatureDate: { key: 'signature_date' },
  ardNumber: { key: 'ard_number', width: 18 },
  stage: { key: 'ard_stage', width: 20 },
  analystName: { key: 'analyst_name', width: 24 },
  analysisStartDate: { key: 'analysis_start_date' },
  reportingStatus: { key: 'reporting_status', width: 18 },
  coaStatus: { key: 'coa_status', width: 16 },
  ardRemarksStatus: { key: 'ard_remarks_status', width: 20 },
  ardRemarks: { key: 'ard_remarks', width: 30 },
  tat: { key: 'tat', width: 10 },
  workflowStatus: { key: 'workflow_status', width: 18 },
  sampleReceivedDate: { key: 'sample_received_date' },
};

function trfMasterColumns(): { header: string; key: string; width?: number }[] {
  return LIST_FIELD_ORDER.map((field) => ({
    header: listFieldLabel(field),
    ...TRF_MASTER_COLUMN[field.key],
  }));
}

const cols = trfMasterColumns();
console.log('trfMasterColumns length:', cols.length);
cols.forEach((c, i) => {
  console.log(`${i}: ${c.header} (key: ${c.key})`);
});
