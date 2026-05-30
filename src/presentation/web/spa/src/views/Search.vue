<template>
  <div class="mrbs">
    <h1 class="fsd-page-title">New Booking</h1>

    <div class="search-shell">
      <!-- Filters -->
      <div class="panel" style="align-self: start;">
        <div class="ph"><span>Search Room</span></div>
        <form class="pb" @submit.prevent="search">
          <label class="fld">
            <span>Location</span>
            <select v-model="form.region">
              <option v-for="loc in locations" :key="loc" :value="loc">{{ loc }}</option>
            </select>
          </label>

          <label class="fld">
            <span>Date</span>
            <input type="date" v-model="form.date" />
          </label>

          <label class="cbx mb"><input type="checkbox" v-model="form.allDay" /> All Day Event</label>

          <div v-if="!form.allDay" class="grid-2">
            <label class="fld">
              <span>Start Time</span>
              <select v-model="form.start" @change="syncEnd">
                <option v-for="t in timeSlots" :key="'s'+t.value" :value="t.value" :disabled="t.past">
                  {{ t.label }}{{ t.past ? ' (past)' : '' }}
                </option>
              </select>
            </label>
            <label class="fld">
              <span>End Time</span>
              <select v-model="form.end">
                <option v-for="t in timeSlots" :key="'e'+t.value" :value="t.value"
                        :disabled="t.past || t.value <= form.start">
                  {{ t.label }}
                </option>
              </select>
            </label>
          </div>

          <label class="fld">
            <span>Capacity</span>
            <input type="number" min="1" v-model.number="form.capacity" />
          </label>

          <label class="cbx mb"><input type="checkbox" v-model="form.recur" /> Enable Repeating Schedule Pattern</label>

          <div v-if="form.recur" class="recur-box mb">
            <div class="ph2">Recurring Pattern Setup</div>
            <div class="rb">
              <div class="row gap mb" style="flex-wrap:wrap;">
                <label v-if="allowsPattern('daily')" class="rad"><input type="radio" value="daily" v-model="form.pattern" /> Daily</label>
                <label v-if="allowsPattern('weekly')" class="rad"><input type="radio" value="weekly" v-model="form.pattern" /> Weekly</label>
                <label v-if="allowsPattern('monthly')" class="rad"><input type="radio" value="monthly" v-model="form.pattern" /> Monthly</label>
                <label v-if="allowsPattern('weekday')" class="rad"><input type="radio" value="weekday" v-model="form.pattern" /> Weekdays</label>
              </div>
              <label class="fld" style="margin:0;">
                <span>End By Date (required)</span>
                <input type="date" v-model="form.endDate" :min="form.date" />
              </label>
              <p v-if="recurError" class="check-msg bad" style="margin-top:6px;">{{ recurError }}</p>
            </div>
          </div>

          <button class="mrbs-btn" style="width:100%; justify-content:center;" :disabled="busy">
            <Search :size="15" /> {{ busy ? 'Searching…' : 'Search' }}
          </button>
        </form>
      </div>

      <!-- Results -->
      <div class="panel" style="align-self: start;">
        <div class="ph">
          <span>Room Availability</span>
          <span class="rng" v-if="hasSearched">{{ form.date }} · {{ form.allDay ? 'All Day' : form.start + '–' + form.end }}</span>
        </div>
        <div class="pb">
          <div v-if="busy"><Skeleton height="220px" /></div>

          <template v-else-if="hasSearched">
            <div v-if="rows.some(x => x.st.kind === 'ok')" class="avail-note">
              <Check :size="13" /> The following rooms are available. Split spaces show their sub-rooms indented.
            </div>
            <div class="avail-list">
              <div v-for="row in rows" :key="row.id"
                   class="avail-row" :class="row.st.kind === 'ok' ? 'ok' : 'bad'"
                   :style="{ paddingLeft: (12 + row.depth * 22) + 'px' }"
                   :title="row.st.kind === 'blocked' ? ('Blocked by a booking on ' + row.st.via + ' (shared/split space)') : ''"
                   @click="row.st.kind === 'ok' && reserve(row.r)">
                <input v-if="row.st.kind === 'ok'" type="checkbox"
                       :checked="picked && (picked.ID||picked.id) === row.id" @click.stop="reserve(row.r)" />
                <Check v-if="row.st.kind === 'ok'" :size="14" class="chk" />
                <X v-else :size="14" />
                <span class="space" :style="row.st.kind !== 'ok' ? 'text-decoration: line-through;' : ''">
                  {{ row.r.Name || row.r.name }} ({{ row.r.Capacity || row.r.capacity }} pax)
                  <span v-if="isParent(row.r)" class="pill navy" style="margin-left:6px;">can be split</span>
                  <span v-else-if="isChild(row.r)" class="muted text-sm">· sub-room</span>
                </span>
                <span v-if="row.st.kind === 'ok'" class="muted text-sm">{{ row.r.Location || row.r.location }}</span>
                <span v-else-if="row.st.kind === 'blocked'" class="text-sm">Blocked via {{ row.st.via }}</span>
                <span v-else class="text-sm">Unavailable</span>
              </div>
              <div v-if="!rows.length" style="padding:20px;">
                <EmptyState :icon="SearchX" title="No rooms match" description="Adjust your location, date or time." />
              </div>
            </div>
            <div v-if="picked" class="row mt" style="justify-content: space-between; align-items:center;">
              <span v-if="recurError" class="check-msg bad">{{ recurError }}</span><span v-else></span>
              <button class="mrbs-btn" :disabled="!!recurError" @click="openModal">
                Confirm &amp; Execute Reservation — {{ picked.Name || picked.name }}
              </button>
            </div>

            <!-- Market-grade "next available time" suggestion strip.
                 Surfaces alternative windows so the user can switch slot
                 with one click if their preferred time is fully booked. -->
            <div v-if="suggestions.length || suggestBusy" class="suggest-strip">
              <div class="suggest-head">
                <Clock :size="13" />
                <b>Next available time slots</b>
                <span class="muted text-sm">· same {{ form.capacity }}+ pax, same location</span>
              </div>
              <div v-if="suggestBusy" class="muted text-sm" style="padding:6px 2px;">Looking for alternatives…</div>
              <div v-else class="suggest-chips">
                <button v-for="(s, i) in suggestions" :key="i"
                        class="chip-slot" type="button" @click="applySuggestion(s)"
                        :title="s.sample_room ? ('e.g. ' + (s.sample_room.Name || s.sample_room.name)) : ''">
                  <span class="when">
                    <template v-if="s.date !== form.date">{{ fmtDay(s.date) }} · </template>
                    {{ s.start_time }}–{{ s.end_time }}
                  </span>
                  <span class="cnt">{{ s.available_count }} room{{ s.available_count === 1 ? '' : 's' }}</span>
                </button>
              </div>
            </div>
          </template>

          <EmptyState v-else :icon="MapPinned" title="Pick a time to begin"
                      description="Set location, date and time on the left, then search for available rooms." />
        </div>
      </div>
    </div>

    <BookingModal v-if="modalRoom" :resource="modalRoom" :date="form.date" :start="form.start" :end="form.end"
                  @close="modalRoom = null" @booked="onBooked" />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Search, SearchX, MapPinned, Check, X, Clock } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import BookingModal from '../components/BookingModal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'
import { useBookingRules } from '../composables/bookingRules'
import { useTenantStore } from '../stores/tenant'

const { allowsPattern } = useBookingRules()
const tenant = useTenantStore()

const today = new Date().toISOString().slice(0, 10)
// Initial start/end follow "current time" market-product convention:
// round NOW up to the next 30-min slot for the start, then +1h for end.
// snapTimes() in onMounted re-snaps if the user changes the date.
function initialStart() {
  const d = new Date()
  d.setMinutes(d.getMinutes() + (30 - d.getMinutes() % 30) % 30, 0, 0)
  if (d.getMinutes() === 0 && d.getSeconds() === 0 && (Date.now() - d.getTime()) > -1000) {
    // Already at a slot boundary — push to the next one to avoid "now"
    // being in the past by the time the user clicks Search.
    d.setMinutes(d.getMinutes() + 30)
  }
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}
function plusOneHour(hhmm) {
  const [h,m] = hhmm.split(':').map(Number)
  const t = h*60 + m + 60
  return `${String(Math.floor(t/60)%24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`
}
const _startNow = initialStart()
const form = reactive({ region: 'Hong Kong', date: today, capacity: 4,
  start: _startNow, end: plusOneHour(_startNow),
  allDay: false, recur: false, pattern: 'daily', endDate: '' })

// Intelligent time picker: 30-min slots within the admin-configured
// working hours; slots earlier than "now" are disabled when the chosen
// date is today, and the form snaps to the nearest upcoming slot.
const STEP = 30
const timeSlots = computed(() => {
  const c = tenant.customization || {}
  const sh = Number.isInteger(c.calendar_start_hour) ? c.calendar_start_hour : 8
  const eh = Number.isInteger(c.calendar_end_hour) ? c.calendar_end_hour : 20
  const isToday = form.date === new Date().toISOString().slice(0, 10)
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const out = []
  for (let m = sh * 60; m <= eh * 60; m += STEP) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0')
    const mm = String(m % 60).padStart(2, '0')
    out.push({ value: `${hh}:${mm}`, label: `${hh}:${mm}`, past: isToday && m < nowMin })
  }
  return out
})

function nearestUpcoming() {
  const free = timeSlots.value.filter(t => !t.past)
  return free[0]?.value || timeSlots.value[0]?.value || '09:00'
}
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number)
  const t = h * 60 + m + mins
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}
function syncEnd() {
  if (form.end <= form.start) form.end = addMinutes(form.start, 60)
}

// FSD spec §3.2 — a repeating reservation must have a termination date,
// otherwise resources can be over-allocated indefinitely. Confirm stays
// disabled until the pattern is valid.
const recurError = computed(() => {
  if (!form.recur) return ''
  if (!form.endDate) return 'A repeating schedule requires an end date.'
  if (form.endDate < form.date) return 'End date must be on or after the booking date.'
  return ''
})
const allResources = ref([])
const available = ref([])
const unavailable = ref([])
const busy = ref(false)
const picked = ref(null)
const modalRoom = ref(null)
const hasSearched = ref(false)
// Top-N alternative time windows surfaced after each search.
const suggestions = ref([])
const suggestBusy = ref(false)
const toasts = useToastStore()

// --- Split-room awareness (parent/child grouping + cross-lock) ---
const resById = computed(() =>
  Object.fromEntries(allResources.value.map(r => [r.ID || r.id, r])))
const childrenOf = computed(() => {
  const m = {}
  for (const r of allResources.value) {
    const p = r.ParentResourceID || r.parent_resource_id
    if (p) (m[p] = m[p] || []).push(r.ID || r.id)
  }
  return m
})
function isParent(r) { return (r.CompositeMode || r.composite_mode) === 'parent' }
function isChild(r) { return (r.CompositeMode || r.composite_mode) === 'child' }
function relatedIds(r) {
  const id = r.ID || r.id
  const out = []
  if (isChild(r) && (r.ParentResourceID || r.parent_resource_id)) {
    out.push(r.ParentResourceID || r.parent_resource_id)
  }
  if (isParent(r)) out.push(...(childrenOf.value[id] || []))
  return out
}
function stateOf(r) {
  const id = r.ID || r.id
  if (!availIds.value.has(id)) return { kind: 'unavailable' }
  // Available per the server, but a linked split space is taken → blocked.
  for (const rid of relatedIds(r)) {
    if (unavailIds.value.has(rid)) {
      return { kind: 'blocked', via: resById.value[rid]?.Name || resById.value[rid]?.name || 'a linked space' }
    }
  }
  return { kind: 'ok' }
}
const availIds = computed(() => new Set(available.value.map(r => r.ID || r.id)))
const unavailIds = computed(() => new Set(unavailable.value.map(r => r.ID || r.id)))
// Order results so a parent is immediately followed by its sub-rooms.
const rows = computed(() => {
  const seen = new Set()
  const uniq = []
  for (const r of [...available.value, ...unavailable.value]) {
    const id = r.ID || r.id
    if (!seen.has(id)) { seen.add(id); uniq.push(r) }
  }
  const byId = Object.fromEntries(uniq.map(r => [r.ID || r.id, r]))
  const out = []
  const placed = new Set()
  for (const r of uniq) {
    if (!isParent(r)) continue
    const id = r.ID || r.id
    out.push({ id, r, depth: 0, st: stateOf(r) }); placed.add(id)
    for (const cid of (childrenOf.value[id] || [])) {
      if (byId[cid]) { out.push({ id: cid, r: byId[cid], depth: 1, st: stateOf(byId[cid]) }); placed.add(cid) }
    }
  }
  for (const r of uniq) {
    const id = r.ID || r.id
    if (placed.has(id) || isParent(r)) continue
    out.push({ id, r, depth: 0, st: stateOf(r) })
  }
  return out
})

const locations = computed(() => {
  const ls = [...new Set(allResources.value.map(r => r.Location || r.location).filter(Boolean))]
  return ls.length ? ls : ['Hong Kong']
})

// Snap start to the nearest upcoming slot whenever the date changes.
function snapTimes() {
  const cur = timeSlots.value.find(t => t.value === form.start)
  if (!cur || cur.past) {
    form.start = nearestUpcoming()
    form.end = addMinutes(form.start, 60)
  }
}
watch(() => form.date, snapTimes)

onMounted(async () => {
  try {
    allResources.value = await api.listResources().catch(() => null)
      || await api.roomCatalog().catch(() => [])
    if (locations.value.length) form.region = locations.value[0]
  } catch { /* non-fatal */ }
  snapTimes()
  search()
})

async function search() {
  busy.value = true
  hasSearched.value = true
  picked.value = null
  const query = {
    location: form.region, date: form.date,
    start_time: form.allDay ? '00:00' : form.start,
    end_time: form.allDay ? '23:59' : form.end,
    capacity: form.capacity,
    // Tell the API this is an all-day search so it matches rooms that are
    // simply open that weekday, instead of demanding 24h operation (QA #2).
    all_day: form.allDay ? 'true' : 'false'
  }
  try {
    const data = await api.searchRooms(query)
    const list = Array.isArray(data) ? data : []
    const availIds = new Set(list.map(r => r.ID || r.id))
    available.value = list
    unavailable.value = allResources.value.filter(r =>
      (r.Location || r.location) === form.region &&
      (r.Capacity || r.capacity || 0) >= form.capacity &&
      !availIds.has(r.ID || r.id))
  } catch (e) {
    toasts.error('Search failed', e.message)
    available.value = []; unavailable.value = []
  } finally {
    busy.value = false
  }
  // Suggestions run in parallel with search rendering — the chips show
  // up shortly after the main results without blocking the room list.
  fetchSuggestions(query)
}

async function fetchSuggestions(q) {
  if (form.allDay) { suggestions.value = []; return }
  suggestBusy.value = true
  try {
    const data = await api.suggestSlots({ ...q, limit: 5 })
    suggestions.value = Array.isArray(data) ? data : []
  } catch {
    suggestions.value = []
  } finally {
    suggestBusy.value = false
  }
}

function applySuggestion(s) {
  form.date = s.date
  form.start = s.start_time
  form.end = s.end_time
  search()
}

// Compact day label for suggestions whose date differs from the
// currently-picked one ("Mon 26 May" rather than "2026-05-26").
function fmtDay(iso) {
  try {
    const d = new Date(iso + 'T00:00:00')
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
  } catch { return iso }
}

function reserve(r) { picked.value = r }
function openModal() { modalRoom.value = picked.value }
function onBooked() { modalRoom.value = null; picked.value = null; toasts.success('Reservation submitted'); search() }
</script>

<style scoped>
.search-shell { display: grid; grid-template-columns: 300px 1fr; gap: 16px; }
@media (max-width: 880px) { .search-shell { grid-template-columns: 1fr; } }
.cbx { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #33414e; }
.cbx input { width: auto; }
.rng { font-weight: 400; font-size: 12px; color: var(--asl-grey); }
.recur-box { border: 1px solid var(--asl-line); border-radius: 3px; }
.recur-box .ph2 { background: #f3f6f9; border-bottom: 1px solid var(--asl-line); padding: 7px 12px; font-size: 12px; font-weight: 600; color: var(--asl-blue); }
.recur-box .rb { padding: 12px; }
.rad { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.rad input[type=radio] { width: auto; }
.check-msg { font-size: 12px; }
.check-msg.bad { color: var(--asl-bad); }

/* Next-available suggestion strip */
.suggest-strip {
  margin-top: 16px; padding: 12px 14px;
  background: #f7fafd; border: 1px solid #d8e7f5; border-radius: 3px;
}
.suggest-head { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-bottom: 8px; color: #1c5d8d; }
.suggest-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip-slot {
  display: inline-flex; flex-direction: column; align-items: flex-start;
  gap: 2px; padding: 6px 12px; border-radius: 3px;
  background: #fff; border: 1px solid var(--asl-line);
  font: inherit; cursor: pointer; transition: all 120ms;
  min-width: 110px;
}
.chip-slot:hover {
  border-color: var(--asl-blue); background: var(--asl-blue);
  color: #fff;
}
.chip-slot:hover .cnt { color: rgba(255,255,255,.85); }
.chip-slot .when { font-size: 13px; font-weight: 600; }
.chip-slot .cnt  { font-size: 11px; color: var(--asl-grey); }
</style>
