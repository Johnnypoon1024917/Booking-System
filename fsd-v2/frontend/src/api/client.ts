import axios, { AxiosError } from 'axios';
import { useAuth } from '../hooks/useAuth';
import { useSession } from '../stores/session';

// Single axios instance. The request interceptor injects the JWT from
// localStorage; the response interceptor lifts ValidationPipe error
// messages out of the NestJS envelope so callers can show a useful
// toast instead of "[object Object]".
export const http = axios.create({
  baseURL: (import.meta as any).env?.VITE_API_URL || '',
  timeout: 30_000,
});

http.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('fsd_jwt');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

http.interceptors.response.use(
  (r) => r,
  (err: AxiosError<any>) => {
    if (err.response?.status === 401) {
      // Drop the dead token so no further request carries it, but keep the
      // zustand `user` so <RequireAuth> doesn't unmount the current route.
      localStorage.removeItem('fsd_jwt');
      const path = location.pathname;
      const onLogin = path === '/login';
      const onKiosk = path.startsWith('/kiosk');
      const hasSession = !!useAuth.getState().user;

      if (hasSession && !onLogin && !onKiosk) {
        // Soft re-auth: raise the in-place login modal instead of a hard
        // redirect, so an in-progress form keeps its React state (QA #4).
        useSession.getState().markExpired();
      } else if (!onLogin) {
        // No live session to preserve (or on kiosk) — fall back to the old
        // full redirect, remembering where to return after sign-in.
        localStorage.removeItem('fsd_user');
        try {
          sessionStorage.setItem('fsd_session_expired', '1');
          sessionStorage.setItem('fsd_return_to', path + location.search);
        } catch { /* storage may be unavailable (private mode) — still redirect */ }
        location.href = '/login';
      }
    }
    const msg = err.response?.data?.message;
    if (msg) (err as any).displayMessage = Array.isArray(msg) ? msg.join('; ') : String(msg);
    return Promise.reject(err);
  },
);

export const api = {
  // Auth
  login: (tenantSlug: string, username: string, password: string) =>
    http.post('/api/v1/auth/login', { tenantSlug, username, password }).then((r) => r.data),
  me: () => http.get('/api/v1/auth/me').then((r) => r.data),
  // Completes a forced first-login password reset. Returns a full session
  // ({ accessToken, user }) on success.
  changePassword: (changeToken: string, newPassword: string) =>
    http.post('/api/v1/auth/change-password', { changeToken, newPassword }).then((r) => r.data),

  // Customization
  customization: () => http.get('/api/v1/customization').then((r) => r.data),
  saveCustomization: (c: any) =>
    http.put('/api/v1/admin/customization', c).then((r) => r.data),

  // Resources
  resources: () => http.get('/api/v1/resources').then((r) => r.data),
  searchResources: (q: any) =>
    http.get('/api/v1/resources/search', { params: q }).then((r) => r.data),
  adminResources: () => http.get('/api/v1/admin/resources').then((r) => r.data),
  createResource: (b: any) => http.post('/api/v1/admin/resources', b).then((r) => r.data),
  updateResource: (id: string, b: any) =>
    http.put(`/api/v1/admin/resources/${id}`, b).then((r) => r.data),
  deleteResource: (id: string) => http.delete(`/api/v1/admin/resources/${id}`),
  resourceChildren: (id: string) =>
    http.get(`/api/v1/resources/${id}/children`).then((r) => r.data),

  // Bookings
  myBookings: () => http.get('/api/v1/bookings/mine').then((r) => r.data),
  bookingsRange: (start: string, end: string) =>
    http.get('/api/v1/bookings', { params: { start, end } }).then((r) => r.data),
  createBooking: (b: any) => http.post('/api/v1/bookings', b).then((r) => r.data),
  updateBooking: (id: string, b: any) =>
    http.put(`/api/v1/bookings/${id}`, b).then((r) => r.data),
  // Edit the whole recurring series an instance belongs to — returns
  // { updated, skipped[] }. Falls back to a single update server-side when the
  // booking isn't part of a series.
  updateBookingSeries: (id: string, b: any) =>
    http.put(`/api/v1/bookings/${id}/series`, b).then((r) => r.data),
  cancelBooking: (id: string, reason?: string) =>
    http.delete(`/api/v1/bookings/${id}`, { params: { reason } }),

  // Recurring bookings — POST returns { recurrenceId, bookingIds[], skipped[] }
  createRecurringBooking: (b: any) =>
    http.post('/api/v1/bookings/recurring', b).then((r) => r.data),
  cancelRecurringSeries: (id: string, reason?: string) =>
    http.delete(`/api/v1/bookings/recurring/${id}`, { params: { reason } }),

  // Check-in / no-show
  checkinBooking: (id: string) =>
    http.post(`/api/v1/bookings/${id}/checkin`).then((r) => r.data),
  markNoShow: (id: string) =>
    http.post(`/api/v1/bookings/${id}/no-show`).then((r) => r.data),
  issueCheckinToken: (id: string) =>
    http.post(`/api/v1/bookings/${id}/checkin-token`).then((r) => r.data),
  // Kiosk path — anonymous. Avoid using the shared `http` instance
  // because its interceptor would attach a stale JWT.
  redeemCheckinToken: (token: string) =>
    fetch(`/api/v1/checkin/${encodeURIComponent(token)}`, { method: 'POST' })
      .then(async (r) => {
        // Native fetch (unlike axios) resolves on 4xx/5xx — so an expired QR
        // (400) would otherwise look like a successful check-in. Surface the
        // server message as a real rejection instead.
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || 'Check-in failed');
        return data;
      }),

  // Free/busy — PII-free intervals (resourceId, start, end, status)
  busyIntervals: (start: string, end: string, resourceIds?: string[]) =>
    http.get('/api/v1/bookings/busy', {
      params: { start, end, resourceIds: resourceIds?.join(',') },
    }).then((r) => r.data),

  // ICS feed token + URL helper
  icsToken: () => http.get('/api/v1/bookings/ics-token').then((r) => r.data),
  icsFeedUrl: (tenantSlug: string, token: string) =>
    `${(import.meta as any).env?.VITE_API_URL || ''}/api/v1/ics/feed/${tenantSlug}.ics?token=${token}`,

  // Users / departments
  // Backward-compatible full directory (used by pickers/dropdowns elsewhere).
  users: () => http.get('/api/v1/admin/users').then((r) => r.data),
  // Server-side paginated + searchable listing for the AdminUsers table.
  // Returns { items, total, page, pageSize }. Each item carries managerName
  // so the edit form can show the current line manager without a full pull.
  usersPaged: (params: { page?: number; pageSize?: number; search?: string }) =>
    http.get('/api/v1/admin/users', { params: { page: 1, ...params } }).then((r) => r.data),
  createUser: (b: any) => http.post('/api/v1/admin/users', b).then((r) => r.data),
  updateUser: (id: string, b: any) =>
    http.put(`/api/v1/admin/users/${id}`, b).then((r) => r.data),
  deactivateUser: (id: string) => http.delete(`/api/v1/admin/users/${id}`),

  // Departments — full CRUD for AdminDepartments page.
  departments: () => http.get('/api/v1/admin/departments').then((r) => r.data),
  createDepartment: (b: any) => http.post('/api/v1/admin/departments', b).then((r) => r.data),
  updateDepartment: (id: string, b: any) =>
    http.put(`/api/v1/admin/departments/${id}`, b).then((r) => r.data),
  deleteDepartment: (id: string) => http.delete(`/api/v1/admin/departments/${id}`),

  // Admin bookings — the shared /bookings range endpoint already returns
  // every booking the caller can see (admins see all in their tenant).
  // Bulk cancel fans out per-booking DELETEs so the audit log captures
  // one entry per cancellation; there's no atomic bulk endpoint by design.
  adminBookings: (start: string, end: string) =>
    http.get('/api/v1/bookings', { params: { start, end } }).then((r) => r.data),
  bulkCancelBookings: (ids: string[], reason?: string) =>
    Promise.all(ids.map((id) => http.delete(`/api/v1/bookings/${id}`, { params: { reason } }))),
  markBookingNoShow: (id: string, reason: string) =>
    http.post(`/api/v1/admin/bookings/${id}/no-show`, { reason }).then((r) => r.data),
  markBookingAttended: (id: string) =>
    http.post(`/api/v1/admin/bookings/${id}/attended`, {}).then((r) => r.data),

  // Dashboard
  dashboard: (start: string, end: string, region?: string, location?: string) =>
    http.get('/api/v1/reports/dashboard', { params: { start, end, region: region || undefined, location: location || undefined } }).then((r) => r.data),

  // Reports — tabular preview & file export.
  reportTable: (type: string, start: string, end: string) =>
    http.get('/api/v1/reports/table', { params: { type, start, end } }).then((r) => r.data),

  // Export downloads a binary file. Returns the raw axios response so
  // the caller can pull headers (Content-Disposition) for the filename.
  exportReport: (type: string, format: 'csv' | 'xlsx', start: string, end: string) =>
    http.get('/api/v1/reports/export', {
      params: { type, format, start, end },
      responseType: 'blob',
    }),

  // DSAR self-service export — JSON download of the caller's data.
  dsarExportMe: () =>
    http.get('/api/v1/dsar/me', { responseType: 'blob' }),
  // Right-to-erasure: queues an audit-logged request for an administrator to
  // action (kept for workflows that require manual review).
  requestErasure: (reason?: string) =>
    http.post('/api/v1/dsar/erasure-request', { reason }).then((r) => r.data),
  // Immediate self-service erasure — anonymises + deactivates the account.
  // The caller must clear its session afterwards (login no longer works).
  eraseMyAccount: () =>
    http.delete('/api/v1/dsar/me').then((r) => r.data),

  // Approvals
  listApprovals: () => http.get('/api/v1/approvals').then((r) => r.data),
  approvalChain: (bookingId: string) =>
    http.get(`/api/v1/approvals/${bookingId}/chain`).then((r) => r.data),
  approveBooking: (bookingId: string, reason?: string) =>
    http.post(`/api/v1/approvals/${bookingId}/approve`, { reason }).then((r) => r.data),
  rejectBooking: (bookingId: string, reason: string) =>
    http.post(`/api/v1/approvals/${bookingId}/reject`, { status: 'rejected', reason }).then((r) => r.data),
  delegateBooking: (bookingId: string, toUserId: string, reason?: string) =>
    http.post(`/api/v1/approvals/${bookingId}/delegate`, { to_user_id: toUserId, reason }).then((r) => r.data),
  // Typeahead directory search for the delegate picker (no full-directory pull).
  searchApprovers: (q: string) =>
    http.get('/api/v1/approvals/users/search', { params: { q } }).then((r) => r.data),

  // Approval rules (admin)
  listApprovalRules: () => http.get('/api/v1/admin/approval-rules').then((r) => r.data),
  createApprovalRule: (r: any) => http.post('/api/v1/admin/approval-rules', r).then((res) => res.data),
  updateApprovalRule: (id: string, r: any) =>
    http.put(`/api/v1/admin/approval-rules/${id}`, r).then((res) => res.data),
  deleteApprovalRule: (id: string) => http.delete(`/api/v1/admin/approval-rules/${id}`),

  // Permissions (admin)
  getPermissions: () => http.get('/api/v1/admin/permissions').then((r) => r.data),
  // Returns { version } — the new optimistic-concurrency token. Pass the
  // role's last-known version as expectedVersion so a concurrent edit is
  // rejected (409) instead of silently overwritten.
  setRolePermissions: (role: string, permissions: string[], expectedVersion?: string) =>
    http.put(`/api/v1/admin/permissions/${encodeURIComponent(role)}`, { permissions, expectedVersion })
      .then((r) => r.data),

  // Broadcasts (R13 banner)
  activeBroadcasts: () => http.get('/api/v1/broadcasts').then((r) => r.data),
  listBroadcasts: () => http.get('/api/v1/admin/broadcasts').then((r) => r.data),
  createBroadcast: (b: any) => http.post('/api/v1/admin/broadcasts', b).then((r) => r.data),
  updateBroadcast: (id: string, b: any) =>
    http.put(`/api/v1/admin/broadcasts/${id}`, b).then((r) => r.data),
  deleteBroadcast: (id: string) => http.delete(`/api/v1/admin/broadcasts/${id}`),

  // Holidays
  listHolidays: () => http.get('/api/v1/admin/holidays').then((r) => r.data),
  createHoliday: (b: any) => http.post('/api/v1/admin/holidays', b).then((r) => r.data),
  updateHoliday: (id: string, b: any) =>
    http.put(`/api/v1/admin/holidays/${id}`, b).then((r) => r.data),
  deleteHoliday: (id: string) => http.delete(`/api/v1/admin/holidays/${id}`),
  syncHKHolidays: (locale?: string) =>
    http.post('/api/v1/admin/holidays/sync-hk', null, { params: { locale } }).then((r) => r.data),

  // Weather (HKO)
  weather: () => http.get('/api/v1/weather').then((r) => r.data),

  // Web Push (VAPID)
  vapidKey: () => http.get('/api/v1/push/vapid-key').then((r) => r.data),
  pushSubscribe: (sub: any) =>
    http.post('/api/v1/push/subscribe', sub).then((r) => r.data),
  pushUnsubscribe: (endpoint: string) =>
    http.delete('/api/v1/push/unsubscribe', { data: { endpoint } }).then((r) => r.data),
  pushTest: () => http.post('/api/v1/admin/push/test').then((r) => r.data),

  // Integrations (admin) — credential CRUD for MS Graph / Google /
  // Zoom / Teams Bot, plus the resource ↔ M365 mailbox map.
  listIntegrations: () => http.get('/api/v1/admin/integrations').then((r) => r.data),
  saveIntegration: (provider: string, body: any) =>
    http.put(`/api/v1/admin/integrations/${encodeURIComponent(provider)}`, body),
  deleteIntegration: (provider: string) =>
    http.delete(`/api/v1/admin/integrations/${encodeURIComponent(provider)}`),
  testIntegration: (provider: string) =>
    http.post(`/api/v1/admin/integrations/${encodeURIComponent(provider)}/test`).then((r) => r.data),
  listMailboxes: () => http.get('/api/v1/admin/integrations/mailboxes').then((r) => r.data),
  saveMailbox: (b: any) => http.put('/api/v1/admin/integrations/mailboxes', b),
  deleteMailbox: (resourceId: string) =>
    http.delete(`/api/v1/admin/integrations/mailboxes/${resourceId}`),

  // Graph manual reconcile — operators use this to force a renewal pass
  // instead of waiting for the hourly cron.
  graphSync: () => http.post('/api/v1/integrations/graph/sync').then((r) => r.data),

  // Teams proactive notify (admin)
  teamsNotify: (userId: string, text: string, card?: any) =>
    http.post('/api/v1/admin/teams/notify', { userId, text, card }).then((r) => r.data),

  // Webhooks (admin)
  listWebhooks: () => http.get('/api/v1/admin/webhooks').then((r) => r.data),
  createWebhook: (b: any) => http.post('/api/v1/admin/webhooks', b).then((r) => r.data),
  updateWebhook: (id: string, b: any) =>
    http.put(`/api/v1/admin/webhooks/${id}`, b),
  deleteWebhook: (id: string) => http.delete(`/api/v1/admin/webhooks/${id}`),
  listWebhookDeliveries: () =>
    http.get('/api/v1/admin/webhooks/deliveries').then((r) => r.data),

  // Locations
  locations: () => http.get('/api/v1/locations').then((r) => r.data),
  adminLocations: () => http.get('/api/v1/admin/locations').then((r) => r.data),
  createLocation: (b: any) => http.post('/api/v1/admin/locations', b).then((r) => r.data),
  updateLocation: (id: string, b: any) =>
    http.put(`/api/v1/admin/locations/${id}`, b).then((r) => r.data),
  deleteLocation: (id: string) => http.delete(`/api/v1/admin/locations/${id}`),

  // Location groups
  locationGroups: () => http.get('/api/v1/admin/location-groups').then((r) => r.data),
  createLocationGroup: (b: any) => http.post('/api/v1/admin/location-groups', b).then((r) => r.data),
  updateLocationGroup: (id: string, b: any) =>
    http.put(`/api/v1/admin/location-groups/${id}`, b).then((r) => r.data),
  deleteLocationGroup: (id: string) => http.delete(`/api/v1/admin/location-groups/${id}`),

  // Resource types
  resourceTypes: () => http.get('/api/v1/resource-types').then((r) => r.data),
  adminResourceTypes: () => http.get('/api/v1/admin/resource-types').then((r) => r.data),
  createResourceType: (b: any) => http.post('/api/v1/admin/resource-types', b).then((r) => r.data),
  updateResourceType: (id: string, b: any) =>
    http.put(`/api/v1/admin/resource-types/${id}`, b).then((r) => r.data),
  deleteResourceType: (id: string) => http.delete(`/api/v1/admin/resource-types/${id}`),

  // Services (catering, AV setup, etc.)
  services: () => http.get('/api/v1/services').then((r) => r.data),
  adminServices: () => http.get('/api/v1/admin/services').then((r) => r.data),
  createService: (b: any) => http.post('/api/v1/admin/services', b).then((r) => r.data),
  updateService: (id: string, b: any) =>
    http.put(`/api/v1/admin/services/${id}`, b).then((r) => r.data),
  deleteService: (id: string) => http.delete(`/api/v1/admin/services/${id}`),
  bookingServices: (bookingId: string) =>
    http.get(`/api/v1/bookings/${bookingId}/services`).then((r) => r.data),
  attachBookingService: (bookingId: string, b: any) =>
    http.post(`/api/v1/bookings/${bookingId}/services`, b).then((r) => r.data),
  detachBookingService: (bookingId: string, id: string) =>
    http.delete(`/api/v1/bookings/${bookingId}/services/${id}`),

  // Floor plans
  floorPlans: () => http.get('/api/v1/admin/floor-plans').then((r) => r.data),
  floorPlan: (id: string) => http.get(`/api/v1/admin/floor-plans/${id}`).then((r) => r.data),
  createFloorPlan: (b: any) => http.post('/api/v1/admin/floor-plans', b).then((r) => r.data),
  updateFloorPlan: (id: string, b: any) =>
    http.put(`/api/v1/admin/floor-plans/${id}`, b).then((r) => r.data),
  deleteFloorPlan: (id: string) => http.delete(`/api/v1/admin/floor-plans/${id}`),
  setDefaultFloorPlan: (id: string) =>
    http.post(`/api/v1/admin/floor-plans/${id}/set-default`).then((r) => r.data),
  duplicateFloorPlan: (id: string, name: string) =>
    http.post(`/api/v1/admin/floor-plans/${id}/duplicate`, { name }).then((r) => r.data),

  // Sensors — enrol returns { sensor, secret } and secret is shown ONCE.
  sensors: () => http.get('/api/v1/admin/sensors').then((r) => r.data),
  enrolSensor: (b: any) => http.post('/api/v1/admin/sensors', b).then((r) => r.data),
  updateSensor: (id: string, b: any) =>
    http.put(`/api/v1/admin/sensors/${id}`, b).then((r) => r.data),
  deleteSensor: (id: string) => http.delete(`/api/v1/admin/sensors/${id}`),
  sensorReadings: (resourceId: string, limit = 50) =>
    http.get('/api/v1/admin/sensors/readings', { params: { resourceId, limit } }).then((r) => r.data),

  // Visitors
  visitors: (q?: { from?: string; to?: string; status?: string }) =>
    http.get('/api/v1/admin/visitors', { params: q }).then((r) => r.data),
  createVisitor: (b: any) => http.post('/api/v1/admin/visitors', b).then((r) => r.data),
  updateVisitor: (id: string, b: any) =>
    http.put(`/api/v1/admin/visitors/${id}`, b).then((r) => r.data),
  deleteVisitor: (id: string) => http.delete(`/api/v1/admin/visitors/${id}`),
  checkInVisitor: (id: string) => http.post(`/api/v1/visitors/${id}/check-in`).then((r) => r.data),
  checkOutVisitor: (id: string) => http.post(`/api/v1/visitors/${id}/check-out`).then((r) => r.data),
  cancelVisitor: (id: string) => http.post(`/api/v1/visitors/${id}/cancel`).then((r) => r.data),

  // Invoices (chargeback rollup)
  invoices: (status?: string) =>
    http.get('/api/v1/admin/invoices', { params: status ? { status } : {} }).then((r) => r.data),
  invoice: (id: string) => http.get(`/api/v1/admin/invoices/${id}`).then((r) => r.data),
  runInvoices: (period: string, taxRate = 0) =>
    http.post('/api/v1/admin/invoices/run', { period, taxRate }).then((r) => r.data),
  issueInvoice: (id: string) =>
    http.post(`/api/v1/admin/invoices/${id}/issue`).then((r) => r.data),
  markInvoicePaid: (id: string) =>
    http.post(`/api/v1/admin/invoices/${id}/mark-paid`).then((r) => r.data),
  cancelInvoice: (id: string) =>
    http.post(`/api/v1/admin/invoices/${id}/cancel`).then((r) => r.data),
  deleteInvoice: (id: string) => http.delete(`/api/v1/admin/invoices/${id}`),

  // Kiosk — these endpoints are unauthenticated; the optional kiosk
  // token is supplied via an X-Kiosk-Token header set by the operator
  // (commonly at the reverse proxy). We pass it through localStorage
  // so a kiosk PWA can set-once-and-forget.
  kioskState: (resourceId: string) =>
    http.get(`/api/v1/kiosk/${resourceId}/state`, {
      headers: kioskHeaders(),
    }).then((r) => r.data),
  kioskQuickBook: (resourceId: string, b: any) =>
    http.post(`/api/v1/kiosk/${resourceId}/quick-book`, b, {
      headers: kioskHeaders(),
    }).then((r) => r.data),

  // ---------- MFA (TOTP) ----------
  mfaStatus: () => http.get('/api/v1/mfa/status').then((r) => r.data),
  mfaEnroll: () => http.post('/api/v1/mfa/enroll').then((r) => r.data),
  mfaVerify: (code: string) => http.post('/api/v1/mfa/verify', { code }).then((r) => r.data),
  mfaDisable: (code: string) =>
    http.delete('/api/v1/mfa/disable', { data: { code } }).then((r) => r.data),
  mfaLoginVerify: (mfaToken: string, code: string) =>
    http.post('/api/v1/mfa/login-verify', { mfaToken, code }).then((r) => r.data),

  // ---------- WebAuthn (passkeys) ----------
  passkeyList: () => http.get('/api/v1/webauthn/list').then((r) => r.data),
  passkeyRegisterStart: () => http.post('/api/v1/webauthn/register-start').then((r) => r.data),
  passkeyRegisterFinish: (response: any, nickname?: string) =>
    http.post('/api/v1/webauthn/register-finish', { response, nickname }).then((r) => r.data),
  passkeyDelete: (id: string) => http.delete(`/api/v1/webauthn/delete/${id}`),
  passkeyLoginStart: (tenantSlug: string, username: string) =>
    http.post('/api/v1/webauthn/login-start', { tenantSlug, username }).then((r) => r.data),
  passkeyLoginFinish: (tenantSlug: string, username: string, response: any) =>
    http.post('/api/v1/webauthn/login-finish', { tenantSlug, username, response }).then((r) => r.data),

  // ---------- SSO ----------
  ssoProviders: (tenantSlug: string) =>
    http.get('/api/v1/sso/providers', { params: { tenant: tenantSlug } }).then((r) => r.data),
  ssoLdapLogin: (tenantSlug: string, provider: string, username: string, password: string) =>
    http.post('/api/v1/sso/ldap/login', { tenantSlug, provider, username, password }).then((r) => r.data),
  ssoAdminProviders: () => http.get('/api/v1/sso/admin/providers').then((r) => r.data),
  ssoAdminCreate: (b: any) => http.post('/api/v1/sso/admin/providers', b).then((r) => r.data),
  ssoAdminUpdate: (id: string, b: any) =>
    http.put(`/api/v1/sso/admin/providers/${id}`, b).then((r) => r.data),
  ssoAdminDelete: (id: string) => http.delete(`/api/v1/sso/admin/providers/${id}`),

  // ---------- SCIM tokens ----------
  scimTokens: () => http.get('/api/v1/admin/scim/tokens').then((r) => r.data),
  scimIssue: (name: string, expiresInDays?: number) =>
    http.post('/api/v1/admin/scim/tokens', { name, expiresInDays }).then((r) => r.data),
  scimRevoke: (id: string) => http.delete(`/api/v1/admin/scim/tokens/${id}`),
};

function kioskHeaders(): Record<string, string> {
  const t = localStorage.getItem('fsd_kiosk_token');
  return t ? { 'X-Kiosk-Token': t } : {};
}
