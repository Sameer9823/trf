import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useNavigate, useLocation } from 'react-router-dom';

interface TeamMember {
  id: number;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  departmentName: string | null;
}

export function SelectMember() {
  const { employee, selectMember, status, actingEmployeeId } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'signed-in' && employee?.accountType === 'SHARED_TEAM' && actingEmployeeId === null) {
      // Fetch team members from the API
      fetchTeamMembers();
    }
  }, [status, employee, actingEmployeeId]);

  async function fetchTeamMembers() {
    try {
      const response = await fetch('/api/employees/team-members', {
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        const data = await response.json();
        setMembers(data.items || []);
      } else {
        setError('Failed to load team members');
      }
    } catch {
      setError('Failed to load team members');
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedMemberId || busy) return;

    setBusy(true);
    setError(null);

    try {
      const result = await selectMember(selectedMemberId);
      if (result.ok) {
        navigate(location.state?.from?.pathname ?? '/');
      } else {
        setError(result.message || 'Failed to select member');
      }
    } catch {
      setError('An error occurred');
    } finally {
      setBusy(false);
    }
  }

  // Only show this page for shared team accounts with no member selected yet
  if (status !== 'signed-in' || employee?.accountType !== 'SHARED_TEAM' || actingEmployeeId !== null) {
    return null;
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={handleSubmit}>
        <h1 className="login__title">TRF Management System</h1>
        <p className="muted">Select your name to continue</p>

        {error && <p className="error-text" role="alert">{error}</p>}

        <label htmlFor="member-select">Your Name</label>
        <select
          id="member-select"
          autoFocus
          value={selectedMemberId ?? ''}
          onChange={(e) => setSelectedMemberId(Number(e.target.value) || null)}
          disabled={busy}
          required
        >
          <option value="">— Choose —</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.fullName} ({member.employeeCode}){member.designation ? ` — ${member.designation}` : ''}
            </option>
          ))}
        </select>

        <button className="btn btn--primary login__submit" type="submit" disabled={busy || !selectedMemberId}>
          {busy ? 'Continuing…' : 'Continue'}
        </button>

        <p className="muted login__server">
          Signed in as team account: <strong>{employee.fullName}</strong>
        </p>
      </form>
    </div>
  );
}