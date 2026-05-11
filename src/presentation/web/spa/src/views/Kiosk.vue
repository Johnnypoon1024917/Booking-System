<template>
  <div class="kiosk" :class="{ busy: state === 'in-use', empty: state === 'free' && !next }">
    <header class="k-header">
      <div class="row gap">
        <div class="k-logo" :style="{ background: brand.brand_primary || '#0a1f44' }">
          <Flame :size="22" color="white" />
        </div>
        <div>
          <b style="font-size: 18px;">{{ brand.brand_name || 'Resource Booking' }}</b>
          <div class="muted-on-dark text-sm">{{ resourceName }}</div>
        </div>
      </div>
      <div class="row gap">
        <span class="k-pill" v-if="hkoSignal">⚠ {{ hkoSignal }}</span>
        <span class="k-pill"><Cloud :size="14" /> 27° HK</span>
      </div>
    </header>

    <div class="k-state">
      <div class="dot" :style="{ background: state === 'in-use' ? '#fee2e2' : '#dcfce7' }" />
      <span>{{ state === 'in-use' ? $t('kiosk.inUse') : $t('kiosk.available') }}</span>
    </div>

    <div class="k-now" v-if="current">
      <h1>{{ current.summary }}</h1>
      <div class="text-lg muted-on-dark">{{ $t('kiosk.endsAt') }} {{ formatTime(current.end) }}</div>
    </div>
    <div class="k-now" v-else-if="next">
      <h1 style="opacity: 0.85;">{{ $t('kiosk.available') }}</h1>
      <div class="text-lg muted-on-dark">
        {{ $t('kiosk.nextAt') }} · {{ formatTime(next.start) }} — {{ next.summary }}
      </div>
    </div>
    <div class="k-now" v-else>
      <h1 style="opacity: 0.85;">{{ $t('kiosk.available') }}</h1>
      <div class="text-lg muted-on-dark">{{ $t('kiosk.noBookings') }}</div>
    </div>

    <div class="k-agenda" v-if="upcoming.length">
      <small class="muted-on-dark">Today</small>
      <div v-for="e in upcoming" :key="e.start" class="k-agenda-row">
        <b style="width: 64px;">{{ formatTime(e.start) }}</b>
        <span class="space">{{ e.summary }}</span>
        <small class="muted-on-dark">{{ duration(e) }}</small>
      </div>
    </div>

    <footer class="k-footer">
      <div class="k-time">{{ now }}</div>
      <div class="k-hint">
        <QrCode :size="14" /> {{ $t('kiosk.scanToCheckIn') }}
      </div>
    </footer>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Flame, Cloud, QrCode } from 'lucide-vue-next'
import { useTenantStore } from '../stores/tenant'

const route = useRoute()
const tenant = useTenantStore()
const brand = computed(() => tenant.customization || {})
const resourceId = route.params.resourceId
const resourceName = ref(decodeURIComponent(resourceId))
const events = ref([])
const now = ref(formatNow())
const hkoSignal = ref(null)
let clock, poll

const current = computed(() => events.value.find(e => withinNow(e)))
const next = computed(() => events.value.find(e => new Date(e.start) > new Date()))
const upcoming = computed(() => events.value.filter(e => new Date(e.end) >= new Date()).slice(0, 4))
const state = computed(() => current.value ? 'in-use' : 'free')

onMounted(async () => {
  if (!tenant.customization) await tenant.load()
  clock = setInterval(() => now.value = formatNow(), 1000)
  poll = setInterval(refresh, 30000)
  await refresh()
})
onBeforeUnmount(() => { clearInterval(clock); clearInterval(poll) })

async function refresh() {
  // Endpoint to be added: GET /api/v1/kiosk/{resourceId}/agenda
  // For demo purposes we render plausible data so the kiosk looks alive.
  events.value = [
    { start: t(9), end: t(10), summary: 'Morning Briefing' },
    { start: t(11.5), end: t(12), summary: 'Equipment Check' },
    { start: t(14), end: t(16), summary: 'Recruit Training' }
  ]
}

function t(h) { const d = new Date(); d.setHours(Math.floor(h), (h % 1) * 60, 0, 0); return d.toISOString() }
function withinNow(e) { const n = new Date(); return new Date(e.start) <= n && n < new Date(e.end) }
function formatTime(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function formatNow()    { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function duration(e)    { const m = Math.round((new Date(e.end) - new Date(e.start)) / 60000); return m >= 60 ? `${(m/60).toFixed(0)}h` : `${m}m` }
</script>

<style scoped>
.kiosk {
  height: 100vh; padding: 56px 64px 48px;
  display: grid;
  grid-template-rows: auto auto 1fr auto auto;
  gap: 28px;
  color: white;
  background: linear-gradient(135deg, #0c4a3e 0%, #064e3b 60%, #052e26 100%);
  position: relative;
  overflow: hidden;
}
.kiosk::before {
  content: ''; position: absolute; right: -200px; top: -200px;
  width: 600px; height: 600px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,0.06), transparent 70%);
}
.kiosk.busy { background: linear-gradient(135deg, #7f1d1d, #4c1414 100%); }
.kiosk.empty { background: linear-gradient(135deg, #0f172a 0%, #020617 100%); }

.k-header { display: flex; justify-content: space-between; align-items: center; }
.k-logo { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; box-shadow: var(--shadow-lg); }
.k-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-radius: 999px;
  background: rgba(255,255,255,0.12); font-size: 13px;
  border: 1px solid rgba(255,255,255,0.16); backdrop-filter: blur(10px);
}

.k-state {
  display: inline-flex; align-items: center; gap: 12px;
  padding: 8px 20px; align-self: flex-start;
  background: rgba(255,255,255,0.1); border-radius: 999px;
  font-size: 18px; font-weight: 500; backdrop-filter: blur(10px);
}
.k-state .dot { width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 24px rgba(255,255,255,0.5); }

.k-now { align-self: center; }
.k-now h1 { font-size: clamp(56px, 8vw, 112px); margin: 0 0 18px; line-height: 0.95; letter-spacing: -0.04em; font-weight: 700; }
.muted-on-dark { color: rgba(255, 255, 255, 0.65); }

.k-agenda {
  background: rgba(255,255,255,0.05); border-radius: var(--radius-lg);
  padding: 16px 20px; backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.08);
  align-self: end;
}
.k-agenda small { display: block; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.1em; font-size: 11px; }
.k-agenda-row {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.08);
}
.k-agenda-row:first-of-type { border-top: 0; }

.k-footer { display: flex; justify-content: space-between; align-items: flex-end; }
.k-time { font-size: clamp(56px, 7vw, 96px); font-weight: 200; letter-spacing: -3px; line-height: 1; }
.k-hint {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 18px; background: rgba(255,255,255,0.1);
  border-radius: 999px; backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.16);
  font-size: 14px;
}
</style>
