<template>
  <header class="topbar">
    <button class="icon-btn" @click="$emit('toggle-sidebar')" aria-label="menu" v-if="isMobile">
      <Menu :size="18" />
    </button>

    <div class="search" role="search">
      <Search class="icon" :size="16" />
      <input v-model="q" type="text" :placeholder="$t('topbar.search')"
             @keyup.enter="onSearch" aria-label="search resources" />
    </div>

    <div class="actions">
      <button class="icon-btn" :title="$t('topbar.theme')" @click="theme.toggle()" aria-label="toggle theme">
        <Sun v-if="theme.mode === 'dark'" :size="18" />
        <Moon v-else :size="18" />
      </button>

      <!-- Language: button + menu inside one wrapper so click-outside ignores
           the toggle click that opened the menu. -->
      <div style="position: relative;" v-click-outside="() => langOpen = false">
        <button class="icon-btn" @click="langOpen = !langOpen" aria-label="language">
          <Globe :size="18" />
        </button>
        <div class="menu" :class="{ open: langOpen }">
          <div class="menu-header"><b>{{ $t('topbar.language') }}</b></div>
          <button v-for="l in availableLocales" :key="l" class="menu-item"
                  @click="pickLocale(l)">
            <span style="width: 24px;">{{ flagFor(l) }}</span>
            <span class="space">{{ labelFor(l) }}</span>
            <Check v-if="$i18n.locale === l" :size="14" />
          </button>
        </div>
      </div>

      <div style="position: relative;" v-click-outside="() => notifOpen = false">
        <button class="icon-btn" @click="notifOpen = !notifOpen" aria-label="notifications">
          <Bell :size="18" />
          <span v-if="unread > 0" class="badge">{{ unread }}</span>
        </button>
        <div class="menu" :class="{ open: notifOpen }" style="min-width: 320px;">
          <div class="menu-header" style="display:flex; justify-content: space-between; align-items: center;">
            <b>{{ $t('topbar.notifications') }}</b>
            <button class="btn subtle sm" @click="markAllRead">{{ $t('topbar.markAllRead') }}</button>
          </div>
          <div class="menu-divider" />
          <div v-if="notifLoading" style="padding: 18px; text-align:center;" class="muted text-sm">
            {{ $t('common.loading') }}
          </div>
          <div v-else-if="notifications.length === 0" style="padding: 18px; text-align:center;" class="muted text-sm">
            {{ $t('topbar.noNotifications') }}
          </div>
          <button v-for="n in notifications" :key="n.id" class="menu-item" style="align-items: flex-start;" @click="openNotification(n)">
            <span class="dot-mini" :style="{ background: dotColor(n.kind) }" />
            <div class="space" style="text-align:left;">
              <div style="font-size: 13px;">{{ n.title }}</div>
              <small class="muted">{{ relTime(n.at) }}</small>
            </div>
          </button>
        </div>
      </div>

      <div style="position: relative;" v-click-outside="() => userOpen = false">
        <button class="icon-btn" style="width:auto; padding: 4px 6px 4px 4px;" @click="userOpen = !userOpen">
          <Avatar :name="user.name" />
          <span style="font-size: 13px; margin: 0 4px 0 8px; max-width: 110px;" class="truncate">{{ user.name }}</span>
          <ChevronDown :size="14" />
        </button>
        <div class="menu" :class="{ open: userOpen }">
          <div class="menu-header">
            <b>{{ user.name }}</b>
            <small>{{ user.role }}</small>
          </div>
          <div class="menu-divider" />
          <button class="menu-item" @click="goTo('/me')"><User :size="14" /> {{ $t('topbar.profile') }}</button>
          <button class="menu-item" @click="goTo('/admin')" v-if="canAdmin">
            <Settings :size="14" /> {{ $t('nav.admin') }}
          </button>
          <a class="menu-item" href="/api/docs" target="_blank">
            <BookOpen :size="14" /> {{ $t('topbar.apiDocs') }}
          </a>
          <div class="menu-divider" />
          <button class="menu-item" @click="logout"><LogOut :size="14" /> {{ $t('app.logout') }}</button>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  Menu, Search, Bell, Sun, Moon, Globe, Check, ChevronDown,
  User, Settings, LogOut, BookOpen
} from 'lucide-vue-next'
import Avatar from './Avatar.vue'
import { useThemeStore } from '../stores/theme'
import { useTenantStore } from '../stores/tenant'
import { setLocale } from '../i18n'
import { api, clearToken, openRealtime } from '../api'

defineEmits(['toggle-sidebar'])

const router = useRouter()
const theme = useThemeStore()
const tenant = useTenantStore()
const { availableLocales: i18nLocales } = useI18n()

const q = ref('')
const langOpen = ref(false)
const notifOpen = ref(false)
const userOpen = ref(false)
const isMobile = ref(window.innerWidth < 880)

const onResize = () => { isMobile.value = window.innerWidth < 880 }
let ws = null
onMounted(() => {
  window.addEventListener('resize', onResize)
  loadNotifications()
  // Subscribe to live booking lifecycle events — push them onto the bell.
  ws = openRealtime((ev) => {
    if (ev.type?.startsWith('booking.')) {
      notifications.value.unshift({
        id: Date.now(),
        kind: ev.type.includes('cancelled') || ev.type.includes('rejected') ? 'warning' : 'info',
        title: prettifyEvent(ev.type) + (ev.resource_id ? ' · ' + shortId(ev.resource_id) : ''),
        at: Date.now(),
        booking_id: ev.booking_id
      })
    } else if (ev.type === 'weather.signal') {
      notifications.value.unshift({
        id: Date.now(),
        kind: 'warning',
        title: 'HK Observatory: ' + (ev.payload?.code || 'signal'),
        at: Date.now()
      })
    }
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  ws?.close?.()
})

const availableLocales = computed(() => tenant.customization?.available_locales || i18nLocales)

const user = computed(() => {
  let role = '', name = ''
  try {
    const t = localStorage.getItem('fsd_jwt')
    if (t) {
      const payload = JSON.parse(atob(t.split('.')[1]))
      role = payload.role || ''
      name = localStorage.getItem('fsd_user') || payload.sub || 'User'
    }
  } catch {}
  return { name, role }
})
const canAdmin = computed(() => ['System Admin', 'Security Admin'].includes(user.value.role))

// Notifications: pull from /me/bookings to surface anything pending or
// recently-decided. The endpoint already returns the user's own bookings;
// we shape it into a quick activity feed. Live updates come via WebSocket.
const notifications = ref([])
const notifLoading = ref(false)
async function loadNotifications() {
  notifLoading.value = true
  try {
    const list = await api.myBookings().catch(() => [])
    notifications.value = (list || []).slice(0, 6).map(b => ({
      id: b.ID,
      kind: b.Status === 'Pending Approval' ? 'warning'
          : b.Status === 'Cancelled' || b.Status === 'No Show' ? 'error'
          : 'success',
      title: b.Status + ': booking at ' + new Date(b.StartTime).toLocaleString(),
      at: new Date(b.CreatedAt).getTime(),
      booking_id: b.ID
    }))
  } finally { notifLoading.value = false }
}
const unread = computed(() => notifications.value.length)
function markAllRead() { notifications.value = []; notifOpen.value = false }
function openNotification(n) {
  notifOpen.value = false
  if (n.booking_id) router.push('/my')
}

function pickLocale(l) { setLocale(l); langOpen.value = false }
function labelFor(l)   { return l === 'zh-Hant' ? '繁體中文' : l === 'zh-Hans' ? '简体中文' : 'English' }
function flagFor(l)    { return l === 'zh-Hant' ? '🇭🇰' : l === 'zh-Hans' ? '🇨🇳' : '🇬🇧' }
function dotColor(k)   { return k === 'success' ? 'var(--success)' : k === 'warning' ? 'var(--warning)' : k === 'error' ? 'var(--danger)' : 'var(--info)' }

function relTime(ts) {
  if (!ts) return ''
  const d = (Date.now() - ts) / 1000
  if (d < 60) return `${Math.round(d)}s ago`
  if (d < 3600) return `${Math.round(d / 60)}m ago`
  if (d < 86400) return `${Math.round(d / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

function onSearch() { router.push({ name: 'search', query: { q: q.value } }) }
function goTo(path) { userOpen.value = false; router.push(path) }
function logout()   { clearToken(); location.href = '/' }

function prettifyEvent(t) {
  return t.replace('booking.', '').replace('_', ' ').replace(/^\w/, c => c.toUpperCase()) + ' booking'
}
function shortId(s) { return (s || '').slice(0, 8) }
</script>

<style scoped>
.dot-mini { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
</style>
