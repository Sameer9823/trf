import re

with open('apps/server/src/routes/trfs.ts', 'r') as f:
    content = f.read()

# Find and replace the ard-status endpoint query
old = '''const locked = await client.query<{
        workflow_status: ArdWorkflowStatus; ard_stage: string; version: number;
        ard_analyst_id: number | null; analysis_start_date: string | null;
        ard_number: string | null; trf_number: string;
      }>(`SELECT workflow_status, ard_stage, version, ard_analyst_id, analysis_start_date,
                   ard_number, t.trf_number FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);'''

new = '''const locked = await client.query<{
        workflow_status: ArdWorkflowStatus; ard_stage: string; version: number;
        ard_analyst_id: number | null; analysis_start_date: string | null;
        ard_number: string | null; trf_number: string;
        remarks_status: string;
      }>(`SELECT workflow_status, ard_stage, version, ard_analyst_id, analysis_start_date,
                   ard_number, t.trf_number, t.remarks_status FROM trfs t WHERE t.id = $1 FOR UPDATE OF t`, [id]);'''

content = content.replace(old, new)

# Add the approval gate check
old2 = '''      if (current.version !== body.version) throw versionConflict();

      // Completed needs an Analyst Name and a Date of Analysis, and the error'''

new2 = '''      if (current.version !== body.version) throw versionConflict();

      // Formulation Approval Gate: ARD workflow status changes are locked until Formulation approves.
      const isApproved = current.remarks_status === 'Approved';
      if (!isApproved && user.role !== 'Admin') {
        throw new AppError(409, 'ARD_LOCKED', 'ARD work opens once the Formulation team approves this TRF.');
      }

      // Completed needs an Analyst Name and a Date of Analysis, and the error'''

content = content.replace(old2, new2)

with open('apps/server/src/routes/trfs.ts', 'w') as f:
    f.write(content)

print("Done")