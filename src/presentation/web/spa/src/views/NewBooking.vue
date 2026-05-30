<template>
  <div class="mrbs">
    <h1 class="fsd-page-title">New Booking</h1>

    <div class="panel">
      <div class="stepper">
        <div class="step" :class="{ active: step === 1, done: step > 1 }">
          <div class="bub"><Check v-if="step > 1" :size="13" /><template v-else>1</template></div>
          <div class="lbl">Search Room</div>
        </div>
        <div class="line" :class="{ done: step > 1 }" />
        <div class="step" :class="{ active: step === 2 }">
          <div class="bub">2</div>
          <div class="lbl">Input Detail</div>
        </div>
      </div>
    </div>

    <!-- STEP 1 — Search Room -->
    <div v-show="step === 1" class="panel">
      <div class="ph">
        <span>Booking Detail — select a room and drag a time range</span>
      </div>
      <div class="pb">
        <div class="row mb" style="justify-content: space-between; flex-wrap: wrap; gap: 10px;">
          <label class="fld" style="margin:0; min-width: 260px;">
            <span>Please select a room</span>
            <select v-model="resourceId" @change="loadBlocks">
              <option value="" disabled>— choose a room —</option>
              <option v-for="r in resources" :key="r.ID || r.id" :value="r.ID || r.id">
                {{ r.Name || r.name }} ({{ r.Capacity || r.capacity }} pax) · {{ r.Location || r.location }}
              </option>
            </select>
          </label>
          <div class="row gap-sm" style="align-self: flex-end;">
            <button class="mrbs-btn ghost" @click="shiftWeek(-1)"><ChevronLeft :size="14" /> Previous</button>
            <button class="mrbs-btn ghost" @click="shiftWeek(1)">Next <ChevronRight :size="14" /></button>
          </div>
        </div>

        <div style="overflow-x:auto;">
          <table class="wkgrid" @mouseup="endDrag" @mouseleave="endDrag">
            <thead>
              <tr>
                <th style="width:54px;">Time</th>
                <th v-for="d in week" :key="d.iso">{{ d.label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in hours" :key="h">
                <td class="tcol">{{ hourLabel(h) }}</td>
                <td v-for="d in week" :key="d.iso + h"
                    class="slot"
                    :class="{ blocked: isBlocked(d.iso, h), sel: isSel(d.iso, h) }"
                    @mousedown="startDrag(d.iso, h)"
                    @mouseover="overDrag(d.iso, h)">
                  <template v-if="isBlocked(d.iso, h)">Booked</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted text-sm mt-sm">Drag across a day column to select a time range, then click Next.</p>

        <div class="row mt" style="justify-content: flex-end;">
          <button class="mrbs-btn" :disabled="!canProceed" @click="goStep2">Next <ChevronRight :size="14" /></button>
        </div>
      </div>
    </div>

    <!-- STEP 2 — Input Detail -->
    <div v-show="step === 2" class="bk-2col">
      <div class="panel">
        <div class="ph"><span>Booking Detail</span></div>
        <div class="pb">
          <label class="fld">
            <span>Location</span>
            <select v-model="form.location">
              <option v-for="loc in locations" :key="loc" :value="loc">{{ loc }}</option>
            </select>
          </label>

          <label class="fld">
            <span>Title</span>
            <input v-model="form.title" placeholder="Meeting subject" />
          </label>

          <div class="grid-2">
            <label class="fld">
              <span>Date</span>
              <input type="date" v-model="form.date" />
            </label>
            <label class="fld" style="display:flex; align-items:flex-end;">
              <label class="cbx"><input type="checkbox" v-model="form.allDay" /> All Day Event</label>
            </label>
          </div>

          <div class="grid-2" v-if="!form.allDay">
            <label class="fld"><span>Start Time</span><input type="time" v-model="form.start" /></label>
            <label class="fld"><span>End Time</span><input type="time" v-model="form.end" /></label>
          </div>

          <label class="cbx mb"><input type="checkbox" v-model="form.recur" /> Recur</label>

          <div v-if="form.recur" class="recur-box">
            <div class="ph2">Recurrence Specifications</div>
            <div class="rb">
              <div class="row gap mb">
                <span class="rk">Repeat:</span>
                <label v-if="allowsPattern('daily')" class="rad"><input type="radio" value="daily" v-model="form.rec.freq" /> Daily</label>
                <label v-if="allowsPattern('weekly')" class="rad"><input type="radio" value="weekly" v-model="form.rec.freq" /> Weekly</label>
                <label v-if="allowsPattern('monthly')" class="rad"><input type="radio" value="monthly" v-model="form.rec.freq" /> Monthly</label>
              </div>
              <div class="row gap mb">
                <label class="rad"><input type="radio" value="every" v-model="form.rec.mode" />
                  Every <input class="mini" type="number" min="1" v-model.number="form.rec.interval" /> {{ form.rec.freq === 'weekly' ? 'week(s)' : form.rec.freq === 'monthly' ? 'month(s)' : 'day(s)' }}</label>
              </div>
              <div v-if="allowsPattern('weekday')" class="row gap mb">
                <label class="rad"><input type="radio" value="weekday" v-model="form.rec.mode" /> Recur every weekday</label>
              </div>
              <div class="row gap mb">
                <span class="rk">End:</span>
                <label class="rad"><input type="radio" value="after" v-model="form.rec.end" />
                  After <input class="mini" type="number" min="1" v-model.number="form.rec.count" /> occurrences</label>
              </div>
              <div class="row gap">
                <label class="rad"><input type="radio" value="by" v-model="form.rec.end" />
                  By <input class="mini wide" type="date" v-model="form.rec.until" /></label>
              </div>
            </div>
          </div>

          <div class="row mt" style="justify-content: space-between;">
            <button class="mrbs-btn ghost" @click="step = 1"><ChevronLeft :size="14" /> Back</button>
            <div class="row gap-sm">
              <button class="mrbs-btn ghost" @click="check"><Check :size="14" /> Check Availability</button>
              <button class="mrbs-btn" :disabled="busy" @click="submit">{{ busy ? 'Submitting…' : 'Confirm Booking' }}</button>
            </div>
          </div>
          <p v-if="checkMsg" class="check-msg" :class="checkOk ? 'ok' : 'bad'">{{ checkMsg }}</p>
        </div>
      </div>

      <div class="panel">
        <div class="ph"><span>Room Detail</span></div>
        <div class="pb">
          <template v-if="selectedRoom">
            <dl class="rd">
              <dt>Room Name</dt><dd>{{ selectedRoom.Name || selectedRoom.name }}</dd>
              <dt>Location</dt><dd>{{ selectedRoom.Location || selectedRoom.location }}</dd>
              <dt>Number of Seats</dt><dd>{{ selectedRoom.Capacity || selectedRoom.capacity }}</dd>
              <dt>Asset Type</dt><dd>{{ selectedRoom.AssetType || selectedRoom.asset_type || 'Room' }}</dd>
              <dt v-if="(selectedRoom.Equipment || selectedRoom.equipment || []).length">Equipment</dt>
              <dd v-if="(selectedRoom.Equipment || selectedRoom.equipment || []).length">
                {{ (selectedRoom.Equipment || selectedRoom.equipment).join(', ') }}
              </dd>
            </dl>
          </template>
          <EmptyState v-else :icon="DoorOpen" title="No room selected" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Check, ChevronLeft, ChevronRight, DoorOpen } from 'lucide-vue-next'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'
import { useTenantStore } from '../stores/tenant'
import { useBookingRules } from '../composables/bookingRules'

const router = useRouter()
const tenant = useTenantStore()
const { allowsPattern, validate: validateRules } = useBookingRules()
const toasts = useToastStore()

const step = ref(1)
const resources = ref([])
const resourceId = ref('')
const weekStart = ref(mondayOf(new Date()))
const blocks = ref([])         // booked [{ iso, hour }]
const busy = ref(false)
const checkMsg = ref('')
const checkOk = ref(false)

const hours = computed(() => {
  const cz = tenant.customization || {}
  const s = Number.isInteger(cz.calendar_start_hour) ? cz.calendar_start_hour : 9
  const e = Number.isInteger(cz.calendar_end_hour) ? cz.calendar_end_hour : 17
  const out = []
  for (let h = s; h <= Math.max(s, e); h++) out.push(h)
  return out
})

const drag = reactive({ on: false, iso: '', from: null, to: null })

// Default the time pickers to "now, rounded up to the next 30-min slot"
// + a one-hour window, matching the convention used by Calendly / Google
// Calendar / Outlook. The user can still override.
function _nowSlot() {
  const d = new Date()
  d.setMinutes(d.getMinutes() + (30 - d.getMinutes() % 30) % 30, 0, 0)
  if (d.getMinutes() === 0 && (Date.now() - d.getTime()) > -1000) d.setMinutes(d.getMinutes() + 30)
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}
function _plusHour(hhmm) {
  const [h,m] = hhmm.split(':').map(Number)
  const t = h*60 + m + 60
  return `${String(Math.floor(t/60)%24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`
}
const _s = _nowSlot()
const form = reactive({
  location: '', title: '', date: '', allDay: false,
  start: _s, end: _plusHour(_s), recur: false,
  rec: { freq: 'daily', mode: 'every', interval: 1, end: 'after', count: 4, until: '' }
})

const selectedRoom = computed(() => resources.value.find(r => (r.ID || r.id) === resourceId.value) || null)
const locations = computed(() => [...new Set(resources.value.map(r => r.Location || r.location).filter(Boolean))])

const week = computed(() => {
  const out = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.value); d.setDate(d.getDate() + i)
    out.push({ iso: d.toISOString().slice(0, 10), label: d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }) })
  }
  return out
})

const canProceed = computed(() => resourceId.value && drag.iso && drag.from != null && drag.to != null)

onMounted(async () => {
  try {
    resources.value = await api.listResources()
    if (resources.value.length) {
      resourceId.value = resources.value[0].ID || resources.value[0].id
      form.location = resources.value[0].Location || resources.value[0].location || ''
      await loadBlocks()
    }
  } catch (e) { toasts.error('Could not load rooms', e.message) }
})

function mondayOf(d) {
  const x = new Date(d); const day = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x
}
function shiftWeek(n) { const d = new Date(weekStart.value); d.setDate(d.getDate() + n * 7); weekStart.value = d; loadBlocks() }
function hourLabel(h) { const ap = h < 12 ? 'AM' : 'PM'; const hh = h % 12 || 12; return `${hh} ${ap}` }

async function loadBlocks() {
  blocks.value = []
  if (!resourceId.value) return
  try {
    const admin = await api.listAllBookings().catch(() => null)
    const mine = await api.myBookings().catch(() => [])
    const all = Array.isArray(admin) && admin.length ? admin : (mine || [])
    blocks.value = all
      .filter(b => b.ResourceID === resourceId.value && b.Status !== 'Cancelled')
      .flatMap(b => {
        const s = new Date(b.StartTime), e = new Date(b.EndTime)
        const iso = s.toISOString().slice(0, 10)
        const out = []
        for (let h = s.getHours(); h < Math.max(s.getHours() + 1, e.getHours()); h++) out.push({ iso, hour: h })
        return out
      })
  } catch { /* non-fatal */ }
}

function isBlocked(iso, h) { return blocks.value.some(b => b.iso === iso && b.hour === h) }
function isSel(iso, h) {
  if (drag.iso !== iso || drag.from == null || drag.to == null) return false
  const lo = Math.min(drag.from, drag.to), hi = Math.max(drag.from, drag.to)
  return h >= lo && h <= hi
}
function startDrag(iso, h) { if (isBlocked(iso, h)) return; drag.on = true; drag.iso = iso; drag.from = h; drag.to = h }
function overDrag(iso, h) { if (drag.on && iso === drag.iso && !isBlocked(iso, h)) drag.to = h }
function endDrag() { drag.on = false }

function goStep2() {
  const lo = Math.min(drag.from, drag.to), hi = Math.max(drag.from, drag.to)
  form.date = drag.iso
  form.start = String(lo).padStart(2, '0') + ':00'
  form.end = String(hi + 1).padStart(2, '0') + ':00'
  if (selectedRoom.value) form.location = selectedRoom.value.Location || selectedRoom.value.location || form.location
  checkMsg.value = ''
  step.value = 2
}

async function check() {
  if (!resourceId.value || !form.date) { checkMsg.value = 'Select a room and date first.'; checkOk.value = false; return }
  try {
    const list = await api.searchRooms({
      location: form.location, date: form.date,
      start_time: form.start, end_time: form.end
    })
    const free = (Array.isArray(list) ? list : []).some(r => (r.ID || r.id) === resourceId.value)
    checkOk.value = free
    checkMsg.value = free ? '✓ Room is available for the selected time.' : '✗ Room is not available for the selected time.'
  } catch (e) { checkOk.value = false; checkMsg.value = 'Availability check failed: ' + e.message }
}

async function submit() {
  // Enforce admin-configured booking rules before hitting the API.
  if (!form.allDay) {
    const ruleErr = validateRules({ date: form.date, start: form.start, end: form.end })
    if (ruleErr) { checkOk.value = false; checkMsg.value = ruleErr; return }
  }
  busy.value = true
  try {
    const startISO = new Date(`${form.date}T${form.allDay ? '00:00' : form.start}`).toISOString()
    const endISO = new Date(`${form.date}T${form.allDay ? '23:59' : form.end}`).toISOString()
    const body = {
      resource_id: resourceId.value,
      title: form.title || (selectedRoom.value?.Name || 'Booking'),
      start_time: startISO,
      end_time: endISO
    }
    if (form.recur) {
      body.recurrence = {
        frequency: form.rec.freq,
        interval: form.rec.mode === 'weekday' ? 1 : form.rec.interval,
        weekdays_only: form.rec.mode === 'weekday',
        count: form.rec.end === 'after' ? form.rec.count : undefined,
        until: form.rec.end === 'by' ? form.rec.until : undefined
      }
    }
    await api.createBooking(body)
    toasts.success('Reservation submitted')
    router.push('/my')
  } catch (e) {
    toasts.error('Booking failed', e.message)
  } finally { busy.value = false }
}
</script>

<style scoped>
.bk-2col { display: grid; grid-template-columns: 1fr 320px; gap: 16px; }
@media (max-width: 900px) { .bk-2col { grid-template-columns: 1fr; } }

.cbx { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #33414e; }
.cbx input { width: auto; }

.recur-box { border: 1px solid var(--asl-line); border-radius: 3px; margin-bottom: 12px; }
.recur-box .ph2 { background: #f3f6f9; border-bottom: 1px solid var(--asl-line); padding: 7px 12px; font-size: 12px; font-weight: 600; color: var(--asl-blue); }
.recur-box .rb { padding: 12px; }
.rad { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.rad input[type=radio] { width: auto; }
.rk { font-size: 13px; color: var(--asl-grey); width: 52px; }
.mini { width: 56px; padding: 4px 6px; border: 1px solid var(--asl-line); border-radius: 3px; font: inherit; }
.mini.wide { width: 150px; }

.check-msg { margin-top: 10px; font-size: 13px; }
.check-msg.ok { color: var(--asl-ok); }
.check-msg.bad { color: var(--asl-bad); }

.rd { display: grid; grid-template-columns: 1fr; gap: 0; margin: 0; }
.rd dt { font-size: 11px; color: var(--asl-grey); text-transform: uppercase; letter-spacing: .04em; margin-top: 10px; }
.rd dt:first-child { margin-top: 0; }
.rd dd { margin: 2px 0 0; font-size: 14px; color: #33414e; font-weight: 600; }
</style>
