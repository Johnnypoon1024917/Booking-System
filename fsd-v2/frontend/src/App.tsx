import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastHost } from './components/ToastHost';
import { ConfirmHost } from './components/ConfirmHost';
import { SessionExpiredModal } from './components/SessionExpiredModal';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { CalendarView } from './pages/CalendarView';
import { Search } from './pages/Search';
import { NewBooking } from './pages/NewBooking';
import { MyBookings } from './pages/MyBookings';
import { AdminUsers } from './pages/AdminUsers';
import { AdminResources } from './pages/AdminResources';
import { AdminBookings } from './pages/AdminBookings';
import { AdminDepartments } from './pages/AdminDepartments';
import { TenantStudio } from './pages/TenantStudio';
import { Reports } from './pages/Reports';
import { Approvals } from './pages/Approvals';
import { AdminApprovalChain } from './pages/AdminApprovalChain';
import { AdminPermissions } from './pages/AdminPermissions';
import { AdminBroadcasts } from './pages/AdminBroadcasts';
import { AdminHolidays } from './pages/AdminHolidays';
import { AdminIntegrations } from './pages/AdminIntegrations';
import { AdminWebhooks } from './pages/AdminWebhooks';
import { AdminScim } from './pages/AdminScim';
import { AdminLocations } from './pages/AdminLocations';
import { AdminLocationGroups } from './pages/AdminLocationGroups';
import { AdminResourceTypes } from './pages/AdminResourceTypes';
import { AdminServices } from './pages/AdminServices';
import { AdminFloorPlans } from './pages/AdminFloorPlans';
import { AdminSensors } from './pages/AdminSensors';
import { AdminVisitors } from './pages/AdminVisitors';
import { AdminInvoices } from './pages/AdminInvoices';
import { Kiosk } from './pages/Kiosk';
import { Profile } from './pages/Profile';
import { Settings } from './pages/Settings';
import { useAuth } from './hooks/useAuth';
import { useTenant } from './stores/tenant';
import { useTheme } from './stores/theme';

function RequireAuth({ children }: { children: JSX.Element }) {
  const user = useAuth((s) => s.user);
  const loc = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  return children;
}

export function App() {
  const user = useAuth((s) => s.user);
  const loadTenant = useTenant((s) => s.load);
  const applyTheme = useTheme((s) => s.apply);

  // Hydrate tenant customization + theme once we know the user is in.
  // Tenant load may fail silently — the store surfaces error state for
  // any screen that wants to react to it.
  useEffect(() => {
    applyTheme();
    if (user) loadTenant().catch(() => { /* surfaced via store.error */ });
  }, [user, loadTenant, applyTheme]);

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Kiosk runs full-screen — outside the auth/layout shell so a
            wall-mounted tablet never sees the sidebar/topbar. */}
        <Route path="/kiosk/:resourceId" element={<Kiosk />} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route path="/"                     element={<Dashboard />} />
          <Route path="/calendar"             element={<CalendarView />} />
          <Route path="/search"               element={<Search />} />
          <Route path="/new"                  element={<NewBooking />} />
          <Route path="/my"                   element={<MyBookings />} />
          <Route path="/settings"             element={<Settings />} />
          <Route path="/approvals"            element={<Approvals />} />
          <Route path="/admin/users"          element={<AdminUsers />} />
          <Route path="/admin/resources"      element={<AdminResources />} />
          <Route path="/admin/bookings"       element={<AdminBookings />} />
          <Route path="/admin/departments"    element={<AdminDepartments />} />
          <Route path="/admin/studio"         element={<TenantStudio />} />
          <Route path="/admin/reports"        element={<Reports />} />
          <Route path="/admin/approval-chain" element={<AdminApprovalChain />} />
          <Route path="/admin/permissions"    element={<AdminPermissions />} />
          <Route path="/admin/broadcasts"     element={<AdminBroadcasts />} />
          <Route path="/admin/holidays"       element={<AdminHolidays />} />
          <Route path="/admin/integrations"   element={<AdminIntegrations />} />
          <Route path="/admin/webhooks"       element={<AdminWebhooks />} />
          <Route path="/admin/scim"           element={<AdminScim />} />
          <Route path="/admin/locations"        element={<AdminLocations />} />
          <Route path="/admin/location-groups"  element={<AdminLocationGroups />} />
          <Route path="/admin/resource-types"   element={<AdminResourceTypes />} />
          <Route path="/admin/services"         element={<AdminServices />} />
          <Route path="/admin/floor-plans"      element={<AdminFloorPlans />} />
          <Route path="/admin/sensors"          element={<AdminSensors />} />
          <Route path="/admin/visitors"         element={<AdminVisitors />} />
          <Route path="/admin/invoices"         element={<AdminInvoices />} />
          <Route path="/profile"              element={<Profile />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
      <ConfirmHost />
      <SessionExpiredModal />
    </>
  );
}
