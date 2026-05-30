<template>
  <header class="topbar fsd-topbar">
    <button class="icon-btn" @click="$emit('toggle-sidebar')" aria-label="menu" v-if="isMobile">
      <Menu :size="18" />
    </button>

    <div class="fsd-clock"><Clock :size="13" /> {{ clock }}</div>

    <div class="actions">
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
        <button class="icon-btn fsd-user-btn" @click="userOpen = !userOpen">
          <Avatar :name="user.name" />
          <span class="truncate fsd-user-name">{{ user.name }}</span>
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
  Menu, Bell, Globe, Check, ChevronDown,
  User, Settings, LogOut, BookOpen, Clock
} from 'lucide-vue-next'
import Avatar from './Avatar.vue'
import { useTenantStore } from '../stores/tenant'
import { setLocale } from '../i18n'
import { api, clearToken, openRealtime } from '../api'

defineEmits(['toggle-sidebar'])

const router = useRouter()
const tenant = useTenantStore()
const { availableLocales: i18nLocales } = useI18n()

const langOpen = ref(false)
const notifOpen = ref(false)
const userOpen = ref(false)
const isMobile = ref(window.innerWidth < 880)

// Server time status in the global header (FSD spec §1.2).
const clock = ref('')
function tickClock() {
  clock.value = new Date().toLocaleString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  })
}
let clockTimer = null

const onResize = () => { isMobile.value = window.innerWidth < 880 }
let ws = null
onMounted(() => {
  tickClock()
  clockTimer = setInterval(tickClock, 1000)
  window.addEventListener('resize', onResize)
  loadNotifications()
  // Subscribe to live booking lifecycle events — push them onto the bell.
  ws = openRealtime((ev) => {
    if (ev.type?.startsWith('booking.')) {
      // Key the WS notification by the booking id so it shares an ack
      // namespace with the /me/bookings rows — a user who dismisses the
      // bell then receives the same booking via WS shouldn't see it pop
      // back up.
      const nid = ev.booking_id ? 'ws-booking-' + ev.booking_id : 'ws-' + ev.type + '-' + Date.now()
      if (readIds.value.has(nid)) return
      notifications.value.unshift({
        id: nid,
        kind: ev.type.includes('cancelled') || ev.type.includes('rejected') ? 'warning' : 'info',
        title: prettifyEvent(ev.type) + (ev.resource_id ? ' · ' + shortId(ev.resource_id) : ''),
        at: Date.now(),
        booking_id: ev.booking_id
      })
    } else if (ev.type === 'weather.signal') {
      const nid = 'ws-weather-' + (ev.payload?.code || 'signal')
      if (readIds.value.has(nid)) return
      notifications.value.unshift({
        id: nid,
        kind: 'warning',
        title: 'HK Observatory: ' + (ev.payload?.code || 'signal'),
        at: Date.now()
      })
    }
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  if (clockTimer) clearInterval(clockTimer)
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
//
// "Mark all read" tracks acknowledged IDs in localStorage, not a single
// "last read" timestamp. The old timestamp approach failed because:
//   1. WS-pushed events bypassed the filter on next page load.
//   2. Server / client clock skew or sub-second CreatedAt parsing made
//      the `>` comparison reject items the user had just dismissed.
// An ID set is unambiguous: a notification is read iff its id is in the
// set. Cap at 500 entries (LRU drop oldest) so it never grows unbounded.
const notifications = ref([])
const notifLoading = ref(false)
const readKey = computed(() => 'fsd_notif_read:' + (user.value.name || 'anon'))
const readIds = ref(loadReadIds())

function loadReadIds() {
  try {
    const raw = localStorage.getItem(readKey.value)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch { return new Set() }
}
function persistReadIds() {
  const arr = Array.from(readIds.value).slice(-500)
  localStorage.setItem(readKey.value, JSON.stringify(arr))
}

async function loadNotifications() {
  notifLoading.value = true
  try {
    const list = await api.myBookings().catch(() => [])
    notifications.value = (list || [])
      .slice(0, 6)
      .map(b => ({
        id: String(b.ID),
        kind: b.Status === 'Pending Approval' ? 'warning'
            : b.Status === 'Cancelled' || b.Status === 'No Show' ? 'error'
            : 'success',
        title: b.Status + ': booking at ' + new Date(b.StartTime).toLocaleString(),
        at: new Date(b.CreatedAt).getTime(),
        booking_id: b.ID
      }))
      .filter(n => !readIds.value.has(n.id))
  } finally { notifLoading.value = false }
}
const unread = computed(() => notifications.value.length)
function markAllRead() {
  for (const n of notifications.value) readIds.value.add(String(n.id))
  persistReadIds()
  notifications.value = []
  notifOpen.value = false
}
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
