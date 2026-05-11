<template>
  <aside class="sidebar" :class="{ open }">
    <div class="brand">
      <div class="logo">
        <Flame :size="18" v-if="!brand.brand_logo_url" />
        <img v-else :src="brand.brand_logo_url" alt="" style="width:100%;height:100%;border-radius:9px;object-fit:cover;" />
      </div>
      <div class="name">
        {{ brand.brand_name || $t('app.title') }}
        <small>{{ $t('app.tagline') }}</small>
      </div>
    </div>

    <div class="nav-section">
      <div class="nav-section-label">{{ $t('sidebar.workspace') }}</div>
      <div class="nav">
        <router-link v-if="show('dashboard')" to="/" @click="$emit('navigate')">
          <LayoutGrid :size="16" /> {{ $t('nav.dashboard') }}
        </router-link>
        <router-link v-if="show('search')" to="/search" @click="$emit('navigate')">
          <CalendarSearch :size="16" /> {{ $t('nav.search') }}
        </router-link>
        <router-link v-if="show('my-bookings')" to="/my" @click="$emit('navigate')">
          <Calendar :size="16" /> {{ $t('nav.myBookings') }}
        </router-link>
        <router-link v-if="show('approvals') && canApprove" to="/approvals" @click="$emit('navigate')">
          <ShieldCheck :size="16" /> {{ $t('nav.approvals') }}
        </router-link>
      </div>
    </div>

    <div class="nav-section" v-if="canAdmin">
      <div class="nav-section-label">{{ $t('sidebar.management') }}</div>
      <div class="nav">
        <router-link v-if="show('reports')" to="/reports" @click="$emit('navigate')">
          <BarChart3 :size="16" /> {{ $t('nav.reports') }}
        </router-link>
        <router-link v-if="show('admin')" to="/admin" @click="$emit('navigate')">
          <Sliders :size="16" /> {{ $t('nav.admin') }}
        </router-link>
        <router-link to="/admin/resources" @click="$emit('navigate')" class="sub">
          <Boxes :size="14" /> {{ $t('nav.resources') }}
        </router-link>
        <router-link to="/admin/resource-types" @click="$emit('navigate')" class="sub">
          <Tag :size="14" /> {{ $t('nav.resourceTypes') }}
        </router-link>
        <router-link to="/admin/users" @click="$emit('navigate')" class="sub">
          <UsersIcon :size="14" /> {{ $t('nav.users') }}
        </router-link>
        <router-link to="/admin/departments" @click="$emit('navigate')" class="sub">
          <Building :size="14" /> {{ $t('nav.departments') }}
        </router-link>
        <router-link to="/admin/holidays" @click="$emit('navigate')" class="sub">
          <CalendarDays :size="14" /> {{ $t('nav.holidays') }}
        </router-link>
        <router-link to="/admin/approval-chain" @click="$emit('navigate')" class="sub">
          <GitBranch :size="14" /> {{ $t('nav.approvalChain') }}
        </router-link>
        <router-link to="/admin/webhooks" @click="$emit('navigate')" class="sub">
          <Webhook :size="14" /> {{ $t('nav.webhooks') }}
        </router-link>
        <router-link to="/admin/integrations" @click="$emit('navigate')" class="sub">
          <Plug :size="14" /> {{ $t('nav.integrations') }}
        </router-link>
        <router-link to="/admin/permissions" @click="$emit('navigate')" class="sub">
          <Lock :size="14" /> {{ $t('nav.permissions') }}
        </router-link>
        <router-link to="/admin/scim" @click="$emit('navigate')" class="sub">
          <KeyRound :size="14" /> {{ $t('nav.scim') }}
        </router-link>
      </div>
    </div>

    <div class="footer">
      <a class="nav" href="/api/docs" target="_blank" style="font-size: 12px; color: var(--text-muted); padding: 6px 12px;">
        <BookOpen :size="14" style="margin-right: 6px;" /> {{ $t('topbar.apiDocs') }}
      </a>
      <div class="row" style="padding: 6px 12px; gap: 8px; color: var(--text-muted); font-size: 11px;">
        <Cloud :size="12" /> {{ status }}
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import {
  Flame, LayoutGrid, CalendarSearch, Calendar, ShieldCheck,
  BarChart3, Sliders, BookOpen, Cloud,
  Boxes, Users as UsersIcon, Building, CalendarDays,
  GitBranch, Webhook, Plug, Lock, KeyRound, Tag
} from 'lucide-vue-next'
import { useTenantStore } from '../stores/tenant'

defineProps({ open: Boolean })
defineEmits(['navigate'])

const tenant = useTenantStore()
const brand = computed(() => tenant.customization || {})
const modules = computed(() => brand.value.sidebar_modules || ['dashboard', 'search', 'my-bookings', 'approvals', 'reports', 'admin'])
const show = (k) => modules.value.includes(k)

const role = computed(() => {
  try { return JSON.parse(atob(localStorage.getItem('fsd_jwt').split('.')[1])).role } catch { return '' }
})
const canAdmin   = computed(() => ['System Admin', 'Security Admin', 'Room Admin'].includes(role.value))
const canApprove = computed(() => ['System Admin', 'Security Admin', 'Room Admin', 'Secretary'].includes(role.value))

const status = 'Connected · v1.0'
</script>

<style scoped>
.nav a.sub { padding-left: 32px; font-size: 12.5px; }
</style>
