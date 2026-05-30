<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('webhooks.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('webhooks.subtitle') }}</p>
    </div>
    <button class="btn" @click="openNew"><Plus :size="14"/> {{ $t('webhooks.new') }}</button>
  </div>

  <div class="tabs mb">
    <button class="tab" :class="{ active: tab === 'subs' }" @click="tab = 'subs'">
      <Webhook :size="13"/> {{ $t('webhooks.subscriptions') }}
    </button>
    <button class="tab" :class="{ active: tab === 'deliveries' }" @click="tab = 'deliveries'">
      <ListChecks :size="13"/> {{ $t('webhooks.deliveries') }}
    </button>
  </div>

  <template v-if="tab === 'subs'">
    <div v-if="loading"><Skeleton height="200px"/></div>
    <EmptyState v-else-if="!items.length" :icon="Webhook"
                :title="$t('webhooks.empty')"
                :description="$t('webhooks.emptyDesc')"/>
    <div v-else>
      <article v-for="w in items" :key="w.id" class="card hook-row mb">
        <div class="space" style="min-width:0;">
          <div class="row gap-sm" style="align-items: baseline;">
            <code class="truncate" style="font-size:13px;">{{ w.target_url }}</code>
            <span class="tag" :class="w.is_active ? 'success' : 'danger'">
              {{ w.is_active ? $t('common.active') : $t('common.inactive') }}
            </span>
          </div>
          <div class="row gap-sm mt-sm" style="flex-wrap: wrap;">
            <span v-for="e in w.events" :key="e" class="tag">{{ e }}</span>
          </div>
        </div>
        <div class="row gap-sm" style="flex-shrink: 0;">
          <button class="btn ghost sm" @click="toggle(w)">{{ w.is_active ? $t('webhooks.disable') : $t('webhooks.enable') }}</button>
          <button class="btn ghost danger sm" @click="del(w)"><Trash2 :size="13"/></button>
        </div>
      </article>
    </div>
  </template>

  <template v-else>
    <div v-if="loadingDeliveries"><Skeleton height="200px"/></div>
    <EmptyState v-else-if="!deliveries.length" :icon="ListChecks" :title="$t('webhooks.noDeliveries')"/>
    <div v-else class="card" style="padding:0;">
      <div class="d-row header">
        <div>{{ $t('webhooks.event') }}</div>
        <div>{{ $t('webhooks.target') }}</div>
        <div>{{ $t('webhooks.status') }}</div>
        <div>{{ $t('webhooks.attempts') }}</div>
        <div>{{ $t('webhooks.when') }}</div>
      </div>
      <div class="d-row" v-for="d in deliveries" :key="d.id">
        <div><code style="font-size:11px;">{{ d.event }}</code></div>
        <div class="truncate"><small class="muted">{{ d.target_url }}</small></div>
        <div>
          <span v-if="d.delivered_at" class="tag success">{{ d.last_status }}</span>
          <span v-else-if="d.attempt_count >= 5" class="tag danger" :title="d.last_error">{{ $t('webhooks.parked') }}</span>
          <span v-else class="tag warning">{{ $t('webhooks.retrying') }}</span>
        </div>
        <div class="muted text-sm">{{ d.attempt_count }}</div>
        <div class="muted text-sm">{{ relTime(d.created_at) }}</div>
      </div>
    </div>
  </template>

  <Modal v-if="editing" @close="editing = null" :title="$t('webhooks.create')">
    <label class="field">
      <span>{{ $t('webhooks.targetUrl') }}</span>
      <input v-model="editing.target_url" placeholder="https://example.com/webhooks/mrbs"/>
    </label>
    <label class="field mt">
      <span>{{ $t('webhooks.events') }}</span>
    </label>
    <p class="muted text-sm mb">{{ $t('webhooks.eventsHelp') }}</p>
    <div class="row gap-sm" style="flex-wrap: wrap;">
      <label v-for="e in eventCatalog" :key="e" class="chip">
        <input type="checkbox" :checked="editing.events.includes(e)" @change="toggleEvent(e)"/>
        {{ e }}
      </label>
    </div>
    <template #footer>
      <button class="btn ghost" @click="editing = null">{{ $t('common.cancel') }}</button>
      <button class="btn" :disabled="busy" @click="save"><Save :size="13"/> {{ $t('common.save') }}</button>
    </template>
  </Modal>

  <Modal v-if="newSecret" @close="newSecret = null" :title="$t('webhooks.secretTitle')">
    <p class="muted text-sm mb">{{ $t('webhooks.secretBody') }}</p>
    <div class="card" style="background: var(--surface-inset);">
      <code style="font-size: 13px; word-break: break-all;">{{ newSecret }}</code>
    </div>
    <p class="muted text-sm mt">{{ $t('webhooks.signatureHelp') }}</p>
    <template #footer>
      <button class="btn ghost" @click="copySecret">{{ $t('webhooks.copy') }}</button>
      <button class="btn" @click="newSecret = null">{{ $t('webhooks.gotIt') }}</button>
    </template>
  </Modal>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus, Webhook, ListChecks, Save, Trash2
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const tab = ref('subs')
const loading = ref(true)
const loadingDeliveries = ref(false)
const busy = ref(false)
const items = ref([])
const deliveries = ref([])
const editing = ref(null)
const newSecret = ref(null)

const eventCatalog = [
  'booking.created', 'booking.pending_approval', 'booking.approved',
  'booking.rejected', 'booking.updated', 'booking.cancelled',
  'weather.signal', 'broadcast'
]

onMounted(load)
watch(tab, t => { if (t === 'deliveries') loadDeliveries() })

async function load() {
  loading.value = true
  try { items.value = await api.listWebhooks() || [] }
  catch (e) { toasts.error('Could not load', e.message) }
  finally { loading.value = false }
}

async function loadDeliveries() {
  loadingDeliveries.value = true
  try { deliveries.value = await api.listWebhookDeliveries() || [] }
  catch (e) { toasts.error('Could not load', e.message) }
  finally { loadingDeliveries.value = false }
}

function openNew() {
  editing.value = {
    target_url: '',
    events: ['booking.created', 'booking.approved', 'booking.cancelled']
  }
}

function toggleEvent(e) {
  const set = new Set(editing.value.events)
  set.has(e) ? set.delete(e) : set.add(e)
  editing.value.events = [...set]
}

async function save() {
  busy.value = true
  try {
    const created = await api.createWebhook(editing.value)
    if (created.secret) newSecret.value = created.secret
    editing.value = null
    load()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function toggle(w) {
  try {
    await api.updateWebhook(w.id, { is_active: !w.is_active })
    w.is_active = !w.is_active
  } catch (e) { toasts.error('Failed', e.message) }
}

async function del(w) {
  if (!confirm(t('webhooks.confirmDelete'))) return
  try {
    await api.deleteWebhook(w.id)
    items.value = items.value.filter(x => x.id !== w.id)
  } catch (e) { toasts.error('Delete failed', e.message) }
}

async function copySecret() {
  await navigator.clipboard.writeText(newSecret.value).catch(() => {})
  toasts.success(t('webhooks.copied'))
}

function relTime(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000
  if (d < 60) return Math.round(d) + 's ago'
  if (d < 3600) return Math.round(d / 60) + 'm ago'
  if (d < 86400) return Math.round(d / 3600) + 'h ago'
  return new Date(ts).toLocaleDateString()
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.hook-row { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: var(--surface-inset); border: 1px solid var(--border); font-size: 11px; font-family: var(--font-mono); }
.chip input { width: auto; }
.d-row {
  display: grid; grid-template-columns: 1.5fr 2fr 90px 60px 100px;
  gap: 12px; padding: 12px 18px; align-items: center;
  border-bottom: 1px solid var(--divider);
}
.d-row.header {
  background: var(--surface-inset); font-size: 11px; font-weight: 600;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;
}
.d-row:last-child { border-bottom: 0; }
</style>
