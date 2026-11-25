import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useState, useCallback } from 'react';
import type { EmployeeProfile } from '@trf/shared';
import { useServerStatus } from '../lib/server-status';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from './OfflineNotice';
import { GlobalSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { Icons } from './Icons';
import { NotificationBell } from './NotificationBell';

export const NAV = [
  { to: '/', label: 'Dashboard', module: 'dashboard', icon: Icons.dashboard, description: 'Overview & metrics' },
  { to: '/trf', label: 'TRF Management', module: 'trf', icon: Icons.trf, description: 'Create & manage TRFs' },
  { to: '/assignments', label: 'Assignments', module: 'assignments', icon: Icons.assignments, description: 'Test assignments' },
  { to: '/ard', label: 'ARD', module: 'ard', icon: Icons.ard, description: 'My tests & results' },
  { to: '/approvals', label: 'Approvals', module: 'approvals', icon: Icons.approvals, description: 'Review & approve' },
  { to: '/employees', label: 'Employees', module: 'employees', icon: Icons.employees, description: 'Team management' },
  { to: '/reports', label: 'Reports', module: 'reports', icon: Icons.reports, description: 'Analytics & exports' },
  { to: '/audit', label: 'Audit Log', module: 'audit', icon: Icons.audit, description: 'System activity' },
];

const TEAM_LABEL = { FRD: 'Formulation team', ARD: 'Analytical team' } as const;

/**
 * The modules a signed-in employee should see in the sidebar. ARD team-account
 * members do their work in Assignments, so the main operations dashboard is
 * left out for them; every other account keeps it. Higher authorities (AGM, GM, Admin)
 * don't need Assignments in the sidebar — they access employee workload via ARD Team tab.
 */
export function visibleNav(
  employee: EmployeeProfile | null,
  canAccessModule: (module: string) => boolean,
): typeof NAV {
  const hideDashboard = employee?.team === 'ARD';
  const isHigherAuthority = employee?.role === 'Admin' || employee?.designation === 'AGM' || employee?.designation === 'GM';
  const hideAssignments = isHigherAuthority;
  return NAV.filter((n) => 
    canAccessModule(n.module) && 
    !(hideDashboard && n.module === 'dashboard') &&
    !(hideAssignments && n.module === 'assignments')
  );
}

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

function NavItem({ item, isActive, isCollapsed }: { item: typeof NAV[0]; isActive: boolean; isCollapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={`nav-link${isActive ? ' nav-link--active' : ''}`}
      aria-label={isCollapsed ? item.label : undefined}
      title={isCollapsed ? `${item.label}: ${item.description}` : undefined}
    >
      <span className="nav-link__icon" aria-hidden>{item.icon}</span>
      {!isCollapsed && <span className="nav-link__label">{item.label}</span>}
    </NavLink>
  );
}

export function Layout() {
  const { state } = useServerStatus();
  const { employee, logout, switchUser, canAccessModule, accountId } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Settings stays reachable offline so an administrator can correct the server address.
  const blocked = state === 'offline' && pathname !== '/settings';
  const onTeamLogin = accountId !== null && employee?.team;

  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/login');
  }, [logout, navigate]);

  const handleSwitchUser = useCallback(async () => {
    await switchUser();
  }, [switchUser]);

  // Only the modules this role may open are listed; the server checks again on
  // every request. The ARD workspace is Manager+ only (see MODULE_ACCESS.ard).
  const accessibleNav = visibleNav(employee, canAccessModule);

  return (
    <div className={`shell${isCollapsed ? ' shell--collapsed' : ''}`}>
      <aside className={`sidebar${isCollapsed ? ' sidebar--collapsed' : ''}`} aria-label="Main navigation">
        <div className="sidebar__brand">
          <Logo height={isCollapsed ? 28 : 36} />
        </div>

        <nav className="sidebar__nav" aria-label="Main">
          {/* Only the modules this role may open are listed; the server checks again on every request. */}
          {accessibleNav.map((n) => (
            <NavItem key={n.to} item={n} isActive={pathname === n.to || (n.to !== '/' && pathname.startsWith(n.to))} isCollapsed={isCollapsed} />
          ))}
        </nav>

        <div className="sidebar__footer">
          {employee && (
            <div className="sidebar__who">
              <span className="sidebar__avatar" aria-hidden>
                {employee.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('')}
              </span>
              {!isCollapsed && (
                <div className="sidebar__who-text">
                  <strong>{employee.fullName}</strong>
                  <span>{employee.designation ?? employee.role}{onTeamLogin ? ` · ${TEAM_LABEL[employee.team!]}` : ''}</span>
                </div>
              )}
            </div>
          )}

          <div className="sidebar__actions">
            {/* Collapse / expand the sidebar */}
            <button
              type="button"
              className="sidebar__btn sidebar__btn--icon"
              onClick={() => setIsCollapsed(!isCollapsed)}
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {Icons.switchUser}
            </button>
            {employee && onTeamLogin && (
              <button
                type="button"
                className={`sidebar__btn sidebar__btn--primary${isCollapsed ? ' sidebar__btn--icon' : ''}`}
                onClick={handleSwitchUser}
                title="Not me - hand the screen to another team member"
              >
                {Icons.switchUser}{!isCollapsed && <span>Not me</span>}
              </button>
            )}
            {employee && (
              <button
                type="button"
                className={`sidebar__btn sidebar__btn--danger${isCollapsed ? ' sidebar__btn--icon' : ''}`}
                onClick={handleLogout}
                title="Sign out"
              >
                {Icons.signOut}{!isCollapsed && <span>Sign out</span>}
              </button>
            )}
          </div>
        </div>
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