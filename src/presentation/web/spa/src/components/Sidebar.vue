<template>
  <aside class="sidebar fsd-side fsd-side-light" :class="{ open }">
    <div class="fsd-brand" :class="{ 'has-image': !!brand.brand_logo_url }">
      <div class="logo">
        <Flame :size="16" v-if="!brand.brand_logo_url" />
        <img v-else :src="brand.brand_logo_url" alt="logo" class="brand-img" />
      </div>
    </div>

    <nav class="fsd-nav">
      <router-link v-if="show('dashboard')" to="/" @click="$emit('navigate')">
        <Gauge :size="22" /><span>Dashboard</span>
      </router-link>
      <router-link v-if="show('calendar')" to="/calendar" @click="$emit('navigate')">
        <Calendar :size="22" /><span>Schedule</span>
      </router-link>
      <router-link v-if="show('search')" to="/search" @click="$emit('navigate')">
        <Plus :size="22" /><span>New&nbsp;Booking</span>
      </router-link>
      <router-link v-if="show('my-bookings')" to="/my" @click="$emit('navigate')">
        <Menu :size="22" /><span>My&nbsp;Bookings</span>
      </router-link>
      <!-- Approvals: surfaced for approver roles so a pending booking can
           actually be acted on. Without this link the Approvals page (and
           the approve/reject buttons it hosts) was unreachable (QA #15). -->
      <router-link v-if="canApprove" to="/approvals" @click="$emit('navigate')">
        <CheckCircle :size="22" /><span>Approvals</span>
      </router-link>
      <router-link v-if="show('reports') && canAdmin" to="/reports" @click="$emit('navigate')">
        <BarChart3 :size="22" /><span>Reports</span>
      </router-link>
      <!-- Broadcasts intentionally moved off the top-level sidebar.
           Still reachable via Settings → Workspace → Broadcasts to
           keep the top-level nav focused on the 7 client items. -->
      <router-link v-if="show('admin') && canAdmin" to="/admin" @click="$emit('navigate')">
        <Settings :size="22" /><span>Settings</span>
      </router-link>
    </nav>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import {
  Flame, Gauge, Calendar, Plus, Menu,
  BarChart3, Settings, CheckCircle
} from 'lucide-vue-next'
import { useTenantStore } from '../stores/tenant'

defineProps({ open: Boolean })
defineEmits(['navigate'])

const tenant = useTenantStore()
const brand = computed(() => tenant.customization || {})
const modules = computed(() => brand.value.sidebar_modules || [])
const show = (k) => !modules.value.length || modules.value.includes(k)

const role = computed(() => {
  try { return JSON.parse(atob(localStorage.getItem('fsd_jwt').split('.')[1])).role } catch { return '' }
})
const canAdmin = computed(() => ['System Admin', 'Security Admin', 'Room Admin'].includes(role.value))
// Approvers = admins + Secretary (SDO). They need the Approvals link to act
// on pending bookings; general users don't see it to avoid nav clutter.
const canApprove = computed(() => canAdmin.value || role.value === 'Secretary')
</script>
