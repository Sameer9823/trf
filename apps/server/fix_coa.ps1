$content = Get-Content src/tests/api.coa.test.ts -Raw
$idx = $content.IndexOf('async function analysedTrf(label: string)')
if ($idx -ge 0) {
    # Find the end of the function - look for the next function or let/const/var at column 0
    $endIdx = $content.IndexOf("`nlet ", $idx)
    if ($endIdx -lt 0) { $endIdx = $content.IndexOf("`nconst ", $idx) }
    if ($endIdx -lt 0) { $endIdx = $content.IndexOf("`nvar ", $idx) }
    if ($endIdx -lt 0) { $endIdx = $content.IndexOf("`nfunction ", $idx) }
    if ($endIdx -lt 0) { $endIdx = $content.IndexOf("`nasync function ", $idx + 1) }
    if ($endIdx -lt 0) { $endIdx = $content.Length }
    
    $newFunc = @"
async function analysedTrf(label: string) {
  const trf = await makeTrf();
  // Approve the TRF so ARD work can begin.
  const approved = await api<TrfDetail>(`/api/trfs/${trf.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: trf.version, remarksStatus: 'Approved' }),
  }, adminToken);
  assert.equal(approved.status, 200, 'TRF approved for analysis');
  const assigned = await api(`/api/assignments/trfs/${trf.id}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ assignments: [{ testName: `${label} Test`, assignedEmployeeId: analyst.id }] }),
  }, adminToken);
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  const test = assigned.body.items[0] as TestRow;
  await api(`/api/analysis/tests/${test.id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  await api(`/api/analysis/tests/${test.id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 2, resultValue: '2.5', lowerLimit: '1', upperLimit: '3' }),
  }, analyst.token);
  const done = await api(`/api/analysis/tests/${test.id}/complete`, {
    method: 'POST', body: JSON.stringify({ version: 3 }),
  }, analyst.token);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.outcome, 'Pass');
  return { trf: approved.body, test };
}
"@
    
    $content = $content.Substring(0, $idx) + $newFunc + $content.Substring($endIdx)
    Set-Content src/tests/api.coa.test.ts -Value $content
    Write-Host 'Replaced successfully'
} else {
    Write-Host 'Function not found'
}