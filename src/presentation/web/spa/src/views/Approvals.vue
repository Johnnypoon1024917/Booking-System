<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('approvals.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('approvals.subtitle') }}</p>
    </div>
    <button class="btn ghost" @click="load"><RefreshCcw :size="14"/> {{ $t('common.refresh') }}</button>
  </div>

  <div class="stat-strip mb" v-if="!loading && items.length">
    <div class="stat"><small>Pending</small><b>{{ stats.pending }}</b></div>
    <div class="stat"><small>Multi-step chains</small><b>{{ stats.chained }}</b></div>
    <div class="stat"><small>Today</small><b>{{ stats.today }}</b></div>
    <div class="stat"><small>This week</small><b>{{ stats.week }}</b></div>
  </div>

  <div v-if="loading">
    <div class="card mb" v-for="n in 3" :key="n"><Skeleton height="84px"/></div>
  </div>
  <EmptyState v-else-if="!items.length" :icon="ShieldCheck"
              :title="$t('approvals.empty')"
              :description="$t('approvals.emptyDesc')"/>
  <div v-else>
    <article v-for="b in items" :key="b.ID" class="card approval-card mb">
      <div class="thumb">
        <Clock :size="18" color="white"/>
      </div>
      <div class="space" style="min-width:0;">
        <div class="row gap-sm" style="align-items: baseline;">
          <h3 class="truncate">{{ resourceName(b.ResourceID) }}</h3>
          <span class="tag warning">{{ b.Status }}</span>
          <span v-if="(chains[b.ID] || []).length > 0" class="tag info">
            <GitBranch :size="11"/>
            {{ $t('approvals.chainStep', { current: currentStep(b.ID), total: (chains[b.ID] || []).length }) }}
          </span>
        </div>
        <div class="muted text-sm mt-sm row gap-sm" style="flex-wrap: wrap;">
          <span><CalendarDays :size="11"/> {{ formatDate(b.StartTime) }}</span>
          <span><Clock :size="11"/> {{ formatTime(b.StartTime) }} – {{ formatTime(b.EndTime) }}</span>
          <span><User :size="11"/> {{ requester(b) }}</span>
        </div>

        <!-- Chain progress strip -->
        <div v-if="(chains[b.ID] || []).length > 0" class="chain-strip mt">
          <div v-for="(s, i) in chains[b.ID]" :key="s.ID" class="chain-step" :class="s.Status">
            <div class="dot">
              <Check v-if="s.Status === 'approved'" :size="10"/>
              <X v-else-if="s.Status === 'rejected'" :size="10"/>
              <span v-else>{{ i + 1 }}</span>
            </div>
            <span class="label">{{ s.LevelName }}</span>
          </div>
        </div>

        <div v-if="b.MeetingURL" class="muted text-sm mt-sm">
          <Link :size="11"/> {{ b.MeetingURL }}
        </div>
      </div>
      <div class="row gap-sm" style="flex-shrink: 0;">
        <button class="btn ghost danger" :disabled="busyId === b.ID" @click="onReject(b)">
          <X :size="13"/> {{ $t('approvals.reject') }}
        </button>
        <button class="btn success" :disabled="busyId === b.ID" @click="onApprove(b)">
          <Check :size="13"/> {{ $t('approvals.approve') }}
        </button>
      </div>
    </article>
  </div>

  <Modal v-if="rejecting" @close="rejecting = null" :title="$t('approvals.rejectTitle')">
    <p class="muted text-sm mb">{{ $t('approvals.rejectHelp') }}</p>
    <label class="field">
      <span>{{ $t('approvals.reason') }}</span>
      <textarea rows="3" v-model="rejectReason" :placeholder="$t('approvals.reasonPh')"></textarea>
    </label>
    <template #footer>
      <button class="btn ghost" @click="rejecting = null">{{ $t('common.cancel') }}</button>
      <button class="btn danger" :disabled="!rejectReason || busy" @click="confirmReject">
        <X :size="13"/> {{ $t('approvals.reject') }}
      </button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  RefreshCcw, ShieldCheck, Clock, CalendarDays, User, Check, X, Link, GitBranch
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t, locale } = useI18n()
const toasts = useToastStore()
const items = ref([])
const resources = ref([])
const users = ref([])
// chains[bookingID] = [{ ID, LevelName, Status, ApproverRole, … }]
const chains = ref({})
const loading = ref(true)
const busy = ref(false)
const busyId = ref(null)
const rejecting = ref(null)
const rejectReason = ref('')

const resourceMap = computed(() => Object.fromEntries(resources.value.map(r => [r.ID, r])))
const userMap = computed(() => Object.fromEntries(users.value.map(u => [u.ID, u])))

const stats = computed(() => {
  const now = new Date()
  const todayStr = now.toDateString()
  const weekAgo = new Date(now.getTime() - 7 * 86400000)
  let chained = 0, today = 0, week = 0
  for (const b of items.value) {
    if ((chains.value[b.ID] || []).length > 0) chained++
    const start = new Date(b.StartTime)
    if (start.toDateString() === todayStr) today++
    if (start >= weekAgo) week++
  }
  return { pending: items.value.length, chained, today, week }
})

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [list, res, usrs] = await Promise.all([
      api.listApprovals(),
      api.listResources().catch(() => []),
      api.listUsers().catch(() => [])
    ])
    items.value = list || []
    resources.value = res || []
    users.value = usrs || []
    // Best-effort fetch chain steps for each booking — failures are silent
    // because most bookings won't have a chain.
    await Promise.all((items.value || []).map(async b => {
      try { chains.value[b.ID] = await api.approvalChain(b.ID) || [] }
      catch { chains.value[b.ID] = [] }
    }))
  } catch (e) { toasts.error('Could not load', e.message) }
  finally { loading.value = false }
}

function resourceName(id) { return resourceMap.value[id]?.Name || id }
function requester(b) {
  const u = userMap.value[b.UserID]
  return u?.Username || b.UserID || '—'
}
function formatDate(d) { return new Date(d).toLocaleDateString(locale.value, { weekday: 'short', month: 'short', day: 'numeric' }) }
function formatTime(d) { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }

// currentStep returns the 1-based index of the first pending step, or the
// total length if every step is decided.
function currentStep(bookingID) {
  const steps = chains.value[bookingID] || []
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].Status === 'pending') return i + 1
  }
  return steps.length
}

async function onApprove(b) {
  busyId.value = b.ID
  try {
    await api.approveBooking(b.ID, '')
    toasts.success(t('approvals.approved'))
    // If chain → reload to show progress; if single-level → drop the row.
    if ((chains.value[b.ID] || []).length > 0) await load()
    else items.value = items.value.filter(x => x.ID !== b.ID)
  } catch (e) { toasts.error('Approval failed', e.message) }
  finally { busyId.value = null }
}

function onReject(b) { rejecting.value = b; rejectReason.value = '' }

async function confirmReject() {
  busy.value = true
  busyId.value = rejecting.value.ID
  try {
    await api.rejectBooking(rejecting.value.ID, rejectReason.value)
    toasts.success(t('approvals.rejected'))
    items.value = items.value.filter(x => x.ID !== rejecting.value.ID)
    rejecting.value = null
  } catch (e) { toasts.error('Reject failed', e.message) }
  finally { busy.value = false; busyId.value = null }
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.approval-card {
  display: grid; grid-template-columns: 44px 1fr auto;
  gap: 14px; align-items: center;
}
.thumb {
  width: 44px; height: 44px; border-radius: 12px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--warning), color-mix(in srgb, var(--warning) 60%, var(--brand-secondary)));
}
@media (max-width: 700px) {
  .approval-card { grid-template-columns: 1fr; }
}

.chain-strip {
  display: flex; align-items: center; gap: 0;
  padding: 8px 0;
}
.chain-step {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--text-muted);
  padding-right: 14px; position: relative;
}
.chain-step:not(:last-child)::after {
  content: ''; position: absolute; right: 4px; top: 50%;
  width: 6px; height: 1px; background: var(--border);
}
.chain-step .dot {
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--surface-inset); border: 1px solid var(--border);
  display: grid; place-items: center;
  font-size: 10px; font-weight: 600; color: var(--text-muted);
}
.chain-step.approved .dot { background: var(--success); color: white; border-color: var(--success); }
.chain-step.rejected .dot { background: var(--danger);  color: white; border-color: var(--danger); }
.chain-step.pending  .dot { background: var(--brand-primary); color: white; border-color: var(--brand-primary); }
.chain-step.pending  .label { color: var(--text); font-weight: 500; }

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
