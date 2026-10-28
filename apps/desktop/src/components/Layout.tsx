import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useServerStatus } from '../lib/server-status';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from './OfflineNotice';
import { GlobalSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { Icons } from './Icons';
import { NotificationBell } from './NotificationBell';

export const NAV = [
  { to: '/', label: 'Dashboard', module: 'dashboard', icon: Icons.dashboard },
  { to: '/trf', label: 'TRF Management', module: 'trf', icon: Icons.trf },
  { to: '/assignments', label: 'Assignments', module: 'assignments', icon: Icons.assignments },
  { to: '/approvals', label: 'Approvals', module: 'approvals', icon: Icons.approvals },
  { to: '/employees', label: 'Employees', module: 'employees', icon: Icons.employees },
  { to: '/reports', label: 'Reports', module: 'reports', icon: Icons.reports },
  { to: '/audit', label: 'Audit Log', module: 'audit', icon: Icons.audit },
];

const TEAM_LABEL = { FRD: 'Formulation team', ARD: 'Analytical team' } as const;

function StatusBadge() {
  const { state } = useServerStatus();
  const text = state === 'connected' ? 'Server connected' : state === 'offline' ? 'Server offline' : 'Checking server';
  return (
    <span className={`server-badge server-badge--${state}`} role="status">
      <span className="server-badge__dot" aria-hidden />
      {text}
    </span>
  );
}

export function Layout() {
  const { state } = useServerStatus();
  const { employee, logout, switchUser, canAccessModule, accountId } = useAuth();
  const { pathname } = useLocation();
  // Settings stays reachable offline so an administrator can correct the server address.
  const blocked = state === 'offline' && pathname !== '/settings';
  const onTeamLogin = accountId !== null && employee?.team;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <Logo height={36} />
        </div>
        <nav className="sidebar__nav" aria-label="Main">
          {/* Only the modules this role may open are listed; the server checks again on every request. */}
          {NAV.filter((n) => canAccessModule(n.module)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => 'nav-link' + (isActive ? ' nav-link--active' : '')}>
              {n.icon}
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        {employee && (
          <div className="sidebar__user">
            <div className="sidebar__who">
              <span className="sidebar__avatar" aria-hidden>{employee.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
              <span className="sidebar__who-text">
                <strong>{employee.fullName}</strong>
                <span>{employee.designation ?? employee.role}{onTeamLogin ? ` · ${TEAM_LABEL[employee.team!]}` : ''}</span>
              </span>
            </div>
            <div className="sidebar__actions">
              {onTeamLogin && (
                <button type="button" className="sidebar__btn" onClick={() => void switchUser()} title="Hand the screen to another team member">
                  {Icons.switchUser}<span>Not me</span>
                </button>
              )}
              <button type="button" className="sidebar__btn" onClick={() => void logout()}>
                {Icons.signOut}<span>Sign out</span>
              </button>
            </div>
          </div>
        )}
      </aside>
      <div className="main">
        <header className="topbar">
          {/* Live global search over TRF number, product, batch, customer and employee. */}
          <GlobalSearch />
          <div className="topbar__right">
            <NotificationBell />
            <StatusBadge />
          </div>
        </header>
        <main className="content">{blocked ? <OfflineNotice /> : <Outlet />}</main>
      </div>
    </div>
  );
}
