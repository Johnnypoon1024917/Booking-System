<template>
  <div class="mrbs">
    <h1 class="fsd-page-title">Schedule</h1>

    <div class="panel">
      <div class="ph cal-head">
        <span class="cal-title">Calendar — drag across open slots to reserve</span>
        <div class="row gap-sm cal-ctrls">
          <div class="seg-tabs">
            <button :class="{ on: view === 'day' }" @click="setView('day')">Day</button>
            <button :class="{ on: view === 'week' }" @click="setView('week')">Week</button>
            <button :class="{ on: view === 'month' }" @click="setView('month')">Month</button>
          </div>
          <!-- Day-view date navigation: prev / today / next mirror the
               FullCalendar toolbar that Week and Month inherit so all
               three views feel the same. The arrows shift the ISO date
               by ±1 day and trigger reload(); "Today" jumps back to the
               current day. v-if (not v-show) keeps the Day-only controls
               out of the DOM entirely on Week/Month — the room filter
               in particular makes no sense outside the multi-column Day
               grid since Week/Month don't show per-room columns. -->
          <div v-if="view === 'day'" class="day-nav">
            <button class="day-nav-btn" @click="shiftDay(-1)" aria-label="Previous day"><ChevronLeft :size="16" /></button>
            <button class="day-nav-btn today" @click="goToday">Today</button>
            <button class="day-nav-btn" @click="shiftDay(1)" aria-label="Next day"><ChevronRight :size="16" /></button>
          </div>
          <input type="date" v-model="date" class="d-in" style="width:150px;" @change="reload" />
          <input v-if="view === 'day'" v-model="q" class="d-in" placeholder="Filter room / floor…" style="width:160px;" />
        </div>
      </div>

      <!-- Week / Month overview via FullCalendar. Mounted with v-if (not
           v-show) and keyed per view so it always renders at full width —
           a calendar created inside a display:none box measures 0px and
           renders collapsed/overlapping headers. -->
      <div v-if="view !== 'day'" class="pb">
        <FullCalendar :key="view" ref="fc" :options="calendarOptions" />
        <p class="muted text-sm mt-sm">
          Drag across a time range (or click a day) to pick a room and book it here.
        </p>
      </div>

      <div v-show="view === 'day'" class="pb" style="padding:0;">
        <div v-if="loading" style="padding:16px;"><Skeleton height="320px" /></div>
        <EmptyState v-else-if="!shownRooms.length" :icon="CalendarOff" title="No rooms match"
                    description="Adjust the filter or add resources." />
        <div v-else style="overflow:auto;">
          <table class="calx"
                 @mouseup="endDrag" @mouseleave="cancelDrag">
            <thead>
              <tr>
                <th class="tcol-h" style="width:76px;">Time</th>
                <th v-for="r in shownRooms" :key="r.ID || r.id">
                  {{ r.Name || r.name }}
                  <span class="loc">{{ r.Location || r.location }}<span v-if="isVip(r)"> · VIP</span></span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in hours" :key="h">
                <td class="tcol">{{ hourLabel(h) }}</td>
                <td v-for="r in shownRooms" :key="(r.ID||r.id)+'-'+h"
                    class="cell"
                    :class="cellClass(r, h)"
                    :title="cellTip(r, h)"
                    @mousedown="startDrag(r, h)"
                    @mouseover="overDrag(r, h)">
                  <div v-if="isVip(r)" class="vip-tag">VIP RESTRICTED</div>
                  <div v-else-if="firstBlockAt(r, h)"
                       class="blk blk-clickable"
                       @click.stop="blockClickFromCell(r, h, $event)"
                       @mousedown.stop>
                    {{ firstBlockAt(r, h).title }}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-show="view === 'day'" class="pb" style="padding:10px 14px; border-top:1px solid var(--asl-line);">
        <span class="pill ok">Available</span>
        <span class="pill bad" style="margin-left:8px;">Booked / Conflict</span>
        <span class="pill bad" style="margin-left:8px;">VIP Restricted</span>
        <span class="muted text-sm" style="margin-left:12px;">
          Selection turns red and blocks when it overlaps an existing booking.
        </span>
      </div>
    </div>

    <!-- Week/Month: choose which room to book for the selected slot -->
    <div v-if="pendingSlot" class="slot-overlay" @click.self="pendingSlot = null">
      <div class="slot-card">
        <div class="ph"><span>Reserve a room</span></div>
        <div class="pb">
          <p class="muted text-sm" style="margin-bottom:10px;">
            {{ pendingSlot.date }} · {{ pendingSlot.start }} – {{ pendingSlot.end }}
          </p>
          <select v-model="pendingRoomId" class="d-in" style="width:100%;">
            <option value="" disabled>Choose a room…</option>
            <option v-for="r in bookableRooms" :key="r.ID || r.id" :value="r.ID || r.id">
              {{ r.Name || r.name }} — {{ r.Location || r.location }}
            </option>
          </select>
          <div class="row gap-sm" style="justify-content:flex-end; margin-top:14px;">
            <button class="seg-tabs" style="padding:6px 14px;border:1px solid var(--asl-line);border-radius:4px;background:#fff;cursor:pointer;"
                    @click="pendingSlot = null">Cancel</button>
            <button :disabled="!pendingRoomId"
                    style="padding:6px 16px;border:0;border-radius:4px;background:var(--asl-blue);color:#fff;cursor:pointer;font-weight:600;"
                    :style="{ opacity: pendingRoomId ? 1 : 0.5 }"
                    @click="confirmSlotRoom">Continue</button>
          </div>
        </div>
      </div>
    </div>

    <BookingModal v-if="draft"
                  :resource="draft.resource"
                  :date="draft.date"
                  :start="draft.start"
                  :end="draft.end"
                  @close="draft = null"
                  @booked="onBooked" />

    <!-- Quick-edit popover — Teams-style click target. Drag/resize on
         the calendar itself is the primary reschedule path; the time
         fields here are the keyboard fallback. -->
    <Modal v-if="editing" :title="editing.title" @close="editing = null">
      <div class="bdm-grid">
        <div class="bdm-row"><span class="bdm-lbl">Room</span><span>{{ editing.resourceName }}</span></div>
        <div class="bdm-row"><span class="bdm-lbl">Status</span><span>{{ editing.status }}</span></div>
        <label class="bdm-row">
          <span class="bdm-lbl">Start</span>
          <input class="d-in" type="datetime-local" v-model="editing.start" />
        </label>
        <label class="bdm-row">
          <span class="bdm-lbl">End</span>
          <input class="d-in" type="datetime-local" v-model="editing.end" />
        </label>
        <p class="muted text-sm" style="margin-top:6px;">
          Tip: drag the booking block on the calendar to reschedule, or drag the bottom edge to resize.
        </p>
      </div>
      <template #footer>
        <button class="btn-fsd btn-danger" :disabled="editBusy" @click="cancelEditing">Cancel booking</button>
        <span style="flex:1;"></span>
        <button class="btn-fsd btn-ghost" :disabled="editBusy" @click="editing = null">Close</button>
        <button class="btn-fsd" :disabled="editBusy" @click="saveEdit">Save</button>
      </template>
    </Modal>

    <!-- Reschedule confirmation — pops every time a calendar drag/resize
         lands, so a stray grab doesn't silently move the meeting.
         Dismissing this dialog reverts the visual change. -->
    <Modal v-if="rescheduleConfirm"
           :title="rescheduleConfirm.kind === 'resize' ? 'Change duration?' : 'Reschedule this booking?'"
           @close="cancelReschedule">
      <div class="bdm-grid">
        <div class="bdm-row"><span class="bdm-lbl">Meeting</span><span><b>{{ rescheduleConfirm.title }}</b></span></div>
        <div class="bdm-row"><span class="bdm-lbl">From</span><span class="muted">{{ rescheduleConfirm.fromLabel }}</span></div>
        <div class="bdm-row"><span class="bdm-lbl">To</span><span><b>{{ rescheduleConfirm.toLabel }}</b></span></div>
        <p class="muted text-sm" style="margin-top:6px;">
          Confirming will save the new time immediately. Choose <b>Keep original</b> to roll the booking back to where it was.
        </p>
      </div>
      <template #footer>
        <button class="btn-fsd btn-ghost" :disabled="rescheduleBusy" @click="cancelReschedule">Keep original</button>
        <span style="flex:1;"></span>
        <button class="btn-fsd" :disabled="rescheduleBusy" @click="confirmReschedule">Confirm</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { CalendarOff, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import FullCalendar from '@fullcalendar/vue3'
import timeGridPlugin from '@fullcalendar/timegrid'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import BookingModal from '../components/BookingModal.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'
import { useTenantStore } from '../stores/tenant'

const toasts = useToastStore()
const tenant = useTenantStore()
const loading = ref(true)
const view = ref('day')          // 'day' | 'week' | 'month'
const date = ref(new Date().toISOString().slice(0, 10))
const q = ref('')
const rooms = ref([])
const bookings = ref([])
const draft = ref(null)
const fc = ref(null)

const roomMap = computed(() =>
  Object.fromEntries(rooms.value.map(r => [r.ID || r.id, r.Name || r.name])))

// Week/Month events: real bookings + derived "blocked via" knock-on
// events for the *linked* parent/children of any booked split space.
// Real bookings carry the booking ID in extendedProps so click/drop/
// resize handlers can identify what to update. Blocked-via shadows and
// externally-owned busy intervals are marked editable:false so the
// drag/resize handles don't appear on them.
const weekMonthEvents = computed(() => {
  const evs = []
  for (const b of bookings.value) {
    if (b.Status === 'Cancelled') continue
    const name = roomMap.value[b.ResourceID] || 'Booking'
    // Show the room name alongside the meeting title — Teams-style
    // "Subject · Room" so users can tell rooms apart on a multi-room
    // calendar without clicking each event. When the user didn't set
    // a title the room name stands in for it (no duplication).
    const title = b.Title ? `${b.Title} · ${name}` : name
    const isMineMutable = !b._external && b.Status !== 'No Show'
    evs.push({
      id: 'bk-' + b.ID,
      title,
      start: b.StartTime,
      end: b.EndTime,
      color: b.Status === 'Pending Approval' ? '#d97706'
           : b.Status === 'No Show' ? '#7f1d1d'
           : '#dc2626',
      textColor: '#ffffff',
      editable: isMineMutable,
      extendedProps: { bookingId: b.ID, kind: 'booking' },
    })
    const r = resById.value[b.ResourceID]
    if (r) {
      for (const rid of relatedIds(r)) {
        if (rid === b.ResourceID) continue
        evs.push({
          id: `via-${b.ID}-${rid}`,
          title: (roomMap.value[rid] || 'Linked space') + ' — blocked via ' + name,
          start: b.StartTime,
          end: b.EndTime,
          color: '#94a3b8',
          textColor: '#0f172a',
          editable: false,
          extendedProps: { kind: 'blocked-via' },
        })
      }
    }
  }
  return evs
})

const calendarOptions = computed(() => ({
  plugins: [timeGridPlugin, dayGridPlugin, interactionPlugin],
  initialView: view.value === 'month' ? 'dayGridMonth' : 'timeGridWeek',
  initialDate: date.value,
  height: 620,
  headerToolbar: { left: 'prev,next today', center: 'title', right: '' },
  selectable: true,
  selectMirror: true,
  nowIndicator: true,
  events: weekMonthEvents.value,
  // Force solid block rendering in month view so titles are visible —
  // the default "dot" style produced unlabeled pills the user saw.
  eventDisplay: 'block',
  displayEventTime: true,
  displayEventEnd: true,
  eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
  // Teams-style direct manipulation: drag to reschedule, drag bottom
  // edge to resize, click to open a quick-edit popover.
  editable: true,
  eventStartEditable: true,
  eventDurationEditable: true,
  // Drag-select (or click) a slot in Week/Month → pick a room and book
  // it right here, without bouncing to the Day view.
  select: (info) => onCalSelect(info.start, info.end, info.allDay),
  dateClick: (info) => onCalSelect(info.date, null, info.allDay),
  eventClick: (info) => openDetailFromEvent(info.event),
  eventDrop: (info) => applyTimeChange(info),
  eventResize: (info) => applyTimeChange(info),
  // FullCalendar fires datesSet on prev/next/today AND initial mount.
  // Sync `date.value` to the new period's anchor day and reload so
  // bookings for the newly visible week/month appear. The skip-guard
  // prevents a refetch loop on initial mount where datesSet runs with
  // the same anchor we already loaded.
  datesSet: (info) => syncCalendarRange(info),
}))

function pad2(n) { return String(n).padStart(2, '0') }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function hhmm(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
function calStartHour() {
  const c = tenant.customization || {}
  return Number.isInteger(c.calendar_start_hour) ? c.calendar_start_hour : 8
}

const pendingSlot = ref(null)
const pendingRoomId = ref('')
const bookableRooms = computed(() => rooms.value.filter(r => !isVip(r)))

function onCalSelect(start, end, allDay) {
  let date_, s, e
  if (allDay || !end || (end - start) >= 86400000 || start.getHours() === 0 && (!end || end.getHours() === 0)) {
    // Month / all-day select → default to a 1h slot at the working-day start.
    const sh = calStartHour()
    date_ = ymd(start); s = `${pad2(sh)}:00`; e = `${pad2(sh + 1)}:00`
  } else {
    date_ = ymd(start); s = hhmm(start); e = hhmm(end)
  }
  const slot = { date: date_, start: s, end: e }
  const free = bookableRooms.value
  if (free.length === 1) {
    draft.value = { resource: free[0], date: slot.date, start: slot.start, end: slot.end }
    return
  }
  pendingRoomId.value = ''
  pendingSlot.value = slot
}

function confirmSlotRoom() {
  const r = rooms.value.find(x => (x.ID || x.id) === pendingRoomId.value)
  if (!r) return
  draft.value = { resource: r, date: pendingSlot.value.date, start: pendingSlot.value.start, end: pendingSlot.value.end }
  pendingSlot.value = null
}

// visibleRange returns the inclusive [start..end] day boundary the
// current view actually shows. Day = one day; Week = Sun..Sat
// containing `date`; Month = the calendar grid 6 weeks wide so
// bookings at the edges of the grid (last days of prev month, first
// days of next month) also render. Backend filters by this range so a
// booking on Friday is visible when the user is looking at the week
// containing it — not just when they happen to be on that Friday in
// the Day grid.
function visibleRange() {
  const [y, m, d] = date.value.split('-').map(Number)
  const focus = new Date(y, m - 1, d)
  const iso = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`
  if (view.value === 'week') {
    const s = new Date(focus); s.setDate(focus.getDate() - focus.getDay())
    const e = new Date(s);     e.setDate(s.getDate() + 6)
    return { start: iso(s), end: iso(e) }
  }
  if (view.value === 'month') {
    // Calendar grid: first Sunday on/before the 1st through the last
    // Saturday on/after the last day of the month. FullCalendar's
    // dayGridMonth renders up to 6 weeks of this exact window.
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1)
    const last  = new Date(focus.getFullYear(), focus.getMonth() + 1, 0)
    const s = new Date(first); s.setDate(first.getDate() - first.getDay())
    const e = new Date(last);  e.setDate(last.getDate() + (6 - last.getDay()))
    return { start: iso(s), end: iso(e) }
  }
  return { start: date.value, end: date.value }
}

// Day-view date navigation. Parsing the ISO `YYYY-MM-DD` as local
// midnight (not UTC) so a +1-day shift never crosses a timezone
// boundary and ends up on the wrong day in the user's locale.
function shiftDay(delta) {
  const [y, m, d] = date.value.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + delta)
  date.value = `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`
  reload()
}
function goToday() {
  const now = new Date()
  date.value = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`
  reload()
}

// Track which anchor date the calendar last fetched data for so the
// datesSet callback only refetches when the user actually navigated to
// a new period (not on every spurious re-emit).
let lastCalAnchor = null
function syncCalendarRange(info) {
  // info.view.currentStart is the first day of the visible period
  // (timeGridWeek → Sun of the visible week; dayGridMonth → 1st of the
  // anchor month, even though the grid starts a few days earlier).
  const anchor = ymd(info.view.currentStart)
  if (anchor === lastCalAnchor) return
  lastCalAnchor = anchor
  date.value = anchor
  reload()
}

function setView(v) {
  view.value = v
  // Refetch with the new visible range — Week/Month need bookings
  // across the full period, Day needs just the focused day, so the
  // dataset shape changes when the view does.
  reload()
  // v-if + :key remounts FullCalendar fresh at full width. Recalculate
  // size once it's painted, as a safety net for any layout transition.
  nextTick(() => {
    setTimeout(() => fc.value?.getApi?.()?.updateSize?.(), 30)
  })
}

// Admin-configurable working hours (Settings → Workflow).
const hours = computed(() => {
  const c = tenant.customization || {}
  const s = Number.isInteger(c.calendar_start_hour) ? c.calendar_start_hour : 8
  const e = Number.isInteger(c.calendar_end_hour) ? c.calendar_end_hour : 20
  const out = []
  for (let h = s; h <= Math.max(s, e); h++) out.push(h)
  return out
})

const drag = reactive({ on: false, roomId: null, resource: null, from: null, to: null, bad: false })

const shownRooms = computed(() => {
  const s = q.value.toLowerCase()
  const list = rooms.value.filter(r =>
    !s || (r.Name || r.name || '').toLowerCase().includes(s) ||
    (r.Location || r.location || '').toLowerCase().includes(s))
  return list.slice(0, 12)   // keep the grid readable; filter narrows further
})

function isVip(r) { return r.IsRestricted || r.is_restricted }
function hourLabel(h) { const ap = h < 12 ? 'AM' : 'PM'; const hh = h % 12 || 12; return `${String(hh).padStart(2,'0')}:00 ${ap}` }

function blocksFor(roomId) {
  return bookings.value.filter(b => b.ResourceID === roomId && b.Status !== 'Cancelled')
}
function isBooked(roomId, h) {
  return blocksFor(roomId).some(b => {
    const s = new Date(b.StartTime), e = new Date(b.EndTime)
    if (s.toISOString().slice(0, 10) !== date.value) return false
    return h >= s.getHours() && h < Math.max(s.getHours() + 1, e.getHours())
  })
}

// --- Split-room cross-locking ---
// Booking a child reserves its parent; booking a parent reserves all
// children. Siblings stay independent. This mirrors the server's
// HasConflict over the parent+children set so a split space can never be
// double-booked from the grid.
const resById = computed(() =>
  Object.fromEntries(rooms.value.map(r => [r.ID || r.id, r])))
const childrenByParent = computed(() => {
  const m = {}
  for (const r of rooms.value) {
    const p = r.ParentResourceID || r.parent_resource_id
    if (p) (m[p] = m[p] || []).push(r.ID || r.id)
  }
  return m
})
function relatedIds(r) {
  const id = r.ID || r.id
  const mode = r.CompositeMode || r.composite_mode
  const out = [id]
  if (mode === 'child' && (r.ParentResourceID || r.parent_resource_id)) {
    out.push(r.ParentResourceID || r.parent_resource_id)
  }
  if (mode === 'parent') out.push(...(childrenByParent.value[id] || []))
  return out
}
function isBlocked(r, h) { return relatedIds(r).some(rid => isBooked(rid, h)) }
function blockVia(r, h) {
  const id = r.ID || r.id
  for (const rid of relatedIds(r)) {
    if (rid !== id && isBooked(rid, h)) {
      return resById.value[rid]?.Name || resById.value[rid]?.name || 'a linked space'
    }
  }
  return ''
}

function firstBlockAt(r, h) {
  const id = r.ID || r.id
  const b = blocksFor(id).find(b => {
    const s = new Date(b.StartTime)
    return s.toISOString().slice(0, 10) === date.value && s.getHours() === h
  })
  if (b) return { title: b.Title || 'Reserved' }
  const via = blockVia(r, h)
  return via ? { title: 'via ' + via } : null
}

function cellTip(r, h) {
  if (isVip(r)) return 'VIP / restricted — booking not permitted here'
  const id = r.ID || r.id
  if (isBooked(id, h)) return 'Already booked'
  const via = blockVia(r, h)
  if (via) return 'Blocked by a booking on "' + via + '" (shared/split space)'
  return ''
}
function cellClass(r, h) {
  const id = r.ID || r.id
  if (isVip(r)) return 'vip'
  if (isBlocked(r, h)) return 'booked'
  if (drag.roomId === id && drag.from != null) {
    const lo = Math.min(drag.from, drag.to), hi = Math.max(drag.from, drag.to)
    if (h >= lo && h <= hi) return drag.bad ? 'sel-bad' : 'sel-ok'
  }
  return ''
}

function startDrag(r, h) {
  const id = r.ID || r.id
  if (isVip(r) || isBlocked(r, h)) return
  drag.on = true; drag.roomId = id; drag.resource = r
  drag.from = h; drag.to = h; drag.bad = false
}
function overDrag(r, h) {
  const id = r.ID || r.id
  if (!drag.on || id !== drag.roomId) return
  drag.to = h
  // Conflict detection includes the parent/child set so a split space is
  // never double-booked.
  const lo = Math.min(drag.from, drag.to), hi = Math.max(drag.from, drag.to)
  drag.bad = false
  for (let x = lo; x <= hi; x++) if (isBlocked(r, x)) { drag.bad = true; break }
}
function cancelDrag() { resetDrag() }
function endDrag() {
  if (!drag.on || drag.from == null) { resetDrag(); return }
  if (drag.bad) {
    toasts.error('Time conflict', 'Selection overlaps an existing booking. Pick a free range.')
    resetDrag(); return
  }
  const lo = Math.min(drag.from, drag.to), hi = Math.max(drag.from, drag.to) + 1
  draft.value = {
    resource: drag.resource,
    date: date.value,
    start: String(lo).padStart(2, '0') + ':00',
    end: String(hi).padStart(2, '0') + ':00'
  }
  resetDrag()
}
function resetDrag() { drag.on = false; drag.roomId = null; drag.resource = null; drag.from = null; drag.to = null; drag.bad = false }

onMounted(reload)

async function reload() {
  loading.value = true
  try {
    const user = tenant.user || {}
    const isAdmin = user.role === 'System Admin' || user.role === 'Security Admin' || user.role === 'Room Admin'

    // Resource list: admins use the full admin catalogue; ordinary
    // bookers (officers) fall back to the read-only room catalogue so the
    // calendar always has columns regardless of RBAC or bookings.
    const res = await (isAdmin
      ? api.listResources().catch(() => api.roomCatalog()) // Fallback for admins if listResources fails
      : api.roomCatalog()
    ).catch(() => [])
    // Bookings:
    //   - System / Security / Room admins (and Secretary) see the rich
    //     admin payload — every booking with PII so they can manage.
    //   - General users hit /api/v1/bookings/busy which returns PII-free
    //     intervals across the tenant, merged with their own bookings.
    //     Without this merge the calendar would pretend rooms are free
    //     when they're actually taken by someone else — leading to
    //     "scheduling conflict" errors at submit time.
    // Day view fetches just the focused day; Week/Month need the full
    // visible period so bookings outside today aren't invisible.
    const range = visibleRange()
    const useRange = view.value !== 'day'
    const [adm, busy, mine] = await Promise.all([
      (useRange
        ? api.listAllBookingsRange(range.start, range.end)
        : api.listAllBookings(date.value)).catch(() => null),
      (useRange
        ? api.busyIntervalsRange(range.start, range.end)
        : api.busyIntervals(date.value)).catch(() => []),
      api.myBookings().catch(() => []),
    ])
    rooms.value = res || []
    if (Array.isArray(adm) && adm.length) {
      bookings.value = adm
    } else {
      // Merge: my own bookings (with full detail so I can manage them)
      // plus everyone-else's busy intervals stamped as "Reserved" so
      // they render as opaque blocks without leaking who booked them.
      const mineIds = new Set((mine || []).map(b => b.ID))
      const externalBlocks = (busy || [])
        .filter(b => {
          // Skip intervals that are already in `mine` — same booking
          // would render twice otherwise. Busy intervals don't carry
          // an ID, so we match on (resource_id, start_time).
          return !(mine || []).some(m =>
            m.ResourceID === b.resource_id &&
            new Date(m.StartTime).getTime() === new Date(b.start_time).getTime())
        })
        .map(b => ({
          ID: `busy-${b.resource_id}-${b.start_time}`,
          ResourceID: b.resource_id,
          StartTime: b.start_time,
          EndTime: b.end_time,
          Status: b.status,
          UserID: '',
          Title: '',  // BookingModal-style block will render "Reserved"
          _external: true,  // flag for the renderer to disable click/edit
        }))
      bookings.value = [...(mine || []), ...externalBlocks]
      void mineIds  // kept for future "is mine?" badge rendering
    }
  } catch (e) {
    toasts.error('Could not load calendar', e.message)
  } finally {
    loading.value = false
  }
}

function onBooked() { draft.value = null; toasts.success('Reservation submitted'); reload() }

// --- Teams-style click / drag / resize editing -----------------------
// `editing` holds the booking shown in the detail popover. Reschedule
// happens via drag — the popover only surfaces details + a Cancel
// action; the time fields are editable for keyboard users who can't
// drag.
const editing = ref(null)
const editBusy = ref(false)

function pad(n) { return String(n).padStart(2, '0') }
function toLocalInput(iso) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function openDetail(b) {
  if (!b || b._external) return
  editing.value = {
    ID: b.ID,
    title: b.Title || roomMap.value[b.ResourceID] || 'Booking',
    resourceName: roomMap.value[b.ResourceID] || '—',
    status: b.Status || 'Confirmed',
    start: toLocalInput(b.StartTime),
    end: toLocalInput(b.EndTime),
  }
}
function openDetailFromEvent(ev) {
  // FullCalendar passes the EventApi object — pull our booking id out
  // of extendedProps and look up the original row so we hand the same
  // shape to openDetail() that the Day-view click path uses.
  const id = ev?.extendedProps?.bookingId
  if (!id) return
  const b = bookings.value.find(x => x.ID === id)
  if (b) openDetail(b)
}
function blockClickFromCell(r, h, e) {
  // Day-view: a click that wasn't part of a drag-create lands here.
  // Resolve the booking covering (room, hour) and open the popover.
  if (drag.on) return
  const id = r.ID || r.id
  const blk = blocksFor(id).find(b => {
    const s = new Date(b.StartTime), end = new Date(b.EndTime)
    if (s.toISOString().slice(0, 10) !== date.value) return false
    return h >= s.getHours() && h < Math.max(s.getHours() + 1, end.getHours())
  })
  if (blk) {
    e?.stopPropagation?.()
    openDetail(blk)
  }
}

// `rescheduleConfirm` parks the in-flight drag/resize until the user
// approves it. Auto-applying on drop felt risky — a stray Teams-style
// grab moves the meeting and the only signal is a toast. The confirm
// dialog gives an explicit "Confirm / Keep original" choice and reverts
// the visual change if the user cancels or closes the dialog.
const rescheduleConfirm = ref(null)
const rescheduleBusy = ref(false)

function fmtPretty(d) {
  return d.toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

function applyTimeChange(info) {
  // Drag-drop and resize both land here. Instead of committing
  // immediately, stash the change and pop the confirmation modal so the
  // user can rethink. The confirm handler does the actual PUT;
  // dismissing the modal calls info.revert() to roll back the visual.
  const id = info?.event?.extendedProps?.bookingId
  if (!id) { info?.revert?.(); return }
  const start = info.event.start
  const end = info.event.end || new Date(start.getTime() + 60 * 60 * 1000)
  const oldStart = info.oldEvent?.start || start
  const oldEnd = info.oldEvent?.end || end
  rescheduleConfirm.value = {
    info,
    id,
    title: info.event.title || 'Booking',
    fromLabel: `${fmtPretty(oldStart)} → ${fmtPretty(oldEnd)}`,
    toLabel: `${fmtPretty(start)} → ${fmtPretty(end)}`,
    kind: info.type === 'eventResize' || start.getTime() === oldStart.getTime() ? 'resize' : 'move',
    start, end,
  }
}

async function confirmReschedule() {
  const c = rescheduleConfirm.value
  if (!c) return
  rescheduleBusy.value = true
  try {
    await api.updateBooking(c.id, {
      start_time: c.start.toISOString(),
      end_time: c.end.toISOString(),
    })
    toasts.success(c.kind === 'resize' ? 'Duration updated' : 'Rescheduled')
    rescheduleConfirm.value = null
    reload()
  } catch (e) {
    toasts.error('Reschedule failed', e.message)
    c.info?.revert?.()
    rescheduleConfirm.value = null
  } finally { rescheduleBusy.value = false }
}

function cancelReschedule() {
  const c = rescheduleConfirm.value
  if (!c) return
  c.info?.revert?.()
  rescheduleConfirm.value = null
}

async function saveEdit() {
  if (!editing.value) return
  editBusy.value = true
  try {
    await api.updateBooking(editing.value.ID, {
      start_time: new Date(editing.value.start).toISOString(),
      end_time: new Date(editing.value.end).toISOString(),
    })
    toasts.success('Booking updated')
    editing.value = null
    reload()
  } catch (e) {
    toasts.error('Update failed', e.message)
  } finally { editBusy.value = false }
}

async function cancelEditing() {
  if (!editing.value) return
  const reason = prompt('Cancel this booking? Enter a reason:')
  if (reason === null) return
  editBusy.value = true
  try {
    await api.cancelBooking(editing.value.ID, reason || 'cancelled from calendar')
    toasts.success('Booking cancelled')
    editing.value = null
    reload()
  } catch (e) {
    toasts.error('Cancel failed', e.message)
  } finally { editBusy.value = false }
}
</script>

<style scoped>
.d-in { padding: 6px 9px; border: 1px solid var(--asl-line); border-radius: 3px; font: inherit; font-size: 13px; background: #fff; }
.calx td.tcol { font-size: 12px; }
.seg-tabs { display: inline-flex; border: 1px solid var(--asl-line); border-radius: 4px; overflow: hidden; }
.seg-tabs button { border: 0; background: #fff; padding: 6px 14px; font: inherit; font-size: 13px; cursor: pointer; color: var(--asl-grey); border-right: 1px solid var(--asl-line); }
.seg-tabs button:last-child { border-right: 0; }
.seg-tabs button.on { background: var(--asl-blue); color: #fff; font-weight: 600; }

/* Linear toolbar: keep all controls on one line so the view tabs,
   date navigation, date picker, and room filter sit in a single row.
   On very narrow viewports we still allow wrapping as a safety net so
   nothing clips off the right edge of the panel. */
.cal-head { flex-wrap: nowrap; gap: 8px; align-items: center; }
.cal-title { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-ctrls { flex-wrap: nowrap; justify-content: flex-end; align-items: center; gap: 8px; }
.cal-ctrls .d-in { flex: 0 0 auto; }
.seg-tabs { flex: 0 0 auto; }
.day-nav { flex: 0 0 auto; }

@media (max-width: 1100px) {
  /* Safety net on narrow screens — let the controls wrap rather than
     clip the room-filter input off the right edge. */
  .cal-head { flex-wrap: wrap; }
  .cal-ctrls { flex-wrap: wrap; }
}

.slot-overlay {
  position: fixed; inset: 0; background: rgba(15,23,42,.45);
  display: grid; place-items: center; z-index: 60;
}
.slot-card { width: min(420px, calc(100vw - 32px)); background: #fff; border-radius: 6px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.slot-card .pb { padding: 16px; }

/* Day-view booking blocks now act as click targets — match the cursor
   and hover treatment of the FullCalendar Week/Month event blocks. */
.blk-clickable { cursor: pointer; transition: filter .12s ease; }
.blk-clickable:hover { filter: brightness(1.05); }

/* Day-view date navigation buttons — flat-pill style that lines up
   with the seg-tabs / .d-in row already on this header. */
.day-nav { display: inline-flex; border: 1px solid var(--asl-line); border-radius: 4px; overflow: hidden; }
.day-nav-btn {
  background: #fff; border: 0; padding: 6px 10px; font: inherit; font-size: 13px;
  color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  border-right: 1px solid var(--asl-line);
}
.day-nav-btn:last-child { border-right: 0; }
.day-nav-btn:hover { background: #f1f5f9; }
.day-nav-btn.today { font-weight: 600; }

/* Booking-detail popover layout. The fields are stacked label/value
   pairs so the dialog stays narrow enough to feel like a Teams quick
   peek instead of a full form. */
.bdm-grid { display: flex; flex-direction: column; gap: 10px; }
.bdm-row { display: flex; align-items: center; gap: 12px; }
.bdm-lbl { flex: 0 0 70px; color: var(--fsd-muted, #64748b); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.bdm-row .d-in { flex: 1; }
.btn-fsd.btn-danger { background: #dc2626; color: #fff; border-color: #dc2626; }
.btn-fsd.btn-danger:hover { background: #b91c1c; border-color: #b91c1c; }
.btn-fsd.btn-ghost { background: #fff; color: var(--text); }
</style>
