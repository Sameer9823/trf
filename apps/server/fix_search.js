const fs = require('fs');
const content = fs.readFileSync('src/tests/api.search.test.ts', 'utf8');

// Update makeAssignedTrf to approve the TRF before assigning tests
const idx = content.indexOf('async function makeAssignedTrf(createdBy: string, employeeId: number, tag: string): Promise<Fixture>');
if (idx >= 0) {
    // Find the end of the function - look for the next function or const/let/var at column 0
    let endIdx = content.indexOf('\nconst ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nlet ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nvar ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nfunction ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nasync function ', idx + 1);
    if (endIdx < 0) endIdx = content.length;
    
    const newFunc = "async function makeAssignedTrf(createdBy: string, employeeId: number, tag: string): Promise<Fixture> {\n" +
    "  const lookups = await baseLookups();\n" +
    "  const created = await api('/api/trfs', {\n" +
    "    method: 'POST',\n" +
    "    body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', batchNumber: `${MARKER}-${tag}`, ...lookups }),\n" +
    "  }, createdBy);\n" +
    "  assert.equal(created.status, 201, JSON.stringify(created.body));\n" +
    "  const trfId = created.body.id as number;\n" +
    "  const trfNumber = created.body.trfNumber as string;\n" +
    "\n" +
    "  // Approve the TRF so ARD work can begin (assigning tests, starting analysis).\n" +
    "  const approved = await api<TrfDetail>(`/api/trfs/${trfId}`, {\n" +
    "    method: 'PATCH', body: JSON.stringify({ version: created.body.version, remarksStatus: 'Approved' }),\n" +
    "  }, adminToken);\n" +
    "  assert.equal(approved.status, 200, 'TRF approved for analysis');\n" +
    "\n" +
    "  // The TRF is assigned to the same person as its tests, because the TRF list\n" +
    "  // scope is the TRF's own assignee, not whoever is doing the bench work.\n" +
    "  const assignedTrf = await api(`/api/trfs/${trfId}/assign`, {\n" +
    "    method: 'POST',\n" +
    "    body: JSON.stringify({ assignedEmployeeId: employeeId, version: approved.body.version }),\n" +
    "  }, adminToken);\n" +
    "  assert.equal(assignedTrf.status, 200, JSON.stringify(assignedTrf.body));\n" +
    "\n" +
    "  const assigned = await api(`/api/assignments/trfs/${trfId}/assignments`, {\n" +
    "    method: 'POST',\n" +
    "    body: JSON.stringify({ assignments: [{ testName: `${MARKER} ${tag} Titration`, assignedEmployeeId: employeeId }] }),\n" +
    "  }, adminToken);\n" +
    "  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));\n" +
    "  const item = assigned.body.items[0] as { id: number };\n" +
    "\n" +
    "  return { trfId, trfNumber, testId: item.id, testName: `${MARKER} ${tag} Titration` };\n" +
    "}";
    
    const newContent = content.substring(0, idx) + newFunc + content.substring(endIdx);
    fs.writeFileSync('src/tests/api.search.test.ts', newContent);
    console.log('Function replaced successfully');
} else {
    console.log('Function not found');
}