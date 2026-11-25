/**
 * One definition of ARD test "overdue" and "in progress", shared by the ARD
 * team list, the employee detail and the dashboard so the same employee shows
 * the same numbers everywhere. `todayParam` is the placeholder bound to today
 * (todayLocal()); `$1` is the default.
 */
export const testOverdueSql = (todayParam: string) =>
  `(ata.due_date IS NOT NULL AND ata.due_date < ${todayParam} AND ata.status <> 'Completed' AND ata.status <> 'Cancelled')`;

export const TEST_OVERDUE_SQL = testOverdueSql('$1');

/** In progress includes a re-test, matching the ARD team workload view. */
export const ARD_IN_PROGRESS_SQL = `(ata.status = 'In Progress' OR ata.status = 'Re-test Required')`;

/** A test that is not finished. */
export const ARD_OPEN_SQL = `(ata.status NOT IN ('Completed', 'Cancelled'))`;