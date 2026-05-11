<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('admin.departments.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('admin.departments.subtitle') }}</p>
    </div>
    <button class="btn" @click="openNew"><Plus :size="14"/> {{ $t('admin.departments.new') }}</button>
  </div>

  <div v-if="loading">
    <div class="card mb" v-for="n in 4" :key="n"><Skeleton height="40px"/></div>
  </div>
  <EmptyState v-else-if="!items.length" :icon="Building" :title="$t('admin.departments.empty')"/>
  <div v-else>
    <div class="card hover dept-row" v-for="d in items" :key="d.ID" @click="open(d)">
      <div class="badge" :style="{ background: hue(d.Name) }">{{ initials(d.Name) }}</div>
      <div class="space">
        <div style="font-weight: 500;">{{ d.Name }}</div>
        <small class="muted">{{ d.Code || '—' }}</small>
      </div>
      <ChevronRight :size="16" class="muted"/>
    </div>
  </div>

  <Modal v-if="editing" @close="editing = null" :title="editing.ID ? $t('admin.departments.edit') : $t('admin.departments.create')">
    <label class="field"><span>{{ $t('admin.departments.name') }}</span><input v-model="editing.Name"/></label>
    <label class="field mt"><span>{{ $t('admin.departments.code') }}</span><input v-model="editing.Code" placeholder="OPS / TRN / ADM"/></label>
    <label class="field mt">
      <span>{{ $t('admin.departments.parent') }}</span>
      <select v-model="editing.ParentID">
        <option value="">—</option>
        <option v-for="d in items.filter(x => x.ID !== editing.ID)" :key="d.ID" :value="d.ID">{{ d.Name }}</option>
      </select>
    </label>
    <template #footer>
      <button class="btn ghost danger" v-if="editing.ID" @click="del" :disabled="busy"><Trash2 :size="13"/> {{ $t('common.delete') }}</button>
      <span class="space"></span>
      <button class="btn ghost" @click="editing = null">{{ $t('common.cancel') }}</button>
      <button class="btn" @click="save" :disabled="busy"><Save :size="13"/> {{ $t('common.save') }}</button>
    </template>
  </Modal>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { Plus, Building, ChevronRight, Save, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const loading = ref(true)
const items = ref([])
const editing = ref(null)
const busy = ref(false)

onMounted(load)
async function load() {
  loading.value = true
  try { items.value = await api.listDepartments() || [] }
  catch (e) { toasts.error('Failed', e.message) }
  finally { loading.value = false }
}
function open(d) { editing.value = JSON.parse(JSON.stringify(d)) }
function openNew() { editing.value = { Name: '', Code: '', ParentID: '' } }
async function save() {
  busy.value = true
  try {
    if (editing.value.ID) await api.updateDepartment(editing.value.ID, editing.value)
    else                  await api.createDepartment(editing.value)
    toasts.success(t('common.saved'))
    editing.value = null; load()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}
async function del() {
  if (!confirm(t('admin.departments.confirmDelete'))) return
  busy.value = true
  try {
    await api.deleteDepartment(editing.value.ID)
    toasts.success(t('common.done'))
    editing.value = null; load()
  } catch (e) { toasts.error('Delete failed', e.message) }
  finally { busy.value = false }
}

function initials(s) { return (s || '').split(/\s+/).map(p => p[0]).join('').slice(0,2).toUpperCase() }
function hue(s) {
  let h = 0; for (const c of s) h = (h*31 + c.charCodeAt(0)) >>> 0
  return `linear-gradient(135deg, hsl(${h%360} 60% 45%), hsl(${(h+30)%360} 70% 55%))`
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.dept-row { display: grid; grid-template-columns: 36px 1fr auto; gap: 14px; align-items: center; margin-bottom: 8px; cursor: pointer; }
.badge { width: 36px; height: 36px; border-radius: 10px; color: white; font-weight: 600; font-size: 12px; display: grid; place-items: center; }
</style>
