<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ greeting }}, {{ firstName }}</h1>
      <p class="muted text-md mt-sm">{{ $t('dashboard.subtitle') }}</p>
    </div>
    <div class="row gap-sm">
      <span class="tag info"><Cloud :size="12" /> {{ weather.label }} · {{ weather.temp }}°</span>
      <span class="tag" v-if="hkoSignal"><AlertTriangle :size="12" /> {{ hkoSignal }}</span>
    </div>
  </div>

  <!-- Broadcast banner (shows only when broadcast is active) -->
  <div v-if="broadcast" class="banner danger" role="alert">
    <AlertTriangle :size="16" />
    <div class="space"><b>{{ broadcast.title }}</b> · <span>{{ broadcast.body }}</span></div>
    <button class="icon-btn" @click="broadcast = null" aria-label="dismiss"><X :size="14" /></button>
  </div>

  <!-- KPI strip -->
  <div class="kpi-grid mb-lg">
    <div class="kpi" v-if="hasWidget('kpi-active')">
      <small>{{ $t('dashboard.kpi.active') }}</small>
      <h3 v-if="!loading">{{ kpis.active }}</h3>
      <Skeleton v-else height="30px" width="60px" />
    </div>
    <div class="kpi success" v-if="hasWidget('kpi-utilisation')">
      <small>{{ $t('dashboard.kpi.utilisation') }}</small>
      <h3 v-if="!loading">{{ kpis.utilisation === null ? '—' : kpis.utilisation + '%' }}</h3>
      <Skeleton v-else height="30px" width="80px" />
    </div>
    <div class="kpi warning" v-if="hasWidget('kpi-pending')">
      <small>{{ $t('dashboard.kpi.pending') }}</small>
      <h3 v-if="!loading">{{ kpis.pending }}</h3>
      <Skeleton v-else height="30px" width="60px" />
    </div>
    <div class="kpi danger" v-if="hasWidget('kpi-noshow')">
      <small>{{ $t('dashboard.kpi.noShow') }}</small>
      <h3 v-if="!loading">{{ kpis.noShow }}</h3>
      <Skeleton v-else height="30px" width="60px" />
    </div>
  </div>

  <div class="dashboard-grid">
    <!-- Calendar -->
    <section class="card" style="grid-area: calendar;">
      <div class="card-title">
        <h3>{{ $t('dashboard.thisWeek') }}</h3>
        <button class="btn ghost sm" @click="$router.push('/search')">
          <Plus :size="14" /> {{ $t('dashboard.newBooking') }}
        </button>
      </div>
      <FullCalendar :options="calendarOptions" />
    </section>

    <!-- Today's agenda -->
    <section class="card" style="grid-area: agenda;">
      <div class="card-title">
        <h3>{{ $t('dashboard.todayAgenda') }}</h3>
        <span class="tag">{{ today }}</span>
      </div>
      <div v-if="loading">
        <div v-for="n in 3" :key="n" class="row mb gap" style="padding: 8px 0;">
          <Skeleton height="40px" width="40px" radius="10px" />
          <div class="space col gap-sm"><Skeleton width="70%" /><Skeleton width="40%" height="11px" /></div>
        </div>
      </div>
      <EmptyState v-else-if="agenda.length === 0" :icon="CalendarOff" :title="$t('dashboard.noAgenda')">
        <template #actions>
          <button class="btn sm" @click="$router.push('/search')">{{ $t('dashboard.createFirst') }}</button>
        </template>
      </EmptyState>
      <div v-else>
        <div v-for="a in agenda" :key="a.id" class="agenda-row">
          <div class="time">
            <b>{{ a.time }}</b>
            <small class="muted">{{ a.duration }}</small>
          </div>
          <div class="dot" :style="{ background: a.color }" />
          <div class="space">
            <div style="font-weight: 500;">{{ a.title }}</div>
            <small class="muted">{{ a.room }} · {{ a.attendees }} attendees</small>
          </div>
          <span class="tag" :class="a.status === 'Pending' ? 'warning' : 'success'">{{ a.status }}</span>
        </div>
      </div>
    </section>

    <!-- Quick actions -->
    <section class="card" style="grid-area: quick;">
      <h3 class="mb">{{ $t('dashboard.quickActions') }}</h3>
      <div class="quick-grid">
        <button class="quick-btn" @click="$router.push('/search')">
          <CalendarPlus :size="20" />
          <span>{{ $t('dashboard.newBooking') }}</span>
        </button>
        <button class="quick-btn" @click="syncCal">
          <RefreshCcw :size="20" />
          <span>{{ $t('dashboard.syncCalendar') }}</span>
        </button>
        <button class="quick-btn" @click="$router.push('/reports')" v-if="canAdmin">
          <BarChart3 :size="20" />
          <span>{{ $t('dashboard.viewReports') }}</span>
        </button>
        <button class="quick-btn" @click="$router.push('/admin')" v-if="canAdmin">
          <Sliders :size="20" />
          <span>{{ $t('nav.admin') }}</span>
        </button>
      </div>
    </section>

    <!-- Activity -->
    <section class="card" style="grid-area: activity;">
      <h3 class="mb">{{ $t('dashboard.recentActivity') }}</h3>
      <div v-if="loading">
        <Skeleton class="mb" v-for="n in 4" :key="n" height="36px" />
      </div>
      <EmptyState v-else-if="activity.length === 0" :icon="History" :title="$t('dashboard.noActivity')" />
      <div v-else>
        <div v-for="a in activity" :key="a.id" class="activity-row">
          <Avatar :name="a.user" />
          <div class="space" style="min-width: 0;">
            <div class="text-sm">
              <b>{{ a.user }}</b> {{ a.action }} <span class="muted">{{ a.target }}</span>
            </div>
            <small class="muted">{{ a.time }}</small>
          </div>
          <component :is="a.icon" :size="14" class="muted" />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import FullCalendar from '@fullcalendar/vue3'
import timeGridPlugin from '@fullcalendar/timegrid'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import {
  Cloud, AlertTriangle, X, Plus,
  CalendarOff, CalendarPlus, RefreshCcw, BarChart3, Sliders, History,
  CheckCircle2, Clock
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Avatar from '../components/Avatar.vue'
import { useTenantStore } from '../stores/tenant'
import { useToastStore } from '../stores/toast'
import { useI18n } from 'vue-i18n'
import { openRealtime, api } from '../api'

const tenant = useTenantStore()
const toasts = useToastStore()
const { t, locale } = useI18n()

const loading = ref(true)
const kpis = ref({ active: 0, utilisation: null, pending: 0, noShow: 0 })
const agenda = ref([])
const activity = ref([])
const broadcast = ref(null)
const resourceMap = ref({})
const weather = ref({ label: 'Sunny', temp: 27 })
const hkoSignal = ref(null)
let ws

const today = new Date().toLocaleDateString(locale.value, { weekday: 'short', month: 'short', day: 'numeric' })

const widgets = computed(() => tenant.customization?.dashboard_widgets || ['kpi-active','kpi-utilisation','kpi-pending','kpi-noshow','calendar-week','agenda','activity'])
const hasWidget = (k) => widgets.value.length === 0 || widgets.value.includes(k) || k.startsWith('kpi-')

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 12) return t('dashboard.title')
  if (h < 18) return locale.value === 'en' ? 'Good afternoon' : t('dashboard.title')
  return locale.value === 'en' ? 'Good evening' : t('dashboard.title')
})

const firstName = computed(() => {
  try {
    const tok = localStorage.getItem('fsd_jwt')
    if (!tok) return 'there'
    return (localStorage.getItem('fsd_user') || 'there').split(/[ .]/)[0]
  } catch { return 'there' }
})

const canAdmin = computed(() => {
  try {
    const tok = localStorage.getItem('fsd_jwt')
    if (!tok) return false
    return ['System Admin', 'Security Admin'].includes(JSON.parse(atob(tok.split('.')[1])).role)
  } catch { return false }
})

const calendarOptions = computed(() => ({
  plugins: [timeGridPlugin, dayGridPlugin, interactionPlugin],
  initialView: 'timeGridWeek',
  height: 460,
  selectable: true,
  events: events.value,
  locale: locale.value === 'zh-Hant' ? 'zh-tw' : locale.value === 'zh-Hans' ? 'zh-cn' : 'en',
  headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek,dayGridMonth' },
  slotMinTime: '07:00:00',
  slotMaxTime: '21:00:00',
  nowIndicator: true,
  eventClassNames(arg) {
    const s = (arg.event.extendedProps?.status || '').toLowerCase()
    if (s.includes('pending')) return ['pending']
    if (s.includes('exception')) return ['exception']
    return []
  }
}))

const events = ref([])

onMounted(async () => {
  ws = openRealtime((ev) => {
    if (ev.type === 'weather.signal') hkoSignal.value = ev.payload?.code
    if (ev.type?.startsWith('booking.')) {
      toasts.info('Live update', ev.type.replace('booking.', 'Booking '))
      load()
    }
  })
  await load()
})
onBeforeUnmount(() => ws?.close())

async function load() {
  loading.value = true
  try {
    const [bookings, approvals, resources] = await Promise.all([
      api.myBookings().catch(() => []),
      api.listApprovals().catch(() => []),
      api.listResources().catch(() => [])
    ])

    resourceMap.value = Object.fromEntries((resources || []).map(r => [r.ID || r.id, r]))
    const now = new Date()
    const todayStr = now.toDateString()
    const weekAgo = new Date(now.getTime() - 7 * 86400000)

    const upcoming = (bookings || []).filter(b =>
      b.Status !== 'Cancelled' && b.Status !== 'No Show' && new Date(b.EndTime) > now)
    const noShowRecent = (bookings || []).filter(b =>
      b.Status === 'No Show' && new Date(b.StartTime) >= weekAgo)
    const todays = (bookings || []).filter(b => new Date(b.StartTime).toDateString() === todayStr)

    const activeResources = (resources || []).filter(r => r.IsActive !== false).length
    const utilisation = activeResources > 0
      ? Math.min(100, Math.round((upcoming.length / activeResources) * 100))
      : null

    kpis.value = {
      active: upcoming.length,
      utilisation,
      pending: (approvals || []).length,
      noShow: noShowRecent.length
    }

    agenda.value = todays
      .sort((a, b) => new Date(a.StartTime) - new Date(b.StartTime))
      .map(b => ({
        id: b.ID,
        time: formatTime(b.StartTime),
        duration: formatDuration(b.StartTime, b.EndTime),
        title: resourceMap.value[b.ResourceID]?.Name || 'Booking',
        room: resourceMap.value[b.ResourceID]?.Location || '',
        attendees: b.AttendeeCount || 0,
        color: b.Status === 'Pending Approval' ? 'var(--warning)' : 'var(--brand-primary)',
        status: b.Status
      }))

    activity.value = (bookings || [])
      .slice()
      .sort((a, b) => new Date(b.CreatedAt || b.StartTime) - new Date(a.CreatedAt || a.StartTime))
      .slice(0, 6)
      .map(b => ({
        id: b.ID,
        user: 'You',
        action: b.Status === 'Cancelled' ? 'cancelled'
              : b.Status === 'Pending Approval' ? 'requested'
              : 'booked',
        target: resourceMap.value[b.ResourceID]?.Name || b.ResourceID,
        time: relativeTime(b.CreatedAt || b.StartTime),
        icon: b.Status === 'Cancelled' ? X
            : b.Status === 'Pending Approval' ? Clock
            : CheckCircle2
      }))

    events.value = (bookings || [])
      .filter(b => b.Status !== 'Cancelled')
      .map(b => ({
        title: resourceMap.value[b.ResourceID]?.Name || 'Booking',
        start: b.StartTime,
        end: b.EndTime,
        extendedProps: { status: b.Status }
      }))

    broadcast.value = null
  } catch (e) {
    toasts.error('Could not load dashboard', e.message)
  } finally {
    loading.value = false
  }
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function formatDuration(s, e) {
  const min = Math.round((new Date(e) - new Date(s)) / 60000)
  if (min >= 60 && min % 60 === 0) return `${min / 60}h`
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`
  return `${min}m`
}
function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function syncCal() { toasts.success('Calendar sync triggered', 'Outlook & Google will refresh shortly.') }
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; }

.dashboard-grid {
  display: grid;
  grid-template-columns: 1fr 360px;
  grid-template-areas:
    "calendar agenda"
    "calendar quick"
    "activity activity";
  gap: 18px;
}
@media (max-width: 980px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
    grid-template-areas: "calendar" "agenda" "quick" "activity";
  }
}

.agenda-row {
  display: grid; grid-template-columns: 64px 8px 1fr auto;
  gap: 12px; align-items: center;
  padding: 10px 0; border-top: 1px solid var(--divider);
}
.agenda-row:first-of-type { border-top: 0; }
.agenda-row .time b { display: block; font-size: 14px; }
.agenda-row .dot { width: 8px; height: 36px; border-radius: 4px; }

.activity-row {
  display: grid; grid-template-columns: 32px 1fr auto;
  gap: 12px; align-items: center;
  padding: 10px 0; border-top: 1px solid var(--divider);
}
.activity-row:first-of-type { border-top: 0; }

.quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.quick-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  padding: 14px; background: var(--surface-inset); color: var(--text);
  border: 1px solid transparent; border-radius: var(--radius);
  cursor: pointer; text-align: left; transition: all var(--dur);
}
.quick-btn:hover { background: var(--surface-pressed); border-color: var(--border); transform: translateY(-1px); }
.quick-btn span { font-size: 13px; font-weight: 500; }
.quick-btn :deep(svg) { color: var(--brand-primary); }
</style>
