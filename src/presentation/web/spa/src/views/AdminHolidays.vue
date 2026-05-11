<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('admin.holidays.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('admin.holidays.subtitle') }}</p>
    </div>
    <div class="row gap-sm">
      <input ref="fileInput" type="file" accept=".ics" hidden @change="onFile"/>
      <button class="btn ghost" @click="fileInput.click()"><Upload :size="14"/> {{ $t('admin.holidays.importIcs') }}</button>
      <button class="btn ghost" @click="syncHK" :disabled="busy"><Globe :size="14"/> {{ $t('admin.holidays.syncHK') }}</button>
      <button class="btn" @click="openNew"><Plus :size="14"/> {{ $t('admin.holidays.new') }}</button>
    </div>
  </div>

  <div class="row gap-sm mb">
    <select v-model="year" style="width: 120px;">
      <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
    </select>
    <small class="muted">{{ $t('admin.holidays.count', { n: filtered.length }) }}</small>
  </div>

  <div v-if="loading"><Skeleton height="200px"/></div>

  <div v-else class="card" style="padding:0;">
    <div class="hol-row header">
      <div>{{ $t('admin.holidays.date') }}</div>
      <div>{{ $t('admin.holidays.description') }}</div>
      <div>{{ $t('admin.holidays.blocks') }}</div>
      <div></div>
    </div>
    <EmptyState v-if="!filtered.length" :icon="CalendarOff" :title="$t('admin.holidays.empty')"/>
    <div v-else class="hol-row" v-for="h in filtered" :key="h.ID">
      <div>
        <b>{{ formatDate(h.HolidayDate) }}</b>
        <small class="muted" style="display:block;">{{ weekday(h.HolidayDate) }}</small>
      </div>
      <div>{{ h.Description }}</div>
      <div>
        <span class="tag" :class="h.IsBlocker ? 'danger' : ''">
          {{ h.IsBlocker ? $t('admin.holidays.blocking') : $t('admin.holidays.advisory') }}
        </span>
      </div>
      <div><button class="btn subtle sm" @click="open(h)"><Pencil :size="13"/></button></div>
    </div>
  </div>

  <Modal v-if="editing" @close="editing = null" :title="editing.ID ? $t('admin.holidays.edit') : $t('admin.holidays.create')">
    <label class="field">
      <span>{{ $t('admin.holidays.date') }}</span>
      <input type="date" v-model="editing.date"/>
    </label>
    <label class="field mt">
      <span>{{ $t('admin.holidays.description') }}</span>
      <input v-model="editing.description" placeholder="National Day"/>
    </label>
    <label class="toggle mt">
      <input type="checkbox" v-model="editing.is_blocker"/>
      <span>{{ $t('admin.holidays.blockerHelp') }}</span>
    </label>
    <template #footer>
      <button class="btn ghost danger" v-if="editing.ID" @click="del" :disabled="busy">
        <Trash2 :size="13"/> {{ $t('common.delete') }}
      </button>
      <span class="space"></span>
      <button class="btn ghost" @click="editing = null">{{ $t('common.cancel') }}</button>
      <button class="btn" @click="save" :disabled="busy"><Save :size="13"/> {{ $t('common.save') }}</button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Upload, Globe, CalendarOff, Pencil, Save, Trash2 } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t, locale } = useI18n()
const toasts = useToastStore()
const loading = ref(true)
const busy = ref(false)
const items = ref([])
const editing = ref(null)
const fileInput = ref(null)
const year = ref(new Date().getFullYear())

const years = computed(() => {
  const ys = new Set([year.value])
  items.value.forEach(h => ys.add(new Date(h.HolidayDate).getFullYear()))
  return [...ys].sort()
})
const filtered = computed(() => items.value
  .filter(h => new Date(h.HolidayDate).getFullYear() === year.value)
  .sort((a, b) => new Date(a.HolidayDate) - new Date(b.HolidayDate))
)

onMounted(load)

async function load() {
  loading.value = true
  try { items.value = await api.listHolidays() || [] }
  catch (e) { toasts.error('Could not load', e.message) }
  finally { loading.value = false }
}

function open(h) {
  editing.value = {
    ID: h.ID,
    date: new Date(h.HolidayDate).toISOString().slice(0, 10),
    description: h.Description,
    is_blocker: h.IsBlocker
  }
}
function openNew() {
  editing.value = { date: new Date().toISOString().slice(0, 10), description: '', is_blocker: true }
}

async function save() {
  busy.value = true
  try {
    if (editing.value.ID) await api.updateHoliday(editing.value.ID, editing.value)
    else                  await api.createHoliday(editing.value)
    toasts.success(t('common.saved'))
    editing.value = null
    load()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function del() {
  if (!confirm(t('admin.holidays.confirmDelete'))) return
  busy.value = true
  try {
    await api.deleteHoliday(editing.value.ID)
    editing.value = null
    load()
  } catch (e) { toasts.error('Delete failed', e.message) }
  finally { busy.value = false }
}

async function syncHK() {
  busy.value = true
  try {
    const r = await api.syncHKHolidays()
    toasts.success(t('admin.syncDone', r))
    load()
  } catch (e) { toasts.error('Sync failed', e.message) }
  finally { busy.value = false }
}

async function onFile(e) {
  const file = e.target.files[0]
  if (!file) return
  busy.value = true
  try {
    const r = await api.importICSHolidays(file)
    toasts.success(t('admin.syncDone', r))
    load()
  } catch (err) { toasts.error('Import failed', err.message) }
  finally { busy.value = false; e.target.value = '' }
}

function formatDate(d) { return new Date(d).toLocaleDateString(locale.value, { day: '2-digit', month: 'short', year: 'numeric' }) }
function weekday(d)    { return new Date(d).toLocaleDateString(locale.value, { weekday: 'long' }) }
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.hol-row {
  display: grid; grid-template-columns: 160px 1fr 130px 60px;
  gap: 14px; padding: 14px 18px; align-items: center;
  border-bottom: 1px solid var(--divider);
}
.hol-row.header {
  background: var(--surface-inset); font-size: 11px; font-weight: 600;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;
}
.hol-row:last-child { border-bottom: 0; }
@media (max-width: 700px) {
  .hol-row { grid-template-columns: 1fr; }
  .hol-row.header { display: none; }
}
</style>
