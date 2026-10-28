const fs = require('fs');
const content = fs.readFileSync('src/tests/api.coa.test.ts', 'utf8');

const newFunc = "async function analysedTrf(label: string) {\n" +
"  const trf = await makeTrf();\n" +
"  // Approve the TRF so ARD work can begin.\n" +
"  const approved = await api<TrfDetail>(`/api/trfs/${trf.id}`, {\n" +
"    method: 'PATCH', body: JSON.stringify({ version: trf.version, remarksStatus: 'Approved' }),\n" +
"  }, adminToken);\n" +
"  assert.equal(approved.status, 200, 'TRF approved for analysis');\n" +
"  const assigned = await api(`/api/assignments/trfs/${trf.id}/assignments`, {\n" +
"    method: 'POST',\n" +
"    body: JSON.stringify({ assignments: [{ testName: `${label} Test`, assignedEmployeeId: analyst.id }] }),\n" +
"  }, adminToken);\n" +
"  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));\n" +
"  const test = assigned.body.items[0] as TestRow;\n" +
"  await api(`/api/analysis/tests/${test.id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);\n" +
"  await api(`/api/analysis/tests/${test.id}/result`, {\n" +
"    method: 'PUT', body: JSON.stringify({ version: 2, resultValue: '2.5', lowerLimit: '1', upperLimit: '3' }),\n" +
"  }, analyst.token);\n" +
"  const done = await api(`/api/analysis/tests/${test.id}/complete`, {\n" +
"    method: 'POST', body: JSON.stringify({ version: 3 }),\n" +
"  }, analyst.token);\n" +
"  assert.equal(done.status, 200, JSON.stringify(done.body));\n" +
"  assert.equal(done.body.outcome, 'Pass');\n" +
"  return { trf: approved.body, test };\n" +
"}";

const idx = content.indexOf('async function analysedTrf(label: string)');
if (idx >= 0) {
    let endIdx = content.indexOf('\nlet ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nconst ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nvar ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nfunction ', idx);
    if (endIdx < 0) endIdx = content.indexOf('\nasync function ', idx + 1);
    if (endIdx < 0) endIdx = content.length;
    
    const newContent = content.substring(0, idx) + newFunc + content.substring(endIdx);
    fs.writeFileSync('src/tests/api.coa.test.ts', newContent);
    console.log('Replaced successfully');
} else {
    console.log('Function not found');
}