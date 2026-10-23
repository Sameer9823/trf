import re

with open('apps/server/src/routes/employees.ts', 'r') as f:
    content = f.read()

# Fix the mapping
content = content.replace(
    'id: row.id,\n      fullName: row.full_name,',
    'id: row.id,\n      employeeCode: row.employee_code,\n      fullName: row.full_name,'
)

with open('apps/server/src/routes/employees.ts', 'w') as f:
    f.write(content)

print("Done")