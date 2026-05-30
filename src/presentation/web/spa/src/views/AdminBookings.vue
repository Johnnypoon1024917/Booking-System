<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('admin.bookings.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('admin.bookings.subtitle') }}</p>
    </div>
    <div class="row gap-sm">
      <button class="btn ghost" @click="load"><RefreshCcw :size="14"/> {{ $t('common.refresh') }}</button>
      <button class="btn" :class="{ active: viewMode === 'timetable' }" @click="viewMode = 'timetable'">
        <Calendar :size="14"/> {{ $t('admin.bookings.timetable') }}
      </button>
      <button class="btn" :class="{ active: viewMode === 'floorplan' }" @click="viewMode = 'floorplan'">
        <LayoutGrid :size="14"/> {{ $t('admin.bookings.floorplan') }}
      </button>
    </div>
  </div>

  <!-- Filters -->
  <div class="card mb">
    <div class="row gap" style="flex-wrap: wrap;">
      <div class="search" style="flex:1; max-width:360px;">
        <Search class="icon" :size="14"/>
        <input v-model="q" :placeholder="$t('admin.bookings.searchPh')" />
      </div>
      <input type="date" v-model="filterDate" style="width: auto;" />
      <select v-model="filterResource" style="width: auto;">
        <option value="">{{ $t('admin.bookings.allResources') }}</option>
        <option v-for="r in resources" :key="r.ID" :value="r.ID">{{ r.Name }}</option>
      </select>
      <select v-model="filterStatus" style="width: auto;">
        <option value="">{{ $t('admin.bookings.allStatuses') }}</option>
        <option value="Confirmed">{{ $t('booking.confirmed') }}</option>
        <option value="Pending Approval">{{ $t('booking.pending') }}</option>
        <option value="Cancelled">{{ $t('booking.cancelled') }}</option>
        <option value="Checked In">{{ $t('booking.checkedin') }}</option>
      </select>
    </div>
  </div>

  <!-- Loading state -->
  <div v-if="loading">
    <div class="card mb" v-for="n in 6" :key="n"><Skeleton height="60px"/></div>
  </div>

  <!-- Timetable View -->
  <div v-else-if="viewMode === 'timetable' && displayedResources.length" class="timetable-container">
    <div class="row gap-sm mb" style="padding: 10px 12px 0;">
      <span class="muted text-sm"><MousePointerClick :size="13"/> Drag across empty time slots in a room column to create a booking.</span>
      <span class="space"></span>
      <label class="text-sm muted">Date
        <input type="date" v-model="bookingDate" style="width:auto; margin-left:6px;"/>
      </label>
    </div>
    <div class="timetable-header">
      <div class="time-column"></div>
      <div v-for="resource in displayedResources" :key="resource.ID" class="resource-column">
        <div class="resource-name">{{ resource.Name }}</div>
        <div class="resource-meta text-sm muted">{{ resource.Location }}</div>
      </div>
    </div>
    <div class="timetable-body" @mouseleave="cancelDrag" @mouseup="endCellDrag">
      <div v-for="hour in timeSlots" :key="hour" class="time-row">
        <div class="time-label">{{ formatHour(hour) }}</div>
        <div v-for="resource in displayedResources" :key="resource.ID"
             class="resource-cell"
             :class="{ 'cell-selected': isCellSelected(resource.ID, hour) }"
             :data-hour="hour" :data-resource="resource.ID"
             @mousedown="startCellDrag(resource, hour)"
             @mouseenter="extendCellDrag(resource, hour)">
          <div v-for="booking in getBookingsForResource(resource.ID, hour)" :key="booking.ID"
               class="booking-block"
               :class="'status-' + booking.Status.toLowerCase().replace(' ', '-')"
               @mousedown.stop
               @click="openBooking(booking)">
            <div class="booking-title truncate">{{ booking.Title || $t('booking.untitled') }}</div>
            <div class="booking-user text-xs muted truncate">{{ getUserDisplayName(booking.UserID) }}</div>
            <div class="booking-time text-xs">{{ formatBookingTime(booking) }}</div>
          </div>
          <div v-if="!getBookingsForResource(resource.ID, hour).length" class="cell-hint">+</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Floor Plan View -->
  <div v-else-if="viewMode === 'floorplan' && resources.length" class="floorplan-container">
    <!-- Floor plan toolbar -->
    <div class="floorplan-toolbar">
      <!-- Plan selector + management -->
      <div class="toolbar-group">
        <select v-model="activePlanId" class="plan-select" :disabled="!floorPlans.length">
          <option v-for="p in floorPlans" :key="p.ID" :value="p.ID">
            {{ p.Name }}{{ p.IsDefault ? ' ★' : '' }}
          </option>
        </select>
        <button class="btn sm ghost" @click="newPlan" :title="$t('admin.bookings.newPlan')">
          <Plus :size="13"/>
        </button>
        <button class="btn sm ghost" @click="duplicatePlan" :disabled="!activePlan" :title="$t('admin.bookings.duplicatePlan')">
          <Copy :size="13"/>
        </button>
        <button class="btn sm ghost" @click="renamePlan" :disabled="!activePlan" :title="$t('admin.bookings.renamePlan')">
          <FilePenLine :size="13"/>
        </button>
        <button class="btn sm ghost danger" @click="deletePlan" :disabled="!activePlan || floorPlans.length <= 1" :title="$t('admin.bookings.deletePlan')">
          <Trash2 :size="13"/>
        </button>
        <button class="btn sm" :class="{ active: planDirty }" @click="savePlan" :disabled="!planDirty || planSaving">
          <Save :size="13"/> {{ planSaving ? $t('common.saving') : $t('common.save') }}
        </button>
      </div>

      <span class="toolbar-sep"></span>

      <div class="toolbar-group">
        <button class="btn sm" :class="{ active: planMode === 'view' }" @click="planMode = 'view'">
          <Eye :size="13"/> {{ $t('admin.bookings.modeView') }}
        </button>
        <button class="btn sm" :class="{ active: planMode === 'draw' }" @click="planMode = 'draw'">
          <Pencil :size="13"/> {{ $t('admin.bookings.modeDraw') }}
        </button>
        <button class="btn sm" :class="{ active: planMode === 'pins' }" @click="planMode = 'pins'">
          <Move :size="13"/> {{ $t('admin.bookings.modePins') }}
        </button>
      </div>

      <!-- Drawing tools (only in draw mode) -->
      <div v-if="planMode === 'draw'" class="toolbar-group">
        <button class="btn sm" :class="{ active: drawTool === 'rect' }" @click="drawTool = 'rect'" :title="$t('admin.bookings.toolRect')">
          <Square :size="13"/>
        </button>
        <button class="btn sm" :class="{ active: drawTool === 'line' }" @click="drawTool = 'line'" :title="$t('admin.bookings.toolWall')">
          <Minus :size="13"/>
        </button>
        <button class="btn sm" :class="{ active: drawTool === 'erase' }" @click="drawTool = 'erase'" :title="$t('admin.bookings.toolErase')">
          <Eraser :size="13"/>
        </button>
        <span class="toolbar-sep"></span>
        <button class="btn sm ghost danger" @click="clearShapes" :disabled="!shapes.length">
          <Trash2 :size="13"/> {{ $t('admin.bookings.clearAll') }}
        </button>
      </div>

      <span class="muted text-sm" v-if="planMode === 'draw'">{{ $t('admin.bookings.drawHelp') }}</span>
      <span class="muted text-sm" v-else-if="planMode === 'pins'">{{ $t('admin.bookings.pinsHelp') }}</span>
    </div>

    <div
      class="floorplan-canvas"
      :class="{ drawing: planMode === 'draw', moving: planMode === 'pins' }"
      :style="{ backgroundImage: shapes.length ? 'none' : `url('${floorPlanImage}')` }"
      ref="canvasEl"
      @mousedown="onCanvasMouseDown"
      @mousemove="onCanvasMouseMove"
      @mouseup="onCanvasMouseUp"
      @mouseleave="onCanvasMouseUp"
    >
      <!-- Drawn shapes as SVG overlay -->
      <svg class="floorplan-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <g v-for="s in shapes" :key="s.id">
          <rect v-if="s.kind === 'rect'"
                :x="Math.min(s.x1, s.x2)" :y="Math.min(s.y1, s.y2)"
                :width="Math.abs(s.x2 - s.x1)" :height="Math.abs(s.y2 - s.y1)"
                class="shape-rect"
                :class="{ erasable: planMode === 'draw' && drawTool === 'erase' }"
                @click="onShapeClick(s)"/>
          <line v-else-if="s.kind === 'line'"
                :x1="s.x1" :y1="s.y1" :x2="s.x2" :y2="s.y2"
                class="shape-line"
                :class="{ erasable: planMode === 'draw' && drawTool === 'erase' }"
                @click="onShapeClick(s)"/>
          <text v-if="s.kind === 'rect' && s.label"
                :x="(s.x1 + s.x2) / 2"
                :y="(s.y1 + s.y2) / 2"
                class="shape-label"
                text-anchor="middle"
                dominant-baseline="middle">{{ s.label }}</text>
        </g>
        <!-- live-drawing preview -->
        <rect v-if="draft && draft.kind === 'rect'"
              :x="Math.min(draft.x1, draft.x2)" :y="Math.min(draft.y1, draft.y2)"
              :width="Math.abs(draft.x2 - draft.x1)" :height="Math.abs(draft.y2 - draft.y1)"
              class="shape-rect draft"/>
        <line v-if="draft && draft.kind === 'line'"
              :x1="draft.x1" :y1="draft.y1" :x2="draft.x2" :y2="draft.y2"
              class="shape-line draft"/>
      </svg>

      <div
        v-for="pin in placedPins"
        :key="pin.resource_id"
        class="floorplan-pin"
        :class="{ busy: !!getCurrentBooking(pin.resource_id), draggable: planMode === 'pins', dragging: draggingPinId === pin.resource_id }"
        :style="{ left: pin.x + '%', top: pin.y + '%' }"
        @click.stop="planMode === 'view' && pin.resource && openResource(pin.resource)"
        @mousedown.stop="planMode === 'pins' && startPinDrag(pin, $event)"
        :title="pin.resource ? `${pin.resource.Name} — ${pin.resource.Location || ''}` : pin.resource_id"
      >
        <span class="pin-icon" :style="{ background: pin.resource ? gradient(pin.resource) : '#94a3b8' }">
          <component v-if="pin.resource" :is="iconFor(pin.resource.AssetType)" :size="14" color="white"/>
        </span>
        <span class="pin-label">
          <span class="pin-name">{{ pin.resource ? pin.resource.Name : $t('admin.bookings.missingResource') }}</span>
          <span class="pin-status">
            <span v-if="getCurrentBooking(pin.resource_id)" class="dot busy"></span>
            <span v-else class="dot free"></span>
            {{ getCurrentBooking(pin.resource_id) ? $t('common.busy') : $t('common.available') }}
          </span>
        </span>
        <button v-if="planMode === 'pins'"
                class="pin-remove"
                @click.stop="removePin(pin)"
                :title="$t('admin.bookings.removePin')"
                :aria-label="$t('admin.bookings.removePin')">
          <X :size="12"/>
        </button>
      </div>

      <!-- Unplaced resources fall back to a side rail so admins can find and position them.
           In pins mode clicking a rail item drops it onto the centre of the canvas so the
           admin can then drag it to the right room. -->
      <div v-if="unplacedResources.length" class="floorplan-rail">
        <div class="rail-title">{{ $t('admin.bookings.unplaced') }}</div>
        <button v-for="resource in unplacedResources" :key="resource.ID"
                class="rail-item" @click.stop="onRailClick(resource)">
          <span class="pin-icon" :style="{ background: gradient(resource) }">
            <component :is="iconFor(resource.AssetType)" :size="12" color="white"/>
          </span>
          <span class="truncate">{{ resource.Name }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Resource detail modal (floor-plan click) -->
  <Modal v-if="selectedResource" @close="selectedResource = null" :title="selectedResource.Name">
    <div class="modal-content">
      <div class="form-group">
        <label>{{ $t('booking.resource') }}</label>
        <p>{{ selectedResource.Name }} <span class="muted">— {{ selectedResource.AssetType }}</span></p>
      </div>
      <div class="form-group" v-if="selectedResource.Location">
        <label>{{ $t('admin.resources.location') }}</label>
        <p>{{ selectedResource.Location }}</p>
      </div>
      <div class="form-group">
        <label>{{ $t('common.capacity') }}</label>
        <p>{{ selectedResource.Capacity }}</p>
      </div>
      <div class="form-group">
        <label>{{ $t('common.status') }}</label>
        <p v-if="getCurrentBooking(selectedResource.ID)">
          <span class="tag warning">{{ $t('common.busy') }}</span>
          {{ getUserDisplayName(getCurrentBooking(selectedResource.ID).UserID) }}
          <span class="muted">— {{ formatBookingTime(getCurrentBooking(selectedResource.ID)) }}</span>
        </p>
        <p v-else><span class="tag success">{{ $t('common.available') }}</span></p>
      </div>
      <div class="form-group" v-if="upcomingForResource(selectedResource.ID).length">
        <label>{{ $t('admin.bookings.upcomingToday') }}</label>
        <ul class="upcoming-list">
          <li v-for="b in upcomingForResource(selectedResource.ID)" :key="b.ID" @click="openBooking(b)">
            <span class="tag" :class="statusClass(b.Status)">{{ b.Status }}</span>
            {{ formatBookingTime(b) }} — {{ getUserDisplayName(b.UserID) }}
          </li>
        </ul>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" @click="selectedResource = null">{{ $t('common.close') }}</button>
    </div>
  </Modal>

  <!-- Empty state — only when there are no resources at all -->
  <EmptyState v-else-if="!resources.length && !loading"
              :icon="Calendar"
              :title="$t('admin.bookings.empty')"
              :description="$t('admin.bookings.emptyDesc')"/>

  <!-- Booking detail modal -->
  <Modal v-if="selectedBooking" @close="selectedBooking = null" :title="$t('admin.bookings.details')">
    <div class="modal-content">
      <div class="form-group">
        <label>{{ $t('booking.resource') }}</label>
        <p>{{ getResourceName(selectedBooking.ResourceID) }}</p>
      </div>
      <div class="form-group">
        <label>{{ $t('booking.user') }}</label>
        <p>{{ getUserDisplayName(selectedBooking.UserID) }}</p>
      </div>
      <div class="form-group">
        <label>{{ $t('booking.start') }}</label>
        <p>{{ formatDate(selectedBooking.StartTime) }}</p>
      </div>
      <div class="form-group">
        <label>{{ $t('booking.end') }}</label>
        <p>{{ formatDate(selectedBooking.EndTime) }}</p>
      </div>
      <div class="form-group">
        <label>{{ $t('booking.status') }}</label>
        <span class="tag" :class="statusClass(selectedBooking.Status)">{{ selectedBooking.Status }}</span>
      </div>
      <div class="form-group" v-if="selectedBooking.MeetingURL">
        <label>{{ $t('booking.meetingUrl') }}</label>
        <a :href="selectedBooking.MeetingURL" target="_blank" class="link">{{ selectedBooking.MeetingURL }}</a>
      </div>
    </div>
    <div class="modal-actions">
      <!-- Mark as Attended / No-Show: only roles in the server allowlist
           see these buttons (System Admin / Room Admin / Secretary).
           Buttons hide when the transition isn't valid for the current
           status so we don't tempt the user with a no-op. -->
      <button
        v-if="canMarkAttended(selectedBooking)"
        class="btn"
        :disabled="statusBusy"
        @click="markAttended(selectedBooking)"
        :title="$t('admin.bookings.attendedHelp')"
      >
        {{ $t('admin.bookings.markAttended') }}
      </button>
      <button
        v-if="canMarkNoShow(selectedBooking)"
        class="btn warning"
        :disabled="statusBusy"
        @click="markNoShow(selectedBooking)"
        :title="$t('admin.bookings.noShowHelp')"
      >
        {{ $t('admin.bookings.markNoShow') }}
      </button>
      <button class="btn ghost" @click="selectedBooking = null">{{ $t('common.close') }}</button>
    </div>
  </Modal>

  <!-- Drag-to-create booking -->
  <BookingModal v-if="draftBooking"
                :resource="draftBooking.resource"
                :date="draftBooking.date"
                :start="draftBooking.start"
                :end="draftBooking.end"
                @close="draftBooking = null"
                @booked="onDraftBooked" />
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  RefreshCcw, Calendar, LayoutGrid, Search, Truck, Wrench, Crown, DoorOpen,
  Eye, Pencil, Move, Square, Minus, Eraser, Trash2, Plus, Copy, FilePenLine, Save, X,
  MousePointerClick
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import BookingModal from '../components/BookingModal.vue'
import { api, getToken } from '../api'
import { useToastStore } from '../stores/toast'
import { useI18n } from 'vue-i18n'

// Role allowlist for "Mark as No-Show" — MUST match the server-side
// allowlist in cmd/api/main.go noShowRoles. Keeping them in lockstep
// is enforced by the audit table: a SPA-only mismatch would be caught
// the moment a denied user clicks the button (403 + audit DENIED row).
const NO_SHOW_ROLES = ['System Admin', 'Room Admin', 'Secretary']

const toasts = useToastStore()
const loading = ref(true)
const bookings = ref([])
const resources = ref([])
const users = ref([])
const editing = ref(null)
const selectedBooking = ref(null)
const selectedResource = ref(null)
const statusBusy = ref(false)

// currentRole reads the role baked into the JWT on login. Decoding here
// (rather than relying on a Pinia store) keeps the helper self-contained
// and works in test fixtures that mount the view in isolation.
function currentRole() {
  try {
    const t = getToken()
    if (!t) return ''
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role || ''
  } catch (e) { return '' }
}

// Mirrors cmd/api/main.go noShowRoles + admin_booking_status_handler.go
// roleCanMarkNoShow — keep in lockstep with the server-side allowlist.
function canActOnBookingStatus() {
  return NO_SHOW_ROLES.includes(currentRole())
}

// canMarkNoShow gates the button. Server enforces the same rules; this
// helper just keeps an obviously-invalid button from rendering.
function canMarkNoShow(b) {
  if (!b || !canActOnBookingStatus()) return false
  return b.Status === 'Confirmed' || b.Status === 'Pending Approval'
}

// canMarkAttended — Confirmed only. Pending Approval requires the
// approval flow to complete first; Cancelled / No Show / Checked In
// have no meaningful next state via this button.
function canMarkAttended(b) {
  if (!b || !canActOnBookingStatus()) return false
  return b.Status === 'Confirmed'
}

async function markNoShow(b) {
  if (!b) return
  const reason = window.prompt(
    'Reason for marking as No Show?\nThis is recorded in the tamper-evident audit log.',
    'No-show after grace period',
  )
  if (reason === null) return // user cancelled
  statusBusy.value = true
  try {
    const res = await fetch(`/api/v1/admin/bookings/${b.ID}/no-show`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    if (!res.ok) throw new Error(await res.text())
    toasts.success('Booking marked as No Show')
    selectedBooking.value = null
    await load()
  } catch (e) {
    toasts.error('Could not mark No Show', e.message)
  } finally {
    statusBusy.value = false
  }
}

async function markAttended(b) {
  if (!b) return
  statusBusy.value = true
  try {
    const res = await fetch(`/api/v1/admin/bookings/${b.ID}/attended`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new Error(await res.text())
    toasts.success('Booking marked as Attended')
    selectedBooking.value = null
    await load()
  } catch (e) {
    toasts.error('Could not mark Attended', e.message)
  } finally {
    statusBusy.value = false
  }
}
const viewMode = ref('timetable')
// The static SVG under spa/public/ is the fallback when no drawn shapes
// exist yet. Once the admin draws any rooms/walls those replace the image.
const floorPlanImage = '/floor-plan.svg'

// Floor-plan editing state. All coordinates here are in canvas units
// (the SVG viewBox is 0..100 on both axes, matching the % space the pins
// already use), so shapes and pins share one coordinate system.
//
// Persistence model: floor plans live server-side in the `floor_plans`
// table. The SPA holds the active plan in memory; shape edits flip a
// `dirty` flag and a Save action PUTs back the whole shapes array. We
// also keep a LEGACY_SHAPES_KEY around so the first load after upgrade
// migrates whatever the admin had drawn locally into the server.
const LEGACY_SHAPES_KEY = 'admin.floorplan.shapes.v1'
const planMode = ref('view')        // 'view' | 'draw' | 'pins'
const drawTool = ref('rect')        // 'rect' | 'line' | 'erase'
const shapes = ref([])
const draft = ref(null)             // shape being drawn right now
const dragStart = ref(null)         // {x, y} canvas coords at mousedown
const canvasEl = ref(null)
const draggingPinId = ref(null)
const pinDragOffset = ref({ x: 0, y: 0 })

const floorPlans = ref([])
const activePlanId = ref(null)
const planDirty = ref(false)
const planSaving = ref(false)

const activePlan = computed(() =>
  floorPlans.value.find(p => p.ID === activePlanId.value) || null
)

// Whenever the active plan changes, load its shapes + pins into the editor.
watch(activePlanId, (id) => {
  const p = floorPlans.value.find(x => x.ID === id)
  shapes.value = p ? cloneJSON(p.Shapes) : []
  pins.value = p ? cloneJSON(p.Pins) : []
  planDirty.value = false
})

// Pins live on the active floor plan (not on the resource). Declared here
// (before the watchers below) so `watch(pins, …)` doesn't hit a temporal
// dead zone during setup, which would crash the whole page.
const pins = ref([])

// Any local edit (shapes OR pins) flips the dirty flag so the Save
// button lights up. We watch the array reference + contents.
watch(shapes, () => { planDirty.value = true }, { deep: true })
watch(pins, () => { planDirty.value = true }, { deep: true })

function cloneJSON(v) {
  if (!v) return []
  if (Array.isArray(v)) return JSON.parse(JSON.stringify(v))
  // Server returns JSONB; pgx may surface it as a string in some configs.
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { return [] } }
  return []
}

async function loadFloorPlans() {
  try {
    const list = await api.listFloorPlans()
    floorPlans.value = list || []
    // Pick the default plan, or the first, or migrate from localStorage.
    let active = floorPlans.value.find(p => p.IsDefault) || floorPlans.value[0]
    if (!active) {
      // First boot for this tenant — seed a plan, migrating any legacy
      // localStorage drawing as its initial shapes.
      let legacy = []
      try { legacy = JSON.parse(localStorage.getItem(LEGACY_SHAPES_KEY) || '[]') } catch {}
      const seeded = await api.createFloorPlan({ Name: 'Floor 1', Shapes: legacy, Pins: [], IsDefault: true })
      floorPlans.value = [seeded]
      active = seeded
      try { localStorage.removeItem(LEGACY_SHAPES_KEY) } catch {}
    }
    activePlanId.value = active.ID
    shapes.value = cloneJSON(active.Shapes)
    pins.value = cloneJSON(active.Pins)
    planDirty.value = false
  } catch (e) {
    toasts.error('Could not load floor plans', e.message)
  }
}

async function savePlan() {
  const p = activePlan.value
  if (!p) return
  planSaving.value = true
  try {
    const saved = await api.updateFloorPlan(p.ID, { ...p, Shapes: shapes.value, Pins: pins.value })
    const idx = floorPlans.value.findIndex(x => x.ID === saved.ID)
    if (idx >= 0) floorPlans.value[idx] = saved
    planDirty.value = false
    toasts.success('Floor plan saved')
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { planSaving.value = false }
}

async function newPlan() {
  const name = window.prompt('Name for the new floor plan:', `Floor ${floorPlans.value.length + 1}`)
  if (!name || !name.trim()) return
  try {
    const created = await api.createFloorPlan({ Name: name.trim(), Shapes: [], Pins: [], IsDefault: false })
    floorPlans.value = [...floorPlans.value, created]
    activePlanId.value = created.ID
  } catch (e) { toasts.error('Could not create plan', e.message) }
}

async function duplicatePlan() {
  if (!activePlan.value) return
  const name = window.prompt('Name for the copy:', `${activePlan.value.Name} (copy)`)
  if (!name || !name.trim()) return
  // If there are unsaved edits, persist them first so the copy includes them.
  if (planDirty.value) await savePlan()
  try {
    const copy = await api.duplicateFloorPlan(activePlan.value.ID, name.trim())
    floorPlans.value = [...floorPlans.value, copy]
    activePlanId.value = copy.ID
    toasts.success('Floor plan duplicated')
  } catch (e) { toasts.error('Duplicate failed', e.message) }
}

async function renamePlan() {
  const p = activePlan.value
  if (!p) return
  const name = window.prompt('Rename floor plan:', p.Name)
  if (!name || !name.trim() || name.trim() === p.Name) return
  try {
    const saved = await api.updateFloorPlan(p.ID, { ...p, Name: name.trim(), Shapes: shapes.value, Pins: pins.value })
    const idx = floorPlans.value.findIndex(x => x.ID === saved.ID)
    if (idx >= 0) floorPlans.value[idx] = saved
    planDirty.value = false
  } catch (e) { toasts.error('Rename failed', e.message) }
}

async function deletePlan() {
  const p = activePlan.value
  if (!p) return
  if (floorPlans.value.length <= 1) {
    toasts.warn('Cannot delete the only floor plan')
    return
  }
  if (!confirm(`Delete floor plan "${p.Name}"? This cannot be undone.`)) return
  try {
    await api.deleteFloorPlan(p.ID)
    floorPlans.value = floorPlans.value.filter(x => x.ID !== p.ID)
    activePlanId.value = floorPlans.value[0]?.ID || null
  } catch (e) { toasts.error('Delete failed', e.message) }
}

function canvasCoords(evt) {
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  const x = clamp(((evt.clientX - rect.left) / rect.width) * 100, 0, 100)
  const y = clamp(((evt.clientY - rect.top) / rect.height) * 100, 0, 100)
  return { x, y }
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function onCanvasMouseDown(evt) {
  if (planMode.value !== 'draw') return
  if (drawTool.value === 'erase') return
  const { x, y } = canvasCoords(evt)
  dragStart.value = { x, y }
  draft.value = { kind: drawTool.value, x1: x, y1: y, x2: x, y2: y }
}

function onCanvasMouseMove(evt) {
  if (draggingPinId.value) {
    const { x, y } = canvasCoords(evt)
    const pin = pins.value.find(p => p.resource_id === draggingPinId.value)
    if (pin) {
      pin.x = clamp(x - pinDragOffset.value.x, 0, 100)
      pin.y = clamp(y - pinDragOffset.value.y, 0, 100)
    }
    return
  }
  if (!draft.value) return
  const { x, y } = canvasCoords(evt)
  draft.value.x2 = x
  draft.value.y2 = y
}

async function onCanvasMouseUp() {
  if (draggingPinId.value) {
    // Drop the drag — pin position is already updated in `pins`; the
    // Save button picks up the dirty flag and persists on click.
    draggingPinId.value = null
    return
  }
  if (!draft.value) return
  // Reject tiny shapes (likely an accidental click)
  const dx = Math.abs(draft.value.x2 - draft.value.x1)
  const dy = Math.abs(draft.value.y2 - draft.value.y1)
  if (dx < 1 && dy < 1) {
    draft.value = null
    dragStart.value = null
    return
  }
  const shape = { id: cryptoId(), ...draft.value }
  if (shape.kind === 'rect') {
    const label = window.prompt('Room label (optional):', '')
    if (label !== null && label.trim()) shape.label = label.trim()
  }
  shapes.value = [...shapes.value, shape]
  draft.value = null
  dragStart.value = null
}

function onShapeClick(s) {
  if (planMode.value === 'draw' && drawTool.value === 'erase') {
    shapes.value = shapes.value.filter(x => x.id !== s.id)
  }
}

function clearShapes() {
  if (!confirm('Clear the entire floor plan drawing? This cannot be undone.')) return
  shapes.value = []
}

function onRailClick(resource) {
  if (planMode.value === 'pins') {
    // Drop a new pin for this resource onto the centre of the canvas;
    // admin then drags it where they want. Avoid duplicates: if the
    // resource already has a pin we just no-op.
    if (pins.value.some(p => p.resource_id === resource.ID)) return
    pins.value = [...pins.value, { resource_id: resource.ID, x: 50, y: 50 }]
  } else {
    openResource(resource)
  }
}

function startPinDrag(pin, evt) {
  const { x, y } = canvasCoords(evt)
  pinDragOffset.value = { x: x - (pin.x || 0), y: y - (pin.y || 0) }
  draggingPinId.value = pin.resource_id
}

function removePin(pin) {
  pins.value = pins.value.filter(p => p.resource_id !== pin.resource_id)
}

function cryptoId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'sh_' + Math.random().toString(36).slice(2, 10)
}
const q = ref('')
const filterDate = ref('')
const filterResource = ref('')
const filterStatus = ref('')

// ---- Drag-to-create booking on the timetable ----
const todayStr = new Date().toISOString().slice(0, 10)
const bookingDate = ref(todayStr)
const dragSel = ref(null)        // { resourceId, from, to } while dragging
const draftBooking = ref(null)   // { resource, date, start, end } -> BookingModal

function isCellSelected(resourceId, hour) {
  const s = dragSel.value
  if (!s || s.resourceId !== resourceId) return false
  return hour >= Math.min(s.from, s.to) && hour <= Math.max(s.from, s.to)
}
function startCellDrag(resource, hour) {
  dragSel.value = { resourceId: resource.ID, resource, from: hour, to: hour }
}
function extendCellDrag(resource, hour) {
  if (dragSel.value && dragSel.value.resourceId === resource.ID) dragSel.value.to = hour
}
function cancelDrag() { dragSel.value = null }
function endCellDrag() {
  const s = dragSel.value
  dragSel.value = null
  if (!s) return
  const from = Math.min(s.from, s.to)
  const to = Math.max(s.from, s.to) + 1   // end is exclusive of the last slot
  draftBooking.value = {
    resource: s.resource,
    date: bookingDate.value || todayStr,
    start: String(from).padStart(2, '0') + ':00',
    end: String(to).padStart(2, '0') + ':00'
  }
}
function onDraftBooked() {
  draftBooking.value = null
  toasts.success('Booking created')
  load()
}

// Generate time slots (7 AM to 8 PM)
const timeSlots = Array.from({ length: 14 }, (_, i) => i + 7)

const displayedResources = computed(() => {
  if (!filterResource.value) return resources.value
  return resources.value.filter(r => r.ID === filterResource.value)
})

// Pins live on the active floor plan (not on the resource), so switching
// plans switches which pins appear. Each pin carries an attached
// `resource` reference for convenient template binding; a pin without a
// matching resource (e.g. the resource was deleted) renders as a faded
// grey marker labelled "missing resource". (Declared earlier, above the
// floor-plan watchers.)
const placedPins = computed(() =>
  pins.value.map(p => ({
    ...p,
    resource: resources.value.find(r => r.ID === p.resource_id) || null,
  }))
)

const unplacedResources = computed(() => {
  const placed = new Set(pins.value.map(p => p.resource_id))
  return resources.value.filter(r => !placed.has(r.ID))
})

const filteredBookings = computed(() => {
  let result = bookings.value
  if (q.value) {
    const query = q.value.toLowerCase()
    result = result.filter(b => {
      const userName = getUserDisplayName(b.UserID)?.toLowerCase() || ''
      const resourceName = getResourceName(b.ResourceID)?.toLowerCase() || ''
      return userName.includes(query) || resourceName.includes(query)
    })
  }
  if (filterDate.value) {
    const date = filterDate.value
    result = result.filter(b => b.StartTime.startsWith(date))
  }
  if (filterResource.value) {
    result = result.filter(b => b.ResourceID === filterResource.value)
  }
  if (filterStatus.value) {
    result = result.filter(b => b.Status === filterStatus.value)
  }
  return result
})

onMounted(() => { load(); loadFloorPlans() })

async function load() {
  loading.value = true
  try {
    const [bookingsData, resourcesData, usersData] = await Promise.all([
      api.listAllBookings(filterDate.value || 'all'),
      api.listResources(),
      api.listUsers()
    ])
    bookings.value = bookingsData || []
    resources.value = resourcesData || []
    users.value = usersData || []
  } catch (e) {
    toasts.error('Could not load bookings', e.message)
  } finally { loading.value = false }
}

function getBookingsForResource(resourceId, hour) {
  return filteredBookings.value.filter(b => {
    if (b.ResourceID !== resourceId) return false
    const bookingHour = new Date(b.StartTime).getHours()
    return bookingHour === hour
  })
}

function getCurrentBooking(resourceId) {
  const now = new Date()
  return filteredBookings.value.find(b => {
    if (b.ResourceID !== resourceId) return false
    if (b.Status === 'Cancelled') return false
    const start = new Date(b.StartTime)
    const end = new Date(b.EndTime)
    return now >= start && now <= end
  })
}

function getUserDisplayName(userId) {
  const user = users.value.find(u => u.ID === userId || u.id === userId)
  if (!user) return userId
  // The user record exposes Username (the API has no first/last name fields),
  // so build the label defensively: a missing field must never render the
  // literal "undefined undefined" the way `${u.FirstName} ${u.LastName}` did
  // (QA #13). Fall back through whatever identity fields are present.
  const full = [user.FirstName, user.LastName].filter(Boolean).join(' ').trim()
  return full || user.Username || user.username || user.Email || user.email || userId
}

function getResourceName(resourceId) {
  const resource = resources.value.find(r => r.ID === resourceId)
  return resource?.Name || resourceId
}

function formatHour(hour) {
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour)
  return `${h}:00 ${ampm}`
}

function formatBookingTime(booking) {
  const start = new Date(booking.StartTime)
  const end = new Date(booking.EndTime)
  const startMin = start.getMinutes()
  const endMin = end.getMinutes()
  const startH = start.getHours()
  const endH = end.getHours()
  const ampm = startH >= 12 ? 'PM' : 'AM'
  const h1 = startH > 12 ? startH - 12 : (startH === 0 ? 12 : startH)
  const h2 = endH > 12 ? endH - 12 : (endH === 0 ? 12 : endH)
  const m1 = startMin.toString().padStart(2, '0')
  const m2 = endMin.toString().padStart(2, '0')
  return `${h1}:${m1} - ${h2}:${m2} ${ampm}`
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString()
}

function statusClass(status) {
  switch (status) {
    case 'Confirmed': return 'success'
    case 'Pending Approval': return 'warning'
    case 'Cancelled': return 'danger'
    case 'Checked In': return 'brand'
    default: return ''
  }
}

function openBooking(booking) {
  selectedBooking.value = booking
}

function openResource(resource) {
  selectedResource.value = resource
}

function upcomingForResource(resourceId) {
  const now = Date.now()
  return filteredBookings.value
    .filter(b => b.ResourceID === resourceId && b.Status !== 'Cancelled' && new Date(b.EndTime).getTime() > now)
    .sort((a, b) => new Date(a.StartTime) - new Date(b.StartTime))
    .slice(0, 5)
}

function iconFor(t) {
  switch (t) {
    case 'Vehicle': return Truck
    case 'Equipment': return Wrench
    case 'Top Management': return Crown
    default: return DoorOpen
  }
}

function gradient(r) {
  if (r.CompositeMode === 'parent') return 'linear-gradient(135deg, #7c3aed, #a855f7)'
  if (r.CompositeMode === 'child')  return 'linear-gradient(135deg, #0ea5e9, #38bdf8)'
  switch (r.AssetType) {
    case 'Vehicle':        return 'linear-gradient(135deg, #2563eb, #06b6d4)'
    case 'Equipment':      return 'linear-gradient(135deg, #7c3aed, #ec4899)'
    case 'Top Management': return 'linear-gradient(135deg, #b45309, #f59e0b)'
    default:               return 'linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))'
  }
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.search { position: relative; }
.search .icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
.search input { padding-left: 36px; }

.btn.active {
  background: var(--brand-primary);
  color: white;
  border-color: var(--brand-primary);
}

/* Timetable styles */
.timetable-container {
  overflow-x: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.timetable-header {
  display: grid;
  grid-template-columns: 80px repeat(auto-fit, minmax(180px, 1fr));
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  z-index: 10;
}

.time-column {
  padding: 12px;
  border-right: 1px solid var(--border);
}

.resource-column {
  padding: 12px;
  border-right: 1px solid var(--border);
  text-align: center;
}

.resource-name {
  font-weight: 600;
  font-size: 14px;
}

.resource-meta {
  font-size: 11px;
  margin-top: 2px;
}

.timetable-body {
  display: grid;
  grid-template-columns: 80px repeat(auto-fit, minmax(180px, 1fr));
}

.time-row {
  display: contents;
}

.time-label {
  padding: 8px;
  font-size: 11px;
  color: var(--text-muted);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  text-align: right;
}

.resource-cell {
  min-height: 60px;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  padding: 4px;
  position: relative;
  cursor: pointer;
  user-select: none;
}
.resource-cell:hover { background: var(--surface-inset); }
.resource-cell .cell-hint {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  color: var(--text-muted); opacity: 0; font-size: 18px; font-weight: 600;
  transition: opacity 0.1s;
}
.resource-cell:hover .cell-hint { opacity: 0.45; }
.resource-cell.cell-selected {
  background: color-mix(in srgb, var(--brand-primary) 18%, transparent);
  box-shadow: inset 0 0 0 1px var(--brand-primary);
}
.resource-cell.cell-selected .cell-hint { opacity: 0; }

.booking-block {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 4px;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.1s;
}

.booking-block:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.booking-block.status-confirmed {
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.3);
}

.booking-block.status-pending-approval {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
}

.booking-block.status-cancelled {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  opacity: 0.6;
}

.booking-block.status-checked-in {
  background: rgba(59, 130, 246, 0.1);
  border-color: rgba(59, 130, 246, 0.3);
}

.booking-title {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 2px;
}

.booking-user {
  font-size: 10px;
}

.booking-time {
  font-size: 10px;
  color: var(--text-muted);
}

/* Floor plan styles */
.floorplan-container {
  padding: 16px;
}

.floorplan-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.toolbar-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.toolbar-sep {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 4px;
}

.plan-select {
  min-width: 160px;
  max-width: 240px;
}

.floorplan-canvas {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: var(--bg-elevated) center / contain no-repeat;
  background-color: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  user-select: none;
}

.floorplan-canvas.drawing { cursor: crosshair; }
.floorplan-canvas.moving { cursor: grab; }

.floorplan-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.shape-rect {
  fill: rgba(99, 102, 241, 0.08);
  stroke: rgba(99, 102, 241, 0.55);
  stroke-width: 0.25;
  vector-effect: non-scaling-stroke;
  pointer-events: auto;
}

.shape-line {
  stroke: #475569;
  stroke-width: 0.6;
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
  pointer-events: auto;
}

.shape-rect.draft, .shape-line.draft {
  stroke-dasharray: 1 1;
  fill: rgba(99, 102, 241, 0.15);
  pointer-events: none;
}

.shape-rect.erasable, .shape-line.erasable {
  cursor: pointer;
}
.shape-rect.erasable:hover {
  fill: rgba(239, 68, 68, 0.18);
  stroke: rgb(239, 68, 68);
}
.shape-line.erasable:hover {
  stroke: rgb(239, 68, 68);
}

.shape-label {
  fill: var(--text-muted);
  font-size: 3px;
  font-family: -apple-system, "Segoe UI", sans-serif;
  pointer-events: none;
}

.floorplan-pin {
  position: absolute;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  font: inherit;
  color: var(--text);
  transition: transform 0.1s, box-shadow 0.1s;
}

.floorplan-pin:hover {
  transform: translate(-50%, -50%) scale(1.04);
  box-shadow: 0 6px 16px rgba(0,0,0,0.18);
  z-index: 2;
}

.floorplan-pin.busy { border-color: rgba(239, 68, 68, 0.5); }

.floorplan-pin.draggable { cursor: grab; }
.floorplan-pin.dragging { cursor: grabbing; opacity: 0.85; z-index: 3; }

.pin-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgb(239, 68, 68);
  color: white;
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: 0 2px 4px rgba(0,0,0,0.15);
  padding: 0;
}
.pin-remove:hover { background: rgb(220, 38, 38); }

.pin-icon {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.pin-label {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  max-width: 160px;
}

.pin-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pin-status {
  font-size: 10px;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.dot.free { background: rgb(16, 185, 129); }
.dot.busy { background: rgb(239, 68, 68); }

.floorplan-rail {
  position: absolute;
  right: 12px;
  top: 12px;
  bottom: 12px;
  width: 200px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rail-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}

.rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
  text-align: left;
}

.rail-item:hover { background: var(--surface-inset); }

.upcoming-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.upcoming-list li {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.upcoming-list li:hover { background: var(--surface-inset); }

.modal-content {
  display: grid;
  gap: 16px;
}

.form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.form-group p {
  margin: 0;
  font-size: 14px;
}

.form-group .link {
  color: var(--brand-primary);
  text-decoration: none;
}

.form-group .link:hover {
  text-decoration: underline;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
}
</style>
