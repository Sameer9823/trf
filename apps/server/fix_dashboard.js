const fs = require('fs');
const content = fs.readFileSync('src/tests/api.dashboard.test.ts', 'utf8');

// Update assignedTrf to approve the TRF before assigning tests
const idx = content.indexOf('async function assignedTrf(createdBy: string, employeeId: number, label: string)');
if (idx >= 0) {
    // Find the end of the function
    let endIdx = content.indexOf('\nlet ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nconst ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nvar ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nfunction ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nasync function ', idx + 1);
    if (endIdx < 0) endIdx = content.length;
    
    const newFunc = "/** A TRF with one assigned test, which is enough to move it out of New. */\n" +
    "async function assignedTrf(createdBy: string, employeeId: number, label: string) {\n" +
    "  const trf = await makeTrf(createdBy);\n" +
    "  // Approve the TRF so ARD work can begin.\n" +
    "  const approved = await api<TrfDetail>(`/api/trfs/${trf.id}`, {\n" +
    "    method: 'PATCH', body: JSON.stringify({ version: trf.version, remarksStatus: 'Approved' }),\n" +
    "  }, adminToken);\n" +
    "  assert.equal(approved.status, 200, 'TRF approved for analysis');\n" +
    "  const res = await api(`/api/assignments/trfs/${trf.id}/assignments`, {\n" +
    "    method: 'POST',\n" +
    "    body: JSON.stringify({ assignments: [{ testName: `${label} Test`, assignedEmployeeId: employeeId }] }),\n" +
    "  }, adminToken);\n" +
    "  assert.equal(res.status, 201, JSON.stringify(res.body));\n" +
    "  return { trf: approved.body, test: res.body.items[0] as { id: number; version: number } };\n" +
    "}";
    
    const newContent = content.substring(0, idx) + newFunc + content.substring(endIdx);
    fs.writeFileSync('src/tests/api.dashboard.test.ts', newContent);
    console.log('Function replaced successfully');
} else {
    console.log('Function not found');
}