import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ServerStatusProvider } from './lib/server-status';
import { AuthProvider, useAuth } from './lib/auth';
import { ChangePassword } from './pages/ChangePassword';
import { Assignments } from './pages/Assignments';
import { AuditLog } from './pages/AuditLog';
import { Analysis } from './pages/Analysis';
import { CoaPage } from './pages/Coa';
import { Dashboard } from './pages/Dashboard';
import { Employees } from './pages/Employees';
import { ReportsPage } from './pages/Reports';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { TrfDetailPage } from './pages/TrfDetail';
import { TrfForm } from './pages/TrfForm';
import { TrfList } from './pages/TrfList';
import { TrfPrint } from './pages/TrfPrint';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { status } = useAuth();
  if (status === 'checking') return <div className="page"><p className="muted">Checking your session…</p></div>;
  // A signed-out person is *not* redirected here. <Navigate> renders nothing at all,
  // so returning one from this component would blank the window and, because the
  // target is already the login route, would never change the URL either — the
  // login screen could never appear. Root decides what a signed-out person sees.
  return children;
}

function RequireModule({ module, children }: { module: string; children: JSX.Element }) {
  const { canAccessModule } = useAuth();
  // The server refuses regardless; this only avoids showing an empty screen.
  if (!canAccessModule(module)) return <Navigate to="/" replace />;
  return children;
}

function Shell() {
  const { employee } = useAuth();

  // A pending password change blocks the rest of the application until it is done.
  if (employee?.mustChangePassword) {
    return (
      <Routes>
        <Route path="/change-password" element={<ChangePassword />} />
        <Route path="*" element={<Navigate to="/change-password" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* The server address must be reachable before sign-in, so Settings sits outside the shell. */}
      <Route path="/settings" element={<Settings />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="trf" element={
          <RequireModule module="trf"><TrfList /></RequireModule>
        } />
        {/* Detail, create and edit live under their own paths so a TRF can be linked to directly. */}
        <Route path="trfs/new" element={
          <RequireModule module="trf"><TrfForm /></RequireModule>
        } />
         <Route path="trfs/:id" element={
          <RequireModule module="trf"><TrfDetailPage /></RequireModule>
        } />
        <Route path="trfs/:id/edit" element={
          <RequireModule module="trf"><TrfForm /></RequireModule>
        } />
        <Route path="trfs/:id/print" element={
          <RequireModule module="trf"><TrfPrint /></RequireModule>
        } />
        <Route path="assignments" element={
          <RequireModule module="assignments"><Assignments /></RequireModule>
        } />
        <Route path="analysis" element={
          <RequireModule module="analysis"><Analysis /></RequireModule>
        } />
        <Route path="coa" element={
          <RequireModule module="coa"><CoaPage /></RequireModule>
        } />
        <Route path="employees" element={
          <RequireModule module="employees"><Employees /></RequireModule>
        } />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="audit" element={<AuditLog />} />
      </Route>
    </Routes>
  );
}

function Root() {
  const { status } = useAuth();
  if (status === 'signed-out') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/forgot-password" element={<Navigate to="/" replace />} />
      <Route path="/reset-password" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Shell />} />
    </Routes>
  );
}

export function App() {
  return (
    <ServerStatusProvider>
      <AuthProvider>
        <HashRouter>
          <RequireAuth>
            <Root />
          </RequireAuth>
        </HashRouter>
      </AuthProvider>
    </ServerStatusProvider>
  );
}
