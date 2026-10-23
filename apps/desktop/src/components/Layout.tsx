import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useServerStatus } from '../lib/server-status';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from './OfflineNotice';
import { GlobalSearch } from './GlobalSearch';
import { canAccessFormulation, canAccessAnalytical } from '@trf/shared';

export const NAV = [
  { to: '/', label: 'Dashboard', module: 'dashboard' },
  { to: '/trf', label: 'TRF Management', module: 'trf' },
  { to: '/assignments', label: 'Assignments', module: 'assignments' },
  { to: '/analysis', label: 'Analysis', module: 'analysis' },
  { to: '/coa', label: 'COA', module: 'coa' },
  { to: '/employees', label: 'Employees', module: 'employees' },
  { to: '/reports', label: 'Reports', module: 'reports' },
  { to: '/audit', label: 'Audit Log', module: 'audit' },
];

function StatusBadge() {
  const { state } = useServerStatus();
  const text = state === 'connected' ? 'SERVER CONNECTED' : state === 'offline' ? 'SERVER OFFLINE' : 'CHECKING SERVER';
  return (
    <span className={`server-badge server-badge--${state}`} role="status">
      <span className="server-badge__dot" aria-hidden />
      {text}
    </span>
  );
}

export function Layout() {
  const { state } = useServerStatus();
  const { employee, logout, canAccessModule } = useAuth();
  const { pathname } = useLocation();
  // Settings stays reachable offline so an administrator can correct the server address.
  const blocked = state === 'offline' && pathname !== '/settings';

  const showFormulation = employee && canAccessFormulation(employee.departmentName, employee.role);
  const showAnalytical = employee && canAccessAnalytical(employee.departmentName, employee.role);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">TRF Management System</div>
        <nav>
          {/* Only the modules this role may open are listed; the server checks again on every request. */}
          {NAV.filter((n) => canAccessModule(n.module)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
              {n.label}
            </NavLink>
          ))}
          
          {showFormulation && (
            <div className="sidebar__section">
              <div className="sidebar__section-title">Formulation</div>
              <NavLink to="/trf" end className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
                TRF Management
              </NavLink>
              <NavLink to="/assignments" className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
                Assignments
              </NavLink>
              <NavLink to="/coa" className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
                COA
              </NavLink>
            </div>
          )}
          
          {showAnalytical && (
            <div className="sidebar__section">
              <div className="sidebar__section-title">Analytical</div>
              <NavLink to="/analysis" className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
                Analysis
              </NavLink>
              <NavLink to="/assignments" className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
                Assignments
              </NavLink>
              <NavLink to="/coa" className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
                COA
              </NavLink>
            </div>
          )}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          {/* Live global search over TRF number, product, batch, customer and employee. */}
          <GlobalSearch />
          <div className="topbar__right">
            <StatusBadge />
            {employee && (
              <span className="topbar__user" title={`${employee.employeeCode} · ${employee.designation ?? ''}`}>
                <strong>{employee.fullName}</strong>
                <span className="topbar__role">{employee.role}{employee.departmentName ? ` · ${employee.departmentName}` : ''}</span>
              </span>
            )}
            <button className="btn btn--ghost" onClick={() => logout()}>Sign out</button>
          </div>
        </header>
        <main className="content">{blocked ? <OfflineNotice /> : <Outlet />}</main>
      </div>
    </div>
  );
}
