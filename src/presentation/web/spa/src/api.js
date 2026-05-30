// Thin fetch wrapper so the rest of the app stays free of fetch boilerplate
// and JWT plumbing. Throws on non-2xx so callers can rely on .then = success.
const TOKEN_KEY = 'fsd_jwt'

export function setToken(t) { localStorage.setItem(TOKEN_KEY, t) }
export function getToken() { return localStorage.getItem(TOKEN_KEY) }
export function clearToken() { localStorage.removeItem(TOKEN_KEY) }

async function request(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  }
  // Don't set content-type when uploading FormData — let the browser set
  // the multipart boundary automatically.
  if (opts.body instanceof FormData) {
    delete headers['Content-Type']
  }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(path, { ...opts, headers })
  if (res.status === 401) {
    clearToken()
    if (!path.endsWith('/login')) location.href = '/'
    throw new Error('Unauthorized')
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`Too many attempts — retry in ${body.retry_in_seconds || 60}s`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  if (res.status === 204) return null
  const ct = res.headers.get('content-type') || ''
  return ct.includes('application/json') ? res.json() : res.blob()
}

// requestList wraps a list endpoint so an empty result is always an array.
// Go marshals a nil slice as JSON `null`; without this every caller would
// have to defend against `null.filter`/`null.length`/`null.map`.
async function requestList(path, opts) {
  const data = await request(path, opts)
  return Array.isArray(data) ? data : (data == null ? [] : data)
}

export const api = {
  // ----- Bookings -----
  searchRooms: (q) =>
    requestList(`/api/v1/bookings/search?` + new URLSearchParams(q).toString()),
  // "Next available" suggestions — returns up to `limit` future windows
  // matching the same criteria as searchRooms, with a sample room each.
  suggestSlots: (q) =>
    requestList(`/api/v1/bookings/suggest-slots?` + new URLSearchParams(q).toString()),
  createBooking: (b) =>
    request('/api/v1/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify(b)
    }),
  getBooking:    (id)    => request(`/api/v1/bookings/${id}`),
  updateBooking: (id, b) => request(`/api/v1/bookings/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  cancelBooking: (id, reason) =>
    request(`/api/v1/bookings/${id}` + (reason ? `?reason=${encodeURIComponent(reason)}` : ''), { method: 'DELETE' }),
  checkInBooking: (id)   => request(`/api/v1/bookings/checkin/${id}`, { method: 'POST' }),
  myBookings:    ()      => requestList('/api/v1/me/bookings'),
  listAllBookings: (date) => requestList(`/api/v1/admin/bookings${date ? `?date=${date}` : ''}`),
  // Range variant for Week/Month calendar views — the single-date form
  // only returns one day's worth, which left bookings on the other
  // weekdays invisible on the timeGridWeek/dayGridMonth grids.
  listAllBookingsRange: (start, end) => requestList(`/api/v1/admin/bookings?start=${start}&end=${end}`),
  // PII-free busy intervals — every booker can hit this so the calendar
  // greys out slots others have taken. No name, no title; just
  // {resource_id, start_time, end_time, status}.
  busyIntervals: (date)  => requestList(`/api/v1/bookings/busy${date ? `?date=${date}` : ''}`),
  busyIntervalsRange: (start, end) => requestList(`/api/v1/bookings/busy?start=${start}&end=${end}`),

  // ----- Approvals -----
  listApprovals: ()                  => requestList('/api/v1/approvals'),
  approveBooking: (id, reason = '')  => request(`/api/v1/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ reason }) }),
  rejectBooking:  (id, reason)       => request(`/api/v1/approvals/${id}/reject`,  { method: 'POST', body: JSON.stringify({ reason }) }),
  delegateBooking:(id, toUserID, reason = '') => request(`/api/v1/approvals/${id}/delegate`, { method: 'POST', body: JSON.stringify({ to_user_id: toUserID, reason }) }),
  approvalChain:  (id)               => request(`/api/v1/approvals/${id}/chain`),

  // ----- Customization -----
  getCustomization:    ()    => request('/api/v1/admin/customization'),
  saveCustomization:   (c)   => request('/api/v1/admin/customization', { method: 'PUT', body: JSON.stringify(c) }),
  resetCustomization:  ()    => request('/api/v1/admin/customization', { method: 'DELETE' }),

  // ----- Reports -----
  exportUsage: (format = 'xlsx', start, end) => {
    const url = `/api/v1/reports/usage?format=${format}&start=${start || ''}&end=${end || ''}`
    return fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.blob())
  },
  getDashboard: (start, end) =>
    request(`/api/v1/reports/dashboard?start=${start || ''}&end=${end || ''}`),
  getWeather: () => request('/api/v1/weather'),
  roomCatalog: () => requestList('/api/v1/resources'),

  // ----- Managed Locations -----
  listLocations:   ()      => requestList('/api/v1/locations'),
  createLocation:  (l)     => request('/api/v1/admin/locations', { method: 'POST', body: JSON.stringify(l) }),
  updateLocation:  (id, l) => request(`/api/v1/admin/locations/${id}`, { method: 'PUT', body: JSON.stringify(l) }),
  deleteLocation:  (id)    => request(`/api/v1/admin/locations/${id}`, { method: 'DELETE' }),
  getReportData: (type, start, end) =>
    request(`/api/v1/reports/data?type=${encodeURIComponent(type)}&start=${start || ''}&end=${end || ''}`),
  exportReport: (type, format = 'xlsx', start, end) => {
    const url = `/api/v1/reports/export?type=${encodeURIComponent(type)}&format=${format}&start=${start || ''}&end=${end || ''}`
    return fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.blob())
  },

  // ----- Broadcast Messaging (R13) -----
  activeBroadcasts:  ()      => requestList('/api/v1/broadcasts'),
  listBroadcasts:    ()      => requestList('/api/v1/admin/broadcasts'),
  createBroadcast:   (b)     => request('/api/v1/admin/broadcasts', { method: 'POST', body: JSON.stringify(b) }),
  updateBroadcast:   (id, b) => request(`/api/v1/admin/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteBroadcast:   (id)    => request(`/api/v1/admin/broadcasts/${id}`, { method: 'DELETE' }),

  // ----- Location user groups (Room Privilege Setup) -----
  listLocationGroups:  ()      => requestList('/api/v1/admin/location-groups'),
  createLocationGroup: (g)     => request('/api/v1/admin/location-groups', { method: 'POST', body: JSON.stringify(g) }),
  updateLocationGroup: (id, g) => request(`/api/v1/admin/location-groups/${id}`, { method: 'PUT', body: JSON.stringify(g) }),
  deleteLocationGroup: (id)    => request(`/api/v1/admin/location-groups/${id}`, { method: 'DELETE' }),

  // ----- Resources -----
  listResources:    ()         => requestList('/api/v1/admin/resources'),
  getResource:      (id)       => request(`/api/v1/admin/resources/${id}`),
  createResource:   (r)        => request('/api/v1/admin/resources', { method: 'POST', body: JSON.stringify(r) }),
  updateResource:   (id, r)    => request(`/api/v1/admin/resources/${id}`, { method: 'PUT', body: JSON.stringify(r) }),
  deactivateResource:(id)      => request(`/api/v1/admin/resources/${id}`, { method: 'DELETE' }),
  splitResource:    (id, body) => request(`/api/v1/admin/resources/${id}/split`, { method: 'POST', body: JSON.stringify(body) }),
  getOperatingHours:(id)       => request(`/api/v1/admin/resources/${id}/operating-hours`),
  setOperatingHours:(id, hours) => request(`/api/v1/admin/resources/${id}/operating-hours`, { method: 'PUT', body: JSON.stringify(hours) }),

  // ----- Floor plans -----
  listFloorPlans:      ()         => requestList('/api/v1/admin/floor-plans'),
  getFloorPlan:        (id)       => request(`/api/v1/admin/floor-plans/${id}`),
  createFloorPlan:     (p)        => request('/api/v1/admin/floor-plans', { method: 'POST', body: JSON.stringify(p) }),
  updateFloorPlan:     (id, p)    => request(`/api/v1/admin/floor-plans/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteFloorPlan:     (id)       => request(`/api/v1/admin/floor-plans/${id}`, { method: 'DELETE' }),
  duplicateFloorPlan:  (id, name) => request(`/api/v1/admin/floor-plans/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ name }) }),
  setDefaultFloorPlan: (id)       => request(`/api/v1/admin/floor-plans/${id}/default`, { method: 'POST' }),

  // ----- Users -----
  listUsers:        ()      => requestList('/api/v1/admin/users'),
  createUser:       (u)     => request('/api/v1/admin/users', { method: 'POST', body: JSON.stringify(u) }),
  updateUser:       (id, u) => request(`/api/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(u) }),
  deactivateUser:   (id)    => request(`/api/v1/admin/users/${id}`, { method: 'DELETE' }),

  // ----- Departments -----
  listDepartments:    ()      => requestList('/api/v1/admin/departments'),
  createDepartment:   (d)     => request('/api/v1/admin/departments', { method: 'POST', body: JSON.stringify(d) }),
  updateDepartment:   (id, d) => request(`/api/v1/admin/departments/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteDepartment:   (id)    => request(`/api/v1/admin/departments/${id}`, { method: 'DELETE' }),

  // ----- Integrations (Microsoft 365 / Google / Zoom) -----
  listIntegrations:   ()                  => requestList('/api/v1/admin/integrations'),
  saveIntegration:    (provider, body)    => request(`/api/v1/admin/integrations/${provider}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteIntegration:  (provider)          => request(`/api/v1/admin/integrations/${provider}`, { method: 'DELETE' }),
  testIntegration:    (provider)          => request(`/api/v1/admin/integrations/${provider}/test`, { method: 'POST' }),
  listMailboxes:      ()                  => requestList('/api/v1/admin/integrations/mailboxes'),
  saveMailbox:        (m)                 => request('/api/v1/admin/integrations/mailboxes', { method: 'PUT', body: JSON.stringify(m) }),
  deleteMailbox:      (resourceID)        => request(`/api/v1/admin/integrations/mailboxes/${resourceID}`, { method: 'DELETE' }),

  // ----- SCIM 2.0 admin tokens -----
  listScimTokens:     ()       => requestList('/api/v1/admin/scim/tokens'),
  issueScimToken:     (name)   => request('/api/v1/admin/scim/tokens', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeScimToken:    (id)     => request(`/api/v1/admin/scim/tokens/${id}`, { method: 'DELETE' }),

  // ----- Permissions matrix -----
  getPermissions:     ()                  => request('/api/v1/admin/permissions'),
  setRolePermissions: (role, permissions) => request(`/api/v1/admin/permissions/${encodeURIComponent(role)}`, { method: 'PUT', body: JSON.stringify({ permissions }) }),

  // ----- Approval rules (multi-level chain) -----
  listApprovalRules:   ()      => requestList('/api/v1/admin/approval-rules'),
  createApprovalRule:  (r)     => request('/api/v1/admin/approval-rules', { method: 'POST', body: JSON.stringify(r) }),
  updateApprovalRule:  (id, r) => request(`/api/v1/admin/approval-rules/${id}`, { method: 'PUT', body: JSON.stringify(r) }),
  deleteApprovalRule:  (id)    => request(`/api/v1/admin/approval-rules/${id}`, { method: 'DELETE' }),

  // ----- Webhooks -----
  listWebhooks:        ()        => requestList('/api/v1/admin/webhooks'),
  createWebhook:       (w)       => request('/api/v1/admin/webhooks', { method: 'POST', body: JSON.stringify(w) }),
  updateWebhook:       (id, w)   => request(`/api/v1/admin/webhooks/${id}`, { method: 'PUT', body: JSON.stringify(w) }),
  deleteWebhook:       (id)      => request(`/api/v1/admin/webhooks/${id}`, { method: 'DELETE' }),
  listWebhookDeliveries: ()      => requestList('/api/v1/admin/webhooks/deliveries'),
  retryWebhookDelivery:(id)      => request(`/api/v1/admin/webhooks/deliveries/${id}/retry`, { method: 'POST' }),

  // ----- Resource types (admin-defined catalog of asset types) -----
  listResourceTypes:    ()      => requestList('/api/v1/admin/resource-types'),
  createResourceType:   (t)     => request('/api/v1/admin/resource-types', { method: 'POST', body: JSON.stringify(t) }),
  updateResourceType:   (id, t) => request(`/api/v1/admin/resource-types/${id}`, { method: 'PUT', body: JSON.stringify(t) }),
  deleteResourceType:   (id)    => request(`/api/v1/admin/resource-types/${id}`, { method: 'DELETE' }),

  // ----- Permission groups (admin-defined permission keys + categories) -----
  listPermissionCatalog: ()     => request('/api/v1/admin/permission-catalog'),
  createPermissionGroup: (g)    => request('/api/v1/admin/permission-catalog/groups', { method: 'POST', body: JSON.stringify(g) }),
  deletePermissionGroup: (key)  => request(`/api/v1/admin/permission-catalog/groups/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  createCustomPermission:(p)    => request('/api/v1/admin/permission-catalog/permissions', { method: 'POST', body: JSON.stringify(p) }),
  deleteCustomPermission:(key)  => request(`/api/v1/admin/permission-catalog/permissions/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  // ----- Holidays -----
  listHolidays:    ()      => requestList('/api/v1/admin/holidays'),
  createHoliday:   (h)     => request('/api/v1/admin/holidays', { method: 'POST', body: JSON.stringify(h) }),
  updateHoliday:   (id, h) => request(`/api/v1/admin/holidays/${id}`, { method: 'PUT', body: JSON.stringify(h) }),
  deleteHoliday:   (id)    => request(`/api/v1/admin/holidays/${id}`, { method: 'DELETE' }),
  syncHKHolidays:  ()      => request('/api/v1/admin/holidays/sync-hk', { method: 'POST' }),
  importICSHolidays: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return request('/api/v1/admin/holidays/import-ics', { method: 'POST', body: fd })
  }
}

// idempotencyKey generates a UUID-ish opaque key for POST retry safety.
// crypto.randomUUID is available in all modern browsers; fallback to a
// timestamp+random combo for older environments.
function idempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

export function openRealtime(onEvent) {
  const token = getToken()
  if (!token) return null
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/v1/realtime?token=${token}`)
  ws.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data)) } catch (e) { /* ignore malformed */ }
  }
  ws.onclose = () => setTimeout(() => openRealtime(onEvent), 5000)
  return ws
}
