import { pool, withTransaction } from './db';
import { config } from './config';
import { runMigrations } from './migrate';
import { hashPassword } from './lib/password';
import { writeAudit } from './lib/audit';

/**
 * Creates dummy department employees for testing.
 * Run manually: npm run seed:dummy -w @trf/server
 */
async function seedDummyEmployees() {
  await runMigrations();

  // Check if departments exist, create if not
  const deptResult = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM departments WHERE name IN ('Formulation', 'ARD', 'Quality Control')`
  );
  
  const departments = new Map<string, number>();
  for (const row of deptResult.rows) {
    departments.set(row.name, row.id);
  }

  // Create missing departments
  for (const deptName of ['Formulation', 'ARD', 'Quality Control']) {
    if (!departments.has(deptName)) {
      const result = await pool.query<{ id: number }>(
        `INSERT INTO departments (name) VALUES ($1) RETURNING id`,
        [deptName]
      );
      departments.set(deptName, result.rows[0].id);
      console.log(`Created department: ${deptName}`);
    }
  }

  const formulationDeptId = departments.get('Formulation')!;
  const ardDeptId = departments.get('ARD')!;
  const qcDeptId = departments.get('Quality Control')!;

  // Get admin user for created_by
  const adminResult = await pool.query<{ id: number }>(
    `SELECT id FROM employees WHERE role = 'Admin' AND is_active = TRUE LIMIT 1`
  );
  const adminId = adminResult.rows[0]?.id ?? 1;

  const dummyEmployees = [
    { employeeCode: 'FORM-001', fullName: 'Rajesh Kumar', email: 'rajesh.kumar@company.com', username: 'rajesh.kumar', role: 'Analyst' as const, departmentId: formulationDeptId, designation: 'Formulation Scientist', phone: '+91-9876543210', password: 'Formulation@123' },
    { employeeCode: 'FORM-002', fullName: 'Priya Sharma', email: 'priya.sharma@company.com', username: 'priya.sharma', role: 'Analyst' as const, departmentId: formulationDeptId, designation: 'Senior Formulation Scientist', phone: '+91-9876543211', password: 'Formulation@123' },
    { employeeCode: 'FORM-003', fullName: 'Amit Patel', email: 'amit.patel@company.com', username: 'amit.patel', role: 'Manager' as const, departmentId: formulationDeptId, designation: 'Formulation Manager', phone: '+91-9876543212', password: 'Formulation@123' },
    { employeeCode: 'FORM-004', fullName: 'Sneha Reddy', email: 'sneha.reddy@company.com', username: 'sneha.reddy', role: 'Viewer' as const, departmentId: formulationDeptId, designation: 'Formulation Trainee', phone: '+91-9876543213', password: 'Formulation@123' },
    { employeeCode: 'ARD-001', fullName: 'Vikram Singh', email: 'vikram.singh@company.com', username: 'vikram.singh', role: 'Analyst' as const, departmentId: ardDeptId, designation: 'Analytical Chemist', phone: '+91-9876543220', password: 'Analytical@123' },
    { employeeCode: 'ARD-002', fullName: 'Anjali Gupta', email: 'anjali.gupta@company.com', username: 'anjali.gupta', role: 'Analyst' as const, departmentId: ardDeptId, designation: 'Senior Analytical Chemist', phone: '+91-9876543221', password: 'Analytical@123' },
    { employeeCode: 'ARD-003', fullName: 'Rohit Verma', email: 'rohit.verma@company.com', username: 'rohit.verma', role: 'Manager' as const, departmentId: ardDeptId, designation: 'ARD Manager', phone: '+91-9876543222', password: 'Analytical@123' },
    { employeeCode: 'ARD-004', fullName: 'Kavya Nair', email: 'kavya.nair@company.com', username: 'kavya.nair', role: 'Viewer' as const, departmentId: ardDeptId, designation: 'ARD Trainee', phone: '+91-9876543223', password: 'Analytical@123' },
    { employeeCode: 'QC-001', fullName: 'Deepak Joshi', email: 'deepak.joshi@company.com', username: 'deepak.joshi', role: 'Analyst' as const, departmentId: qcDeptId, designation: 'QC Analyst', phone: '+91-9876543230', password: 'Quality@123' },
    { employeeCode: 'QC-002', fullName: 'Meera Iyer', email: 'meera.iyer@company.com', username: 'meera.iyer', role: 'Analyst' as const, departmentId: qcDeptId, designation: 'Senior QC Analyst', phone: '+91-9876543231', password: 'Quality@123' },
    { employeeCode: 'QC-003', fullName: 'Sanjay Malhotra', email: 'sanjay.malhotra@company.com', username: 'sanjay.malhotra', role: 'Manager' as const, departmentId: qcDeptId, designation: 'QC Manager', phone: '+91-9876543232', password: 'Quality@123' },
    { employeeCode: 'ADMIN-002', fullName: 'System Admin', email: 'admin@company.com', username: 'admin', role: 'Admin' as const, departmentId: null, designation: 'System Administrator', phone: '+91-9876543200', password: 'Admin@123456' },
  ];

  for (const emp of dummyEmployees) {
    const existing = await pool.query(
      `SELECT id FROM employees WHERE employee_code = $1 OR username = $2 OR email = $3`,
      [emp.employeeCode, emp.username, emp.email]
    );
    
    if (existing.rows.length > 0) {
      console.log(`Skipping ${emp.employeeCode} - already exists`);
      continue;
    }

    const passwordHash = await hashPassword(emp.password);
    
    await withTransaction(async (client) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO employees (employee_code, full_name, designation, department_id, email, phone,
                                username, password_hash, role, must_change_password, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10)
         RETURNING id`,
        [emp.employeeCode, emp.fullName, emp.designation, emp.departmentId, emp.email,
         emp.phone, emp.username, passwordHash, emp.role, adminId],
      );
      
      await writeAudit(client, {
        userId: adminId, userName: 'System', action: 'employee.created', module: 'employees',
        recordType: 'Employee', recordRef: emp.employeeCode,
        newValue: { fullName: emp.fullName, role: emp.role, email: emp.email, departmentId: emp.departmentId, source: 'seed:dummy' },
      });
      
      console.log(`Created employee: ${emp.employeeCode} (${emp.fullName}) - ${emp.role} in ${emp.departmentId ? 'dept' : 'no dept'}`);
    });
  }

  console.log('\nDummy employees created successfully!');
  console.log('All employees have must_change_password = TRUE');
  console.log('They will need to change their password on first login.');
  console.log('\nTest credentials:');
  console.log('  Formulation: rajesh.kumar / Formulation@123');
  console.log('  ARD: vikram.singh / Analytical@123');
  console.log('  QC: deepak.joshi / Quality@123');
  console.log('  Admin: admin / Admin@123456');
}

seedDummyEmployees()
  .catch((err) => {
    console.error(`Could not create dummy employees: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());