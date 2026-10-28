# Approvals, locking and the shared team logins

## Who approves

Every approval is made by an administrator signed in as themselves. AGM, GM and COO are
administrators: choosing one of those designations gives the person the Admin role. The other
designations (Trainee, Junior Executive, Junior Analyst, Executive, Senior Executive) never
approve, whatever role they hold.

## The flow

1. FRD creates the TRF. It starts `Pending`; nobody approves their own request.
2. An administrator approves it (`POST /api/trfs/:id/decision`, track `FORMULATION`). Part A locks and ARD work opens.
3. ARD fills the ARD block, ending with Sample Received By, and marks the work Completed. That puts the TRF in front of an administrator for the final approval.
4. The administrator approves (track `ARD`). The TRF locks: nobody, the administrator included, can change it.
5. Only an administrator can unlock it (`POST /api/trfs/:id/unlock`), with a reason of at least 10 characters. ARD work reopens at In Progress and needs a fresh final approval.

A rejection needs a reason. A final rejection sends the work back to ARD, unlocked.
Every decision is kept in `trf_approvals` and in the audit trail under the administrator's name.

## Shared team logins

FRD and ARD each have one login and one mailbox (`team_accounts`). Several people use each one, so:

- The team login alone can do nothing. After signing in, each person chooses their name and enters their own PIN.
- From then on every request runs as that person, with their own role, and every audit row records the person and the team account they used.
- "Not me" and a 10 minute idle lock return the screen to the name picker and end that person's refresh tokens.
- A team member has no personal password sign-in. An administrator can never be a team member.
- A wrong PIN five times locks that person for 15 minutes; the team password locks after repeated failures like any other.
- An administrator sets team passwords and mailboxes under Employees, and sets each member's PIN when adding or editing them.

The token for a team login carries `kind: 'team'` and the team account id. It is never read as an employee id.
