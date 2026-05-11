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
  <div v-else-if="viewMode === 'timetable' && filteredBookings.length" class="timetable-container">
    <div class="timetable-header">
      <div class="time-column"></div>
      <div v-for="resource in displayedResources" :key="resource.ID" class="resource-column">
        <div class="resource-name">{{ resource.Name }}</div>
        <div class="resource-meta text-sm muted">{{ resource.Location }}</div>
      </div>
    </div>
    <div class="timetable-body">
      <div v-for="hour in timeSlots" :key="hour" class="time-row">
        <div class="time-label">{{ formatHour(hour) }}</div>
        <div v-for="resource in displayedResources" :key="resource.ID" class="resource-cell" :data-hour="hour" :data-resource="resource.ID">
          <div v-for="booking in getBookingsForResource(resource.ID, hour)" :key="booking.ID" 
               class="booking-block" 
               :class="'status-' + booking.Status.toLowerCase().replace(' ', '-')"
               @click="openBooking(booking)">
            <div class="booking-title truncate">{{ booking.Title || $t('booking.untitled') }}</div>
            <div class="booking-user text-xs muted truncate">{{ getUserDisplayName(booking.UserID) }}</div>
            <div class="booking-time text-xs">{{ formatBookingTime(booking) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Floor Plan View -->
  <div v-else-if="viewMode === 'floorplan' && resources.length" class="floorplan-container">
    <div class="floorplan-grid">
      <div v-for="resource in resources" :key="resource.ID" class="floorplan-item" @click="openResource(resource)">
        <div class="floorplan-thumb" :style="{ background: gradient(resource) }">
          <component :is="iconFor(resource.AssetType)" :size="24" color="white"/>
        </div>
        <div class="floorplan-info">
          <h4 class="truncate">{{ resource.Name }}</h4>
          <div class="text-sm muted">{{ resource.Location }}</div>
          <div class="text-sm muted">{{ $t('common.capacity') }}: {{ resource.Capacity }}</div>
        </div>
        <div class="floorplan-status">
          <div v-if="getCurrentBooking(resource.ID)" class="booking-indicator status-confirmed">
            <User :size="12"/> {{ getUserDisplayName(getCurrentBooking(resource.ID).UserID) }}
          </div>
          <div v-else class="available-indicator">
            <CheckCircle :size="12"/> {{ $t('common.available') }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Empty state -->
  <EmptyState v-else-if="!filteredBookings.length && !loading" 
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
      <button class="btn ghost" @click="selectedBooking = null">{{ $t('common.close') }}</button>
    </div>
  </Modal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  RefreshCcw, Calendar, LayoutGrid, Search, User, CheckCircle, Boxes
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const toasts = useToastStore()
const loading = ref(true)
const bookings = ref([])
const resources = ref([])
const users = ref([])
const editing = ref(null)
const selectedBooking = ref(null)
const viewMode = ref('timetable')
const q = ref('')
const filterDate = ref(new Date().toISOString().split('T')[0])
const filterResource = ref('')
const filterStatus = ref('')

// Generate time slots (7 AM to 8 PM)
const timeSlots = Array.from({ length: 14 }, (_, i) => i + 7)

const displayedResources = computed(() => {
  if (!filterResource.value) return resources.value
  return resources.value.filter(r => r.ID === filterResource.value)
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

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [bookingsData, resourcesData, usersData] = await Promise.all([
      api.listAllBookings(filterDate.value),
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
  const user = users.value.find(u => u.ID === userId)
  return user ? `${user.FirstName} ${user.LastName}`.trim() || user.Email : userId
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
  // Navigate to resource edit or show details
  console.log('Open resource:', resource)
}

function iconFor(t) {
  switch (t) {
    case 'Vehicle': return 'Truck'
    case 'Equipment': return 'Wrench'
    case 'Top Management': return 'Crown'
    default: return 'DoorOpen'
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
}

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

.floorplan-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.floorplan-item {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  display: grid;
  grid-template-columns: 48px 1fr auto;
  gap: 12px;
  align-items: center;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.1s;
}

.floorplan-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.floorplan-thumb {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  display: grid;
  place-items: center;
}

.floorplan-info {
  min-width: 0;
}

.floorplan-info h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.floorplan-status {
  text-align: right;
}

.booking-indicator, .available-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 6px;
}

.booking-indicator.status-confirmed {
  background: rgba(16, 185, 129, 0.1);
  color: rgb(16, 185, 129);
}

.available-indicator {
  background: rgba(16, 185, 129, 0.1);
  color: rgb(16, 185, 129);
}

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
