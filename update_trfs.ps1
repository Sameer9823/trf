$content = [IO.File]::ReadAllText('D:\PROFILE DATA\SAMEER\Downloads\trf-master-fixed\trf-master\apps\server\src\routes\trfs.ts')
$content = $content -replace 'generic_name, formulation_approval_status, ard_approval_status\)', 'generic_name, formulation_approval_status, ard_approval_status, test_requested_other)'
$content = $content -replace '\$31, \$32, \$33\)', '\$31, \$32, \$33, \$34)'
$content = $content -replace 'genericName, body\.formulationApprovalStatus \?\? \'None\', body\.ardApprovalStatus \?\? \'None\'\]', 'genericName, body.formulationApprovalStatus ?? \'None\', body.ardApprovalStatus ?? \'None\', body.testRequestedOther ?? null]'
[IO.File]::WriteAllText('D:\PROFILE DATA\SAMEER\Downloads\trf-master-fixed\trf-master\apps\server\src\routes\trfs.ts', $content)