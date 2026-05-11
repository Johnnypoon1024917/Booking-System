import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from './api'

const Dashboard       = () => import('./views/Dashboard.vue')
const Search          = () => import('./views/Search.vue')
const MyBookings      = () => import('./views/MyBookings.vue')
const Approvals       = () => import('./views/Approvals.vue')
const Admin           = () => import('./views/Admin.vue')
const AdminResources  = () => import('./views/AdminResources.vue')
const AdminResourceTypes = () => import('./views/AdminResourceTypes.vue')
const AdminUsers      = () => import('./views/AdminUsers.vue')
const AdminDepartments = () => import('./views/AdminDepartments.vue')
const AdminHolidays      = () => import('./views/AdminHolidays.vue')
const AdminApprovalChain = () => import('./views/AdminApprovalChain.vue')
const AdminWebhooks      = () => import('./views/AdminWebhooks.vue')
const AdminIntegrations  = () => import('./views/AdminIntegrations.vue')
const AdminPermissions   = () => import('./views/AdminPermissions.vue')
const AdminScim          = () => import('./views/AdminScim.vue')
const Reports            = () => import('./views/Reports.vue')
const Profile            = () => import('./views/Profile.vue')
const Kiosk              = () => import('./views/Kiosk.vue')

const adminRoles = ['System Admin', 'Security Admin']
const roomAdminRoles = [...adminRoles, 'Room Admin']

export const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    { path: '/',          name: 'dashboard', component: Dashboard,  meta: { auth: true } },
    { path: '/search',    name: 'search',    component: Search,     meta: { auth: true } },
    { path: '/my',        name: 'my',        component: MyBookings, meta: { auth: true } },
    { path: '/approvals', name: 'approvals', component: Approvals,  meta: { auth: true } },
    { path: '/reports',   name: 'reports',   component: Reports,    meta: { auth: true, roles: adminRoles } },
    { path: '/me',        name: 'profile',   component: Profile,    meta: { auth: true } },

    // Admin module
    { path: '/admin',             name: 'admin',             component: Admin,            meta: { auth: true, roles: adminRoles } },
    { path: '/admin/resources',   name: 'admin-resources',   component: AdminResources,   meta: { auth: true, roles: roomAdminRoles } },
    { path: '/admin/resource-types', name: 'admin-resource-types', component: AdminResourceTypes, meta: { auth: true, roles: adminRoles } },
    { path: '/admin/users',       name: 'admin-users',       component: AdminUsers,       meta: { auth: true, roles: adminRoles } },
    { path: '/admin/departments', name: 'admin-departments', component: AdminDepartments, meta: { auth: true, roles: adminRoles } },
    { path: '/admin/holidays',        name: 'admin-holidays',        component: AdminHolidays,        meta: { auth: true, roles: adminRoles } },
    { path: '/admin/approval-chain',  name: 'admin-approval-chain',  component: AdminApprovalChain,  meta: { auth: true, roles: adminRoles } },
    { path: '/admin/webhooks',        name: 'admin-webhooks',        component: AdminWebhooks,       meta: { auth: true, roles: adminRoles } },
    { path: '/admin/integrations',    name: 'admin-integrations',    component: AdminIntegrations,   meta: { auth: true, roles: adminRoles } },
    { path: '/admin/permissions',     name: 'admin-permissions',     component: AdminPermissions,    meta: { auth: true, roles: adminRoles } },
    { path: '/admin/scim',            name: 'admin-scim',            component: AdminScim,           meta: { auth: true, roles: adminRoles } },

    { path: '/kiosk/:resourceId', name: 'kiosk', component: Kiosk, meta: { auth: false } }
  ]
})

router.beforeEach((to, from, next) => {
  if (!to.meta.auth) return next()
  if (!getToken()) {
    location.href = '/'
    return
  }
  next()
})
