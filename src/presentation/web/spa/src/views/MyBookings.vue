<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('myBookings.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('myBookings.subtitle') }}</p>
    </div>
    <div class="row gap-sm">
      <button class="btn ghost" @click="load"><RefreshCcw :size="14"/> {{ $t('common.refresh') }}</button>
      <button class="btn" @click="$router.push('/search')"><Plus :size="14"/> {{ $t('dashboard.newBooking') }}</button>
    </div>
  </div>

  <div class="stat-strip mb" v-if="!loading && items.length">
    <div class="stat"><small>Total</small><b>{{ stats.total }}</b></div>
    <div class="stat"><small>Upcoming</small><b>{{ stats.upcoming }}</b></div>
    <div class="stat"><small>Awaiting approval</small><b>{{ stats.pending }}</b></div>
    <div class="stat"><small>Past</small><b>{{ stats.past }}</b></div>
  </div>

  <div class="row gap-sm mb">
    <button v-for="t in tabs" :key="t.key" class="btn"
            :class="filter === t.key ? '' : 'subtle'"
            @click="filter = t.key">{{ $t(t.label) }} <span class="muted" style="margin-left:6px;">{{ t.count }}</span></button>
  </div>

  <div v-if="loading">
    <div class="card mb" v-for="n in 4" :key="n"><Skeleton height="60px"/></div>
  </div>
  <EmptyState v-else-if="!filtered.length" :icon="Calendar" :title="$t('myBookings.empty')">
    <template #actions>
      <button class="btn sm" @click="$router.push('/search')">{{ $t('dashboard.createFirst') }}</button>
    </template>
  </EmptyState>

  <article v-else v-for="b in filtered" :key="b.ID" class="card my-card mb">
    <div class="strip" :style="{ background: stripColor(b.Status) }"></div>
    <div class="space" style="min-width:0;">
      <div class="row gap-sm" style="align-items: baseline;">
        <h3 class="truncate">{{ resourceName(b) }}</h3>
        <span class="tag" :class="statusClass(b.Status)">{{ b.Status }}</span>
        <span v-if="b.IsRecurring" class="tag info"><Repeat :size="11"/> {{ $t('myBookings.recurring') }}</span>
      </div>
      <div class="muted text-sm mt-sm row gap-sm" style="flex-wrap: wrap;">
        <span><CalendarDays :size="11"/> {{ formatDate(b.StartTime) }}</span>
        <span><Clock :size="11"/> {{ formatTime(b.StartTime) }} – {{ formatTime(b.EndTime) }}</span>
        <span v-if="b.RedirectURL"><Link :size="11"/>
          <a :href="b.RedirectURL" target="_blank">{{ $t('myBookings.joinMeeting') }}</a>
        </span>
      </div>
      <div v-if="(chains[b.ID] || []).length" class="mt-sm">
        <ApprovalTimeline compact :steps="chains[b.ID]" />
      </div>
    </div>
    <div class="row gap-sm" style="flex-shrink: 0;">
      <button class="btn ghost sm" v-if="canMutate(b)" @click="open(b)"><Pencil :size="13"/></button>
      <button class="btn ghost danger sm" v-if="canMutate(b)" @click="onCancel(b)"><Trash2 :size="13"/></button>
    </div>
  </article>

  <Modal v-if="editing" @close="editing = null" :title="$t('myBookings.edit')">
    <!-- Read-only context so the edit modal isn't a bare date/URL form with
         no indication of what's being edited (QA #6). -->
    <div class="edit-context muted text-sm mb">
      <div><strong>{{ editing.resourceName }}</strong></div>
      <div class="row gap-sm" style="flex-wrap:wrap;">
        <span><CalendarDays :size="11"/> {{ formatDate(editing.startISO) }}</span>
        <span class="tag" :class="statusClass(editing.status)">{{ editing.status }}</span>
      </div>
    </div>
    <label class="field">
      <span>{{ $t('booking.title') }}</span>
      <input v-model="editing.title" placeholder="e.g. Weekly Team Sync"/>
    </label>
    <div class="grid-2 mt">
      <label class="field">
        <span>{{ $t('search.start') }}</span>
        <input type="datetime-local" v-model="editing.start"/>
      </label>
      <label class="field">
        <span>{{ $t('search.end') }}</span>
        <input type="datetime-local" v-model="editing.end"/>
      </label>
    </div>
    <label class="field mt">
      <span>{{ $t('booking.meetingURL') }}</span>
      <input v-model="editing.meeting_url" placeholder="https://teams.microsoft.com/…"/>
    </label>
    <template #footer>
      <button class="btn ghost" @click="editing = null">{{ $t('common.cancel') }}</button>
      <button class="btn" :disabled="busy" @click="save"><Save :size="13"/> {{ $t('common.save') }}</button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  RefreshCcw, Plus, Calendar, CalendarDays, Clock, Link, Pencil, Trash2, Save, Repeat
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import ApprovalTimeline from '../components/ApprovalTimeline.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t, locale } = useI18n()
const toasts = useToastStore()
const items = ref([])
const resources = ref([])
const chains = ref({})
const loading = ref(true)
const busy = ref(false)
const filter = ref('upcoming')
const editing = ref(null)

const resourceMap = computed(() => Object.fromEntries(resources.value.map(r => [r.ID || r.id, r])))

const tabs = computed(() => [
  { key: 'upcoming', label: 'myBookings.upcoming', count: items.value.filter(b => bucket(b) === 'upcoming').length },
  { key: 'pending',  label: 'myBookings.pending',  count: items.value.filter(b => bucket(b) === 'pending').length  },
  { key: 'past',     label: 'myBookings.past',     count: items.value.filter(b => bucket(b) === 'past').length     }
])

const filtered = computed(() => items.value.filter(b => bucket(b) === filter.value))

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [list, res] = await Promise.all([
      api.myBookings(),
      api.listResources().catch(() => [])
    ])
    items.value = list || []
    resources.value = res || []
    // Pull chain progress for anything still awaiting approval so the
    // requester can see exactly where it is stuck.
    await Promise.all((items.value || [])
      .filter(b => b.Status === 'Pending Approval')
      .map(async b => {
        try { chains.value[b.ID] = await api.approvalChain(b.ID) || [] }
        catch { chains.value[b.ID] = [] }
      }))
  } catch (e) { toasts.error('Could not load', e.message) }
  finally { loading.value = false }
}

const stats = computed(() => {
  const counts = { total: items.value.length, upcoming: 0, pending: 0, past: 0 }
  for (const b of items.value) {
    const k = bucket(b)
    if (counts[k] != null) counts[k]++
  }
  return counts
})

function bucket(b) {
  // Cancelled / No Show bookings are inactive — they must never count as
  // "upcoming" even when their slot is still in the future. Group them with
  // past/historical so the Upcoming tab only shows actionable reservations.
  if (b.Status === 'Cancelled' || b.Status === 'No Show') return 'past'
  if (b.Status === 'Pending Approval') return 'pending'
  if (new Date(b.EndTime) < new Date()) return 'past'
  return 'upcoming'
}

function open(b) {
  editing.value = {
    ID: b.ID,
    title: b.Title || '',
    start: toLocal(b.StartTime),
    end: toLocal(b.EndTime),
    meeting_url: b.MeetingURL || '',
    // Read-only context for the modal header (QA #6).
    resourceName: resourceName(b),
    status: b.Status,
    startISO: b.StartTime
  }
}

async function save() {
  busy.value = true
  try {
    await api.updateBooking(editing.value.ID, {
      title: editing.value.title,
      start_time: new Date(editing.value.start).toISOString(),
      end_time: new Date(editing.value.end).toISOString(),
      meeting_url: editing.value.meeting_url
    })
    toasts.success(t('common.saved'))
    editing.value = null
    load()
  } catch (e) { toasts.error('Update failed', e.message) }
  finally { busy.value = false }
}

async function onCancel(b) {
  const reason = prompt(t('myBookings.cancelReason'))
  if (reason === null) return
  try {
    await api.cancelBooking(b.ID, reason || 'cancelled by user')
    toasts.success(t('myBookings.cancelled'))
    load()
  } catch (e) { toasts.error('Cancel failed', e.message) }
}

function canMutate(b) { return b.Status !== 'Cancelled' && b.Status !== 'No Show' && new Date(b.EndTime) > new Date() }
// Prefer the resource name the API now denormalises onto the booking, then
// the locally-loaded resource catalogue. Never fall back to the raw resource
// UUID — an officer who cannot list every resource would otherwise see a
// meaningless GUID as the booking heading (QA #7).
function resourceName(b) {
  const id = b.ResourceID
  return b.ResourceName || resourceMap.value[id]?.Name || resourceMap.value[id]?.name || t('booking.untitled')
}
function statusClass(s) {
  if (s === 'Confirmed' || s === 'Checked In') return 'success'
  if (s === 'Pending Approval')                 return 'warning'
  if (s === 'No Show' || s === 'Cancelled')     return 'danger'
  return ''
}
function stripColor(s) {
  if (s === 'Confirmed' || s === 'Checked In') return 'var(--success)'
  if (s === 'Pending Approval')                 return 'var(--warning)'
  if (s === 'Cancelled' || s === 'No Show')     return 'var(--text-muted)'
  return 'var(--brand-primary)'
}
function formatDate(d) { return new Date(d).toLocaleDateString(locale.value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) }
function formatTime(d) { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function toLocal(iso) {
  const d = new Date(iso)
  const tz = d.getTimezoneOffset() * 60000
  return new Date(d - tz).toISOString().slice(0, 16)
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.my-card {
  display: grid; grid-template-columns: 6px 1fr auto;
  gap: 14px; padding: 14px 18px; align-items: center;
}
.strip { width: 6px; height: 100%; min-height: 50px; border-radius: 4px; align-self: stretch; }
.btn.sm.success { background: var(--success); color: white; }

.stat-strip {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.stat {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px 14px;
  display: flex; flex-direction: column; gap: 2px;
}
.stat small {
  font-size: 10px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.stat b { font-size: 22px; font-weight: 700; color: var(--text); }
</style>
