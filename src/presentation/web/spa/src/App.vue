<template>
  <ToastHost />

  <div v-if="$route.name === 'kiosk'">
    <router-view />
  </div>

  <div v-else class="app-shell">
    <!-- Mobile drawer backdrop: clicking it closes the sidebar. -->
    <div v-if="sidebarOpen" class="drawer-backdrop" @click="sidebarOpen = false" aria-hidden="true" />

    <Sidebar :open="sidebarOpen" @navigate="sidebarOpen = false" />

    <div class="app-main-col fsd-main">
      <TopBar @toggle-sidebar="sidebarOpen = !sidebarOpen" />

      <!-- Broadcast banner (R13): urgent dept-wide announcements, e.g. a
           Typhoon No.8 facility-closure alert. Polled for every user.
           Single bar, news-ticker style: all active broadcasts queued
           one after another and scrolled right-to-left continuously.
           Dismiss button removes whichever broadcast is currently the
           first in the queue. -->
      <div v-if="liveBroadcasts.length"
           class="bc-banner" role="alert"
           :style="{ background: bannerColor(highestSeverity) }">
        <Megaphone :size="16" class="bc-ico" />
        <div class="bc-marquee" ref="marqueeRef">
          <!-- Two copies of the joined message stream so the animation
               can loop seamlessly (translateX 0 → -50%). Each broadcast
               is separated by a thick dot so the boundary is obvious.
               --marquee-w sets a per-stream minimum width equal to the
               viewport so the scroll actually crosses the whole bar even
               when the raw text is short. -->
          <div class="bc-track" :style="{
                 animationDuration: tickerDuration + 's',
                 '--marquee-w': marqueeWidth + 'px'
               }">
            <span class="bc-stream">
              <template v-for="(b, i) in liveBroadcasts" :key="b.id">
                <span v-if="i > 0" class="bc-sep">●</span>
                <b>{{ b.title }}</b><span> — {{ b.content }}</span>
              </template>
            </span>
            <span class="bc-stream" aria-hidden="true">
              <template v-for="(b, i) in liveBroadcasts" :key="'d'+b.id">
                <span v-if="i > 0" class="bc-sep">●</span>
                <b>{{ b.title }}</b><span> — {{ b.content }}</span>
              </template>
            </span>
          </div>
        </div>
        <button class="bc-x" @click="dismiss(liveBroadcasts[0].id)" aria-label="dismiss"><X :size="14" /></button>
      </div>

      <main class="main">
        <!-- Admin sub-navigation: auto-injected on every /admin/* route so
             the 13 admin sub-pages (Rooms, Users, Departments, …) stay
             reachable now that the new icon-stack sidebar exposes only a
             single "Settings" entry. -->
        <AdminSubnav v-if="$route.path.startsWith('/admin')" />
        <!-- Plain router-view: the transition wrapper was blocking
             component swaps on first navigation in some browsers. -->
        <router-view :key="$route.fullPath" />
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Megaphone, X } from 'lucide-vue-next'
import Sidebar from './components/Sidebar.vue'
import TopBar from './components/TopBar.vue'
import ToastHost from './components/ToastHost.vue'
import AdminSubnav from './components/AdminSubnav.vue'
import { useThemeStore } from './stores/theme'
import { api, getToken } from './api'

const route = useRoute()
const sidebarOpen = ref(false)
const theme = useThemeStore()

// --- Broadcast banner polling (every authenticated user) ---
const broadcasts = ref([])
const dismissed = ref(new Set())
let bcTimer = null
const liveBroadcasts = computed(() =>
  broadcasts.value.filter(b => !dismissed.value.has(b.id)))
// Banner colour follows the highest-severity active broadcast: if any
// urgent is live, the bar is red; otherwise warning paints amber;
// otherwise the default slate. Picks a single colour for the single bar.
const severityRank = { urgent: 3, warning: 2, info: 1 }
const highestSeverity = computed(() => {
  let best = null, rank = 0
  for (const b of liveBroadcasts.value) {
    const r = severityRank[b.severity] || 0
    if (r > rank) { rank = r; best = b }
  }
  return best || liveBroadcasts.value[0] || null
})
// Ticker duration scales with the total content length so two short
// alerts don't tear past too fast while a long compliance notice can
// finish reading. Clamped so very short / very long never feels broken.
const tickerDuration = computed(() => {
  const totalChars = liveBroadcasts.value.reduce(
    (n, b) => n + (b.title?.length || 0) + (b.content?.length || 0) + 6, 0)
  return Math.min(120, Math.max(20, Math.round(totalChars / 4)))
})
// marqueeWidth tracks the visible width of the .bc-marquee container so
// the CSS can force each .bc-stream to be at least that wide — otherwise
// short messages leave the right half of the bar empty mid-scroll.
const marqueeRef = ref(null)
const marqueeWidth = ref(1024)
let marqueeObs = null
function dismiss(id) {
  dismissed.value = new Set([...dismissed.value, id])
}
// Admin-chosen colour wins; otherwise map severity to a sensible default.
function bannerColor(b) {
  const c = b.color || b.filters?.color
  if (c) return c
  return b.severity === 'urgent' ? '#dc2626'
       : b.severity === 'warning' ? '#d97706'
       : '#1e2a44'
}
async function loadBroadcasts() {
  if (!getToken() || route.name === 'kiosk') return
  try { broadcasts.value = await api.activeBroadcasts() } catch { /* non-fatal */ }
}

onMounted(() => {
  theme.apply()
  loadBroadcasts()
  bcTimer = setInterval(loadBroadcasts, 60000)
})
onBeforeUnmount(() => {
  if (bcTimer) clearInterval(bcTimer)
  marqueeObs?.disconnect()
})

// Re-observe whenever the banner appears/disappears (the .bc-marquee
// ref is only mounted when liveBroadcasts has entries).
watch(marqueeRef, (el) => {
  marqueeObs?.disconnect()
  if (!el) return
  const sync = () => { marqueeWidth.value = el.clientWidth || 1024 }
  sync()
  marqueeObs = new ResizeObserver(sync)
  marqueeObs.observe(el)
})

// Auto-close the mobile drawer on every route change so the drawer
// doesn't linger after navigating from a sidebar link.
watch(() => route.fullPath, () => { sidebarOpen.value = false })
</script>

<style scoped>
.bc-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 0 14px; font-size: 13px; color: #fff;
  background: #475569; overflow: hidden;
  /* Pin to a fixed height. Without this the banner picks up
     sub-pixel differences from icon baseline alignment, marquee
     re-measure, or per-page line-height inheritance — making the
     bar visibly taller/shorter when navigating between routes. */
  flex: 0 0 40px;
  height: 40px;
  line-height: 1.4;
  box-sizing: border-box;
}
.bc-banner > * { line-height: 1.4; }
.bc-ico { flex: 0 0 auto; }
.bc-banner b { font-weight: 700; }
/* News-ticker: continuous right-to-left scroll. Two copies of the same
   stream sit side-by-side; translating the track by -50% sweeps the
   first copy off the left while the second slides in seamlessly. Hover
   pauses so users can finish reading. */
.bc-marquee { flex: 1; overflow: hidden; }
.bc-track {
  display: inline-flex; white-space: nowrap;
  will-change: transform;
  animation: bc-scroll 40s linear infinite;
}
.bc-banner:hover .bc-track { animation-play-state: paused; }
/* Each stream is forced to occupy at least one full marquee width
   (set in JS as --marquee-w). With two streams in the track, the total
   track width is >= 2× viewport, so the -50% scroll always sweeps a
   full bar's worth — short messages no longer leave dead space. */
.bc-stream {
  display: inline-flex; align-items: center; gap: 8px;
  min-width: var(--marquee-w, 100%);
  padding-right: 4rem;
  /* Centre the visible message inside the padded stream so it doesn't
     hug the left edge when content is shorter than the viewport. */
  justify-content: flex-start;
}
.bc-sep { opacity: .65; font-size: 10px; padding: 0 8px; }
@keyframes bc-scroll {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
@media (prefers-reduced-motion: reduce) {
  .bc-track { animation: none; }
  .bc-stream:nth-child(2) { display: none; }
}
.bc-x { flex: 0 0 auto; background: rgba(255,255,255,.2); border: 0; color: #fff; border-radius: 4px; cursor: pointer; padding: 4px 6px; display: grid; place-items: center; }
.bc-x:hover { background: rgba(255,255,255,.35); }

.drawer-backdrop {
  display: none;
}
@media (max-width: 880px) {
  .drawer-backdrop {
    display: block;
    position: fixed; inset: 0;
    background: rgba(15, 23, 42, 0.55);
    backdrop-filter: blur(2px);
    z-index: 99;
    animation: fade-in 200ms var(--ease, ease);
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
}
</style>
