<template>
  <div>
    <div class="row mb" style="justify-content: space-between; align-items: center;">
      <div>
        <h1 class="fsd-page-title" style="margin-bottom:4px;">
          {{ scopeTitle }}
        </h1>
        <p class="muted text-sm" style="margin:0;">{{ scopeSubtitle }}</p>
      </div>
      <div class="row gap-sm" style="align-items:center;">
        <div v-if="weather" class="wx-chip" :title="'HK Observatory · updated ' + wxUpdated">
          <CloudSun :size="15" />
          <b>{{ weather.temp_c }}°C</b>
          <span v-for="s in (weather.signals || [])" :key="s.Code || s.code"
                class="wx-sig" :class="{ hot: (s.Severity || s.severity) >= 8 }">
            {{ s.Code || s.code }}
          </span>
        </div>
        <select v-model="range" class="range-sel" @change="load">
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="quarter">This Quarter</option>
        </select>
      </div>
    </div>

    <div v-if="broadcast" class="fsd-alert danger" role="alert"
         style="display:flex; align-items:center; gap:12px;">
      <AlertTriangle :size="16" />
      <div class="space"><b>{{ broadcast.title }}</b> · <span>{{ broadcast.body }}</span></div>
      <button class="icon-btn" @click="broadcast = null" aria-label="dismiss"><X :size="14" /></button>
    </div>

    <!-- Room Utilization bar chart -->
    <div v-if="hasWidget('room-utilisation')" class="fsd-card" ref="chartHostRef">
      <div class="fsd-card-title">Room Utilization <span class="picker">{{ rangeLabel }}</span></div>
      <div v-if="loading"><Skeleton height="240px" /></div>
      <EmptyState v-else-if="util.length === 0" :icon="BarChart3" title="No bookings in this period" />
      <!-- chart-version helps operators verify a rebuild actually
           landed; check the rendered DOM for data-chart-ver="3" after
           docker compose build --no-cache mrbs_api. -->
      <svg v-else class="barchart" data-chart-ver="3"
           :viewBox="`0 0 ${chartW} 260`" preserveAspectRatio="xMinYMin meet" role="img"
           :aria-label="`Room utilisation — ${util.length} resource(s), max ${yMax} bookings`">
        <!-- yTicks is computed to avoid repeated integer labels when yMax is small.
             For yMax=1 we draw [0,1]; for yMax<=5 we draw every integer;
             above that we step in evenly-spaced chunks. -->
        <line v-for="t in yTicks" :key="'g'+t.value" :x1="0" :x2="chartW"
              :y1="200 - t.y" :y2="200 - t.y" class="grid" />
        <text v-for="t in yTicks" :key="'l'+t.value" x="0" :y="204 - t.y" class="axis">{{ t.value }}</text>
        <g v-for="(b, i) in util" :key="b.name">
          <!-- Bar — uses dynamicBarX/dynamicBarWidth so single-bar
               charts centre the bar instead of stranding it at the
               left edge. -->
          <rect :x="dynamicBarX(i)" :y="200 - barH(b.count)"
                :width="dynamicBarWidth" :height="barH(b.count)" class="bar"
                rx="3" ry="3">
            <title>{{ b.name }} — {{ b.count }} booking(s)</title>
          </rect>
          <!-- Count label INSIDE the bar (above its top edge) so the
               actual value is visible even if the Y-axis somehow scales
               wrong. Falls back to ABOVE the bar for tiny bars where
               the label wouldn't fit inside. -->
          <text
            :x="dynamicBarX(i) + dynamicBarWidth / 2"
            :y="barH(b.count) >= 24 ? (200 - barH(b.count) + 14) : (200 - barH(b.count) - 6)"
            :class="barH(b.count) >= 24 ? 'bar-value-inside' : 'bar-value-above'">
            {{ b.count }}
          </text>
          <text :x="dynamicBarX(i) + dynamicBarWidth / 2" y="218"
                class="xlab" :transform="`rotate(35 ${dynamicBarX(i) + dynamicBarWidth / 2} 218)`">{{ b.short }}</text>
        </g>
      </svg>
    </div>

    <div class="dash-2col">
      <!-- Utilization by Departments (pie) -->
      <div v-if="hasWidget('usage-by-dept')" class="fsd-card">
        <div class="fsd-card-title">Utilization by Departments <span class="picker">{{ rangeLabel }}</span></div>
        <div v-if="loading"><Skeleton height="180px" /></div>
        <EmptyState v-else-if="byDept.length === 0" :icon="PieChart" title="No department data" />
        <div v-else class="pie-wrap">
          <svg viewBox="0 0 120 120" class="pie">
            <circle v-if="byDept.length === 1" cx="60" cy="60" r="54" :fill="palette[0]" />
            <path v-for="(s, i) in pieSlices" :key="i" :d="s.d" :fill="palette[i % palette.length]" />
          </svg>
          <ul class="legend">
            <li v-for="(d, i) in byDept" :key="d.name">
              <span class="sw" :style="{ background: palette[i % palette.length] }" />
              <span class="space">{{ d.name }}</span>
              <b>{{ d.count }}</b>
            </li>
          </ul>
        </div>
      </div>

      <!-- Stat Box (replaces Core Indicators) -->
      <div v-if="hasWidget('core-indicators')" class="fsd-card">
        <div class="fsd-card-title">Stat Box <span class="picker">{{ rangeLabel }}</span></div>
        <div class="fsd-bigstats">
          <div class="item">
            <Calendar :size="22" color="#3498db" />
            <strong>{{ stats.total }}</strong>
            <span>Bookings</span>
          </div>
          <div class="item">
            <Clock :size="22" color="#3498db" />
            <strong>{{ stats.avgMin }} mins</strong>
            <span>Avg. Meeting Duration</span>
          </div>
        </div>
        <div class="fsd-segrow">
          <div class="fsd-seg green"><span class="pct">{{ stats.checkInPct }}%</span>Check-in</div>
          <div class="fsd-seg orange"><span class="pct">{{ stats.cancelPct }}%</span>Cancelled</div>
          <div class="fsd-seg red"><span class="pct">{{ stats.noShowPct }}%</span>No Show</div>
          <div class="fsd-seg blue"><span class="pct">{{ stats.walkInPct }}%</span>Walk In</div>
          <div class="fsd-seg grey"><span class="pct">{{ stats.nonOfficePct }}%</span>Non-office</div>
        </div>
      </div>
    </div>

    <!-- No Show table — server-scoped (mine / region / all) to match the
         other panels. -->
    <div v-if="hasWidget('activity-log')" class="fsd-card">
      <div class="fsd-card-title">No Show <span class="picker">{{ rangeLabel }}</span></div>
      <div v-if="loading"><Skeleton height="160px" /></div>
      <EmptyState v-else-if="noShow.length === 0" :icon="CheckCircle2" title="No no-shows in this period" />
      <table v-else class="dt">
        <thead><tr>
          <th>Name <span class="caret">▲▼</span></th>
          <th>Department <span class="caret">▲▼</span></th>
          <th>Room <span class="caret">▲▼</span></th>
          <th>Date/Time <span class="caret">▲▼</span></th>
        </tr></thead>
        <tbody>
          <tr v-for="(a, i) in noShow" :key="i">
            <td>{{ a.name }}</td>
            <td>{{ a.dept }}</td>
            <td>{{ a.room }}</td>
            <td>{{ a.when }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { AlertTriangle, X, BarChart3, PieChart, CheckCircle2, CloudSun, Calendar, Clock } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import { useToastStore } from '../stores/toast'
import { useTenantStore } from '../stores/tenant'
import { openRealtime, api } from '../api'

const toasts = useToastStore()
const tenant = useTenantStore()

// Admin-curated dashboard layout. Empty/absent list = show everything;
// otherwise the panel only renders if its key is in dashboard_widgets.
const widgets = computed(() => tenant.customization?.dashboard_widgets || [])
const hasWidget = (k) => !widgets.value.length || widgets.value.includes(k)

const loading = ref(true)
const range = ref('week')
const weather = ref(null)
const wxUpdated = computed(() =>
  weather.value?.updated_at ? new Date(weather.value.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
const util = ref([])
const byDept = ref([])
const activity = ref([])
const noShow = ref([])
const stats = ref({ total: 0, avgMin: 0, checkInPct: 0, cancelPct: 0, noShowPct: 0, walkInPct: 0, nonOfficePct: 0 })
const broadcast = ref(null)
// Scope is set by the server based on the caller's role — the SPA cannot
// widen it by sending a different query. "mine" = own bookings only,
// "region" = rooms the user manages, "all" = full tenant view.
const scope = ref('all')
const scopeTitle = computed(() => ({
  mine:   'My Dashboard',
  region: 'Regional Dashboard',
  all:    'Dashboard'
}[scope.value] || 'Dashboard'))
const scopeSubtitle = computed(() => ({
  mine:   'Your own bookings only.',
  region: 'Bookings in the regions you manage.',
  all:    'Operational summary across every room.'
}[scope.value] || ''))
let ws

const palette = ['#059669', '#2563eb', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#65a30d', '#db2777']
const today = new Date().toISOString().slice(0, 10)
const rangeLabel = computed(() => ({ week: 'This Week', month: 'This Month', quarter: 'This Quarter' }[range.value]))

const barStep = 56
// chartW used to be a fixed Math.max(640, …) — with preserveAspectRatio
// "meet", anything wider than 640 was rendered top-left-aligned, leaving
// blank space on the right. Track the chart container's real pixel width
// instead so the bars spread across whatever the layout gives us.
const containerW = ref(640)
const chartW = computed(() => Math.max(containerW.value, 40 + util.value.length * barStep + 20))
let chartResizeObs = null
const chartHostRef = ref(null)

// Dynamic bar layout. Two motivations:
//
//   1. A single bar at x=40 with width 42 leaves the rest of the 640px
//      canvas blank — looks like the chart broke. We give a lone bar a
//      generous width and centre it.
//   2. With 2-3 bars we widen them slightly so the chart fills more of
//      the canvas without becoming cartoonish.
//   4 bars and above keep the original 42px-wide bars.
//
// dynamicBarX returns the left edge for bar i; dynamicBarWidth returns
// its width. Both depend on util.value.length so they recompute when
// the data set changes.
const dynamicBarWidth = computed(() => {
  const n = util.value.length
  if (n <= 1) return 180
  if (n === 2) return 100
  if (n === 3) return 72
  return barStep - 14 // 42 — preserves old look for many-room charts
})
function dynamicBarX(i) {
  const n = util.value.length
  if (n <= 1) {
    // Centre a lone bar between the y-axis labels and the right edge.
    return (chartW.value - dynamicBarWidth.value) / 2
  }
  if (n <= 3) {
    // Spread 2-3 bars evenly across the canvas.
    const usable = chartW.value - 60
    const slot = usable / n
    return 40 + i * slot + (slot - dynamicBarWidth.value) / 2
  }
  return 40 + i * barStep + 6
}

// Dynamic Y-axis: previously the floor was hardcoded to 4, so a room
// with a single booking rendered as a quarter-height bar against a 0-4
// axis. That looked broken (the bar appeared idle even when it was the
// only thing happening that period). Now the axis scales to the true
// max, with a minimum of 1 so a chart with a single 1-booking room
// still draws meaningfully.
const yMax = computed(() => {
  const max = util.value.reduce((m, u) => Math.max(m, u.count || 0), 0)
  return Math.max(1, max)
})
const barH = (c) => yMax.value === 0 ? 0 : Math.round((c / yMax.value) * 180)

// Y-axis ticks. For small counts (1–5) we show every integer so the
// scale feels honest. Above 5 we step in roughly evenly-spaced chunks
// (5 ticks total) to keep the axis readable on a 180px tall chart.
const yTicks = computed(() => {
  const m = yMax.value
  const ticks = []
  if (m <= 5) {
    for (let v = 0; v <= m; v++) {
      ticks.push({ value: v, y: Math.round((v / m) * 180) })
    }
  } else {
    for (let i = 0; i <= 4; i++) {
      const v = Math.round((i / 4) * m)
      ticks.push({ value: v, y: Math.round((v / m) * 180) })
    }
  }
  return ticks
})

const noShows = computed(() => activity.value.filter(a => a.label === 'No Show' || a.label === 'Missed'))

const pieSlices = computed(() => {
  const total = byDept.value.reduce((s, d) => s + d.count, 0)
  if (total === 0 || byDept.value.length <= 1) return []
  let a0 = -Math.PI / 2
  return byDept.value.map(d => {
    const a1 = a0 + (d.count / total) * Math.PI * 2
    const x0 = 60 + 54 * Math.cos(a0), y0 = 60 + 54 * Math.sin(a0)
    const x1 = 60 + 54 * Math.cos(a1), y1 = 60 + 54 * Math.sin(a1)
    const large = a1 - a0 > Math.PI ? 1 : 0
    const d2 = `M60,60 L${x0.toFixed(2)},${y0.toFixed(2)} A54,54 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`
    a0 = a1
    return { d: d2 }
  })
})

onMounted(async () => {
  ws = openRealtime((ev) => { if (ev.type?.startsWith('booking.')) load() })
  api.getWeather().then(w => { weather.value = w }).catch(() => {})
  // Observe the chart card width so chartW tracks the live layout.
  // Subtract horizontal padding (.fsd-card uses 18px 20px) so the SVG
  // viewBox covers only the inner content area — otherwise text labels
  // get cropped at the right edge on tight viewports.
  if (chartHostRef.value && typeof ResizeObserver !== 'undefined') {
    const updateW = () => {
      const cs = getComputedStyle(chartHostRef.value)
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      containerW.value = Math.max(320, chartHostRef.value.clientWidth - padX)
    }
    updateW()
    chartResizeObs = new ResizeObserver(updateW)
    chartResizeObs.observe(chartHostRef.value)
  }
  await load()
})
onBeforeUnmount(() => {
  ws?.close()
  chartResizeObs?.disconnect()
})

// rangePeriod returns the inclusive [start, end] calendar boundary for
// the active "This Week / Month / Quarter" filter. Previously this was
// a "past 7 days ending today" sliding window — a booking made for
// *tomorrow* fell outside the range and showed up as zero on the
// dashboard. Calendar-aligned boundaries match user intent ("show me
// this week's activity, including the booking I just made for Friday")
// and stay in lockstep with the backend `b.start_time::date >= start
// AND <= end` aggregate.
function pad2(n) { return String(n).padStart(2, '0') }
function iso(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}` }
function rangePeriod() {
  const now = new Date()
  if (range.value === 'week') {
    // Calendar week, Sun→Sat. getDay() returns 0=Sun..6=Sat.
    const s = new Date(now); s.setDate(now.getDate() - now.getDay())
    const e = new Date(s);   e.setDate(s.getDate() + 6)
    return { start: iso(s), end: iso(e) }
  }
  if (range.value === 'month') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1)
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    return { start: iso(s), end: iso(e) }
  }
  // Quarter — month-3 .. month+2 ranges to the calendar quarter
  // containing today (Q1=Jan-Mar, Q2=Apr-Jun, …).
  const q = Math.floor(now.getMonth() / 3)
  const s = new Date(now.getFullYear(), q * 3, 1)
  const e = new Date(now.getFullYear(), q * 3 + 3, 0)
  return { start: iso(s), end: iso(e) }
}

async function load() {
  loading.value = true
  try {
    const { start, end } = rangePeriod()
    const [d, todays, resources, users] = await Promise.all([
      api.getDashboard(start, end),
      api.listAllBookings(today).catch(() => api.myBookings().catch(() => [])),
      api.listResources().catch(() => []),
      api.listUsers().catch(() => [])
    ])

    scope.value = d.scope || 'all'
    util.value = (d.roomUtilisation || []).map(x => ({
      name: x.name, short: x.name && x.name.length > 10 ? x.name.slice(0, 9) + '…' : x.name, count: x.count
    }))
    byDept.value = d.byDepartment || []
    noShow.value = d.noShow || []
    stats.value = {
      total: d.stats?.total || 0, avgMin: d.stats?.avgMin || 0,
      checkInPct: d.stats?.checkInPct || 0, cancelPct: d.stats?.cancelPct || 0,
      noShowPct: d.stats?.noShowPct || 0, walkInPct: d.stats?.walkInPct || 0,
      nonOfficePct: d.stats?.nonOfficePct || 0
    }

    const resMap = Object.fromEntries((resources || []).map(r => [r.ID || r.id, r]))
    const userMap = Object.fromEntries((users || []).map(u => [u.ID || u.id, u]))
    const now = Date.now()
    activity.value = (todays || [])
      .filter(b => b.Status !== 'Cancelled')
      .sort((a, b) => new Date(a.StartTime) - new Date(b.StartTime))
      .slice(0, 15)
      .map(b => {
        const start = new Date(b.StartTime).getTime()
        const end = new Date(b.EndTime).getTime()
        const r = resMap[b.ResourceID]
        const u = userMap[b.UserID]
        let pill = 'navy', label = 'Upcoming', canCheckIn = false
        if (b.Status === 'Checked In') { pill = 'ok'; label = 'Checked In' }
        else if (b.Status === 'No Show') { pill = 'bad'; label = 'No Show' }
        else if (now >= start && now <= end) { pill = 'amber'; label = 'Awaiting Check-in'; canCheckIn = true }
        else if (now > end) { pill = 'bad'; label = 'Missed'; canCheckIn = true }
        return {
          id: b.ID,
          user: u?.Username || u?.username || b.UserID,
          dept: r?.Region || r?.region || r?.Department || '—',
          room: r?.Name || r?.name || b.ResourceID,
          time: fmtRange(b.StartTime, b.EndTime),
          pill, label, canCheckIn, busy: false
        }
      })

    broadcast.value = null
  } catch (e) {
    toasts.error('Could not load dashboard', e.message)
  } finally {
    loading.value = false
  }
}

async function checkIn(a) {
  a.busy = true
  try {
    await api.checkInBooking(a.id)
    a.pill = 'ok'; a.label = 'Checked In'; a.canCheckIn = false
    toasts.success('Checked in', a.room)
  } catch (e) {
    toasts.error('Check-in failed', e.message)
  } finally { a.busy = false }
}

function fmtRange(s, e) {
  const o = { hour: '2-digit', minute: '2-digit', hour12: false }
  return new Date(s).toLocaleTimeString([], o) + ' – ' + new Date(e).toLocaleTimeString([], o)
}
</script>

<style scoped>
.range-sel { padding: 6px 10px; border: 1px solid var(--asl-line); border-radius: 3px; font: inherit; font-size: 13px; background: #fff; }
.wx-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--asl-line); border-radius: 999px; font-size: 13px; color: var(--asl-grey); background: #fff; }
.wx-chip b { color: #33414e; }
.wx-sig { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: var(--asl-amber-bg, #fef3c7); color: var(--asl-amber, #d97706); }
.wx-sig.hot { background: var(--asl-bad-bg, #fee2e2); color: var(--asl-bad, #dc2626); }
.rng { font-weight: 400; font-size: 12px; color: var(--asl-grey); }
.dash-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 920px) { .dash-2col { grid-template-columns: 1fr; } }
.barchart { width: 100%; height: 260px; }
.barchart .grid { stroke: #e6eaee; stroke-width: 1; }
.barchart .axis { fill: var(--asl-grey); font-size: 10px; }
.barchart .bar { fill: var(--asl-blue); transition: fill .15s ease; }
.barchart .bar:hover { fill: var(--asl-blue-dark); }
.barchart .xlab { fill: var(--asl-grey); font-size: 9px; text-anchor: middle; }
/* Bar value labels. .bar-value-inside renders WHITE on the bar for
   tall enough bars (>=24 SVG units). .bar-value-above renders BLUE
   floating above the bar when the bar is too short to host text. Both
   ensure the actual count is always legible — even if the Y-axis is
   somehow miscalibrated. */
.barchart .bar-value-inside {
  fill: #ffffff; font-size: 11px; font-weight: 600;
  text-anchor: middle; pointer-events: none;
}
.barchart .bar-value-above {
  fill: var(--asl-blue-dark, #0b3060); font-size: 11px; font-weight: 600;
  text-anchor: middle; pointer-events: none;
}
.pie-wrap { display: flex; gap: 18px; align-items: center; }
.pie { width: 140px; height: 140px; flex: 0 0 auto; }
.legend { list-style: none; margin: 0; padding: 0; flex: 1; font-size: 13px; }
.legend li { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--asl-line); }
.legend li:last-child { border-bottom: 0; }
.legend .sw { width: 12px; height: 12px; border-radius: 2px; flex: 0 0 auto; }
</style>
