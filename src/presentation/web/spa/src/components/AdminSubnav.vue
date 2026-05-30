<template>
  <nav class="admin-subnav" aria-label="Admin sections">
    <div v-for="g in groups" :key="g.label"
         class="adm-group"
         :class="{ active: g.activeChild }"
         v-click-outside="() => (openKey === g.label ? openKey = null : null)">
      <button class="adm-trigger" @click="toggle(g.label)" :aria-expanded="openKey === g.label">
        <component :is="g.icon" :size="14" />
        <span>{{ g.label }}</span>
        <span class="caret">▾</span>
      </button>
      <div v-if="openKey === g.label" class="adm-menu" role="menu">
        <router-link v-for="i in g.items" :key="i.to" :to="i.to"
                     class="adm-item" @click="openKey = null">
          <component :is="i.icon" :size="14" />
          {{ i.label }}
        </router-link>
      </div>
    </div>
  </nav>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  Briefcase, Building, CalendarDays, Megaphone, Sliders,
  Calendar, GitBranch,
  Boxes, Tag, Network,
  Users as UsersIcon, Lock, KeyRound,
  Webhook, Plug,
  LayoutPanelTop, BookOpen, DoorOpen, ShieldCheck, Cable
} from 'lucide-vue-next'

const route = useRoute()
const openKey = ref(null)

const role = computed(() => {
  try { return JSON.parse(atob(localStorage.getItem('fsd_jwt').split('.')[1])).role } catch { return '' }
})
const isRoomAdmin = computed(() => ['Room Admin', 'System Admin', 'Security Admin'].includes(role.value))

const allGroups = computed(() => [
  {
    label: 'Workspace', icon: LayoutPanelTop,
    items: [
      { to: '/admin',                 label: 'Tenant Studio', icon: Sliders },
      { to: '/admin/departments',     label: 'Departments',   icon: Building },
      { to: '/admin/holidays',        label: 'Holidays',      icon: CalendarDays },
      { to: '/admin/broadcasts',      label: 'Broadcasts',    icon: Megaphone }
    ]
  },
  {
    label: 'Bookings', icon: BookOpen,
    items: [
      { to: '/admin/bookings',        label: 'All Bookings',   icon: Calendar, roomAdmin: true },
      { to: '/admin/approval-chain',  label: 'Approval Chain', icon: GitBranch }
    ]
  },
  {
    label: 'Resources', icon: DoorOpen,
    items: [
      { to: '/admin/resources',       label: 'Resources',       icon: Boxes, roomAdmin: true },
      { to: '/admin/resource-types',  label: 'Resource Types',  icon: Tag },
      { to: '/admin/location-groups', label: 'Room Privilege',  icon: Network }
    ]
  },
  {
    label: 'People', icon: ShieldCheck,
    items: [
      { to: '/admin/users',           label: 'Users',       icon: UsersIcon },
      { to: '/admin/permissions',     label: 'Permissions', icon: Lock },
      { to: '/admin/scim',            label: 'SCIM',        icon: KeyRound }
    ]
  },
  {
    label: 'Integrations', icon: Cable,
    items: [
      { to: '/admin/webhooks',        label: 'Webhooks',     icon: Webhook },
      { to: '/admin/integrations',    label: 'Integrations', icon: Plug }
    ]
  }
])

const groups = computed(() =>
  allGroups.value.map(g => {
    const items = g.items.filter(i => !i.roomAdmin || isRoomAdmin.value)
    const activeChild = items.some(i => i.to === route.path)
    return { ...g, items, activeChild }
  }).filter(g => g.items.length > 0)
)

function toggle(key) {
  openKey.value = openKey.value === key ? null : key
}
</script>

<style scoped>
.admin-subnav {
  display: flex; flex-wrap: wrap; gap: 4px;
  background: #fff; border: 1px solid var(--fsd-line, #e3e6ea);
  border-radius: 3px; padding: 8px 10px; margin-bottom: 18px;
}
.adm-group { position: relative; }
.adm-trigger {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 10px 6px 12px; border-radius: 3px;
  font: inherit; font-size: 13px;
  background: transparent; color: var(--text-secondary, #475569);
  border: 1px solid transparent; cursor: pointer;
  transition: background var(--dur-fast, 120ms), color var(--dur-fast, 120ms),
              border-color var(--dur-fast, 120ms);
}
.adm-trigger:hover { background: #f5f7fa; color: var(--text, #0f172a); }
.adm-trigger .caret { font-size: 9px; opacity: .55; margin-left: 2px; }
.adm-group.active .adm-trigger {
  background: var(--fsd-primary, #3498db);
  color: #fff; border-color: var(--fsd-primary, #3498db);
}
.adm-group.active .adm-trigger .caret { opacity: 1; }

.adm-menu {
  position: absolute; top: calc(100% + 4px); left: 0;
  min-width: 200px; padding: 4px;
  background: #fff; border: 1px solid var(--fsd-line, #e3e6ea);
  border-radius: 3px;
  box-shadow: 0 6px 18px rgba(15,23,42,.10), 0 2px 4px rgba(15,23,42,.04);
  z-index: 20;
}
.adm-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 3px;
  font-size: 13px; color: var(--text, #0f172a); text-decoration: none;
}
.adm-item:hover { background: #f5f7fa; }
.adm-item.router-link-exact-active {
  background: var(--fsd-primary, #3498db); color: #fff;
}
</style>
