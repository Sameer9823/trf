import re

with open('apps/server/src/routes/employees.ts', 'r') as f:
    content = f.read()

old = '''try {
    const result = await pool.query<{
      id: number; full_name: string; designation: string | null; department_name: string | null;
    }>(
      `SELECT e.id, e.full_name, e.designation, d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active = TRUE
       ORDER BY e.full_name ASC`,
    );
    const items: EmployeeOption[] = result.rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      designation: row.designation,
      departmentName: row.department_name,
    }));
    res.json({ items });
  } catch (err) { next(err); }
});'''

new = '''try {
    const result = await pool.query<{
      id: number; employee_code: string; full_name: string; designation: string | null; department_name: string | null;
    }>(
      `SELECT e.id, e.employee_code, e.full_name, e.designation, d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.is_active = TRUE
       ORDER BY e.full_name ASC`,
    );
    const items: EmployeeOption[] = result.rows.map((row) => ({
      id: row.id,
      employeeCode: row.employee_code,
      fullName: row.full_name,
      designation: row.designation,
      departmentName: row.department_name,
    }));
    res.json({ items });
  } catch (err) { next(err); }
});'''

content = content.replace(old, new)

with open('apps/server/src/routes/employees.ts', 'w') as f:
    f.write(content)

print("Done")