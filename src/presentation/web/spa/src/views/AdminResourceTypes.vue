<template>
  <div>
    <div class="row" style="justify-content: space-between; align-items: flex-end;">
      <div>
        <h1 class="page-title">{{ $t('admin.resourceTypes.title') }}</h1>
        <p class="muted">{{ $t('admin.resourceTypes.subtitle') }}</p>
      </div>
      <button class="btn" @click="newType"><Plus :size="14"/> {{ $t('admin.resourceTypes.new') }}</button>
    </div>

    <div v-if="!items.length" class="empty mt-lg">
      <Boxes :size="32"/>
      <p>{{ $t('admin.resourceTypes.empty') }}</p>
    </div>

    <div v-else class="grid mt-lg" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px;">
      <div v-for="t in items" :key="t.Key" class="card hover" @click="edit(t)">
        <div class="row" style="justify-content: space-between; align-items: flex-start;">
          <div>
            <div style="font-weight:600;">{{ t.Label }}</div>
            <small class="muted">{{ t.Key }}</small>
          </div>
          <div class="col" style="text-align:right;">
            <span class="tag" :class="t.IsBuiltin ? 'info' : 'brand'">
              {{ t.IsBuiltin ? $t('admin.resourceTypes.builtin') : $t('admin.resourceTypes.custom') }}
            </span>
            <span class="tag mt-xs" :class="t.DefaultBookingMode === 'shared' ? 'warning' : ''">
              {{ t.DefaultBookingMode === 'shared'
                  ? $t('admin.resources.modeShared')
                  : $t('admin.resources.modeExclusive') }}
            </span>
          </div>
        </div>
        <div class="row gap mt-sm muted text-sm">
          <span>{{ $t('admin.resourceTypes.defaultCap') }}: {{ t.DefaultCapacity }}</span>
          <span v-if="t.DefaultRequiresApproval">· {{ $t('admin.resources.requiresApproval') }}</span>
        </div>
      </div>
    </div>

    <Modal v-if="editing" @close="editing = null" :title="editing.Key ? $t('admin.resourceTypes.edit') : $t('admin.resourceTypes.new')">
      <div class="grid-2">
        <label class="field"><span>{{ $t('admin.resourceTypes.key') }}</span>
          <input v-model="editing.Key" :disabled="!!editing.ID" placeholder="e.g. gym"/></label>
        <label class="field"><span>{{ $t('admin.resourceTypes.label') }}</span>
          <input v-model="editing.Label" placeholder="Gym room"/></label>
        <label class="field"><span>{{ $t('admin.resourceTypes.icon') }}</span>
          <input v-model="editing.Icon" placeholder="dumbbell"/></label>
        <label class="field"><span>{{ $t('admin.resourceTypes.color') }}</span>
          <input type="color" v-model="editing.Color"/></label>
        <label class="field"><span>{{ $t('admin.resourceTypes.defaultCap') }}</span>
          <input type="number" min="1" v-model.number="editing.DefaultCapacity"/></label>
        <label class="field"><span>{{ $t('admin.resourceTypes.defaultMode') }}</span>
          <select v-model="editing.DefaultBookingMode">
            <option value="exclusive">{{ $t('admin.resources.modeExclusive') }}</option>
            <option value="shared">{{ $t('admin.resources.modeShared') }}</option>
          </select></label>
      </div>
      <div class="row gap mt">
        <label class="toggle"><input type="checkbox" v-model="editing.DefaultRequiresApproval"/>
          <span>{{ $t('admin.resources.requiresApproval') }}</span></label>
        <label class="toggle"><input type="checkbox" v-model="editing.IsActive"/>
          <span>{{ $t('admin.resources.active') }}</span></label>
      </div>
      <template #footer>
        <button v-if="editing.ID && !editing.IsBuiltin" class="btn ghost danger" @click="remove">
          <Trash2 :size="13"/> {{ $t('common.delete') }}
        </button>
        <span class="space"></span>
        <button class="btn ghost" @click="editing = null">{{ $t('common.cancel') }}</button>
        <button class="btn" @click="save"><Save :size="13"/> {{ $t('common.save') }}</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { Plus, Boxes, Save, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const items = ref([])
const editing = ref(null)
const { t } = useI18n()
const toasts = useToastStore()

async function load() {
  try { items.value = await api.listResourceTypes() || [] }
  catch (e) { toasts.error('Could not load', e.message) }
}
onMounted(load)

function newType() {
  editing.value = {
    Key: '', Label: '', Icon: '', Color: '#0a1f44',
    DefaultCapacity: 4, DefaultBookingMode: 'exclusive',
    DefaultRequiresApproval: false, IsActive: true, DisplayOrder: 100
  }
}
function edit(t) { editing.value = { ...t } }

async function save() {
  try {
    if (editing.value.ID) await api.updateResourceType(editing.value.Key, editing.value)
    else                  await api.createResourceType(editing.value)
    toasts.success(t('common.saved'))
    editing.value = null
    await load()
  } catch (e) { toasts.error('Save failed', e.message) }
}

async function remove() {
  if (!confirm(t('admin.resourceTypes.confirmDelete'))) return
  try {
    await api.deleteResourceType(editing.value.Key)
    editing.value = null
    await load()
  } catch (e) { toasts.error('Delete failed', e.message) }
}
</script>
