<template>
  <Modal @close="$emit('close')" :title="resource.ID ? $t('admin.resources.edit') : $t('admin.resources.create')">
    <div class="grid-2">
      <label class="field"><span>{{ $t('admin.resources.name') }}</span><input v-model="form.Name" /></label>
      <label class="field">
        <span>{{ $t('admin.resources.type') }}</span>
        <select v-model="form.AssetType" @change="applyTypeDefaults">
          <option v-for="t in resourceTypes" :key="t.Key" :value="t.Key">{{ t.Label }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ $t('admin.resources.region') }}</span>
        <select v-model="form.Region">
          <option>Hong Kong</option><option>Kowloon</option><option>New Territories</option>
        </select>
      </label>
      <label class="field"><span>{{ $t('admin.resources.location') }}</span><input v-model="form.Location" /></label>
      <label class="field"><span>{{ $t('admin.resources.capacity') }}</span><input type="number" v-model.number="form.Capacity" min="1" /></label>
      <label class="field">
        <span>{{ $t('admin.resources.department') }}</span>
        <select v-model="form.DepartmentID">
          <option value="">—</option>
          <option v-for="d in departments" :key="d.ID" :value="d.ID">{{ d.Name }}</option>
        </select>
      </label>
    </div>

    <label class="field mt">
      <span>{{ $t('admin.resources.equipment') }}</span>
      <input :value="(form.Equipment || []).join(', ')"
             @input="form.Equipment = $event.target.value.split(',').map(s => s.trim()).filter(Boolean)"
             :placeholder="$t('admin.resources.equipmentPh')" />
    </label>

    <div class="row gap mt">
      <label class="toggle"><input type="checkbox" v-model="form.RequiresApproval"/> <span>{{ $t('admin.resources.requiresApproval') }}</span></label>
      <label class="toggle"><input type="checkbox" v-model="form.IsRestricted"/>     <span>{{ $t('admin.resources.restricted') }}</span></label>
      <label class="toggle"><input type="checkbox" v-model="form.IsActive"/>          <span>{{ $t('admin.resources.active') }}</span></label>
    </div>

    <!-- Booking mode block — gym/classroom shared bookings -->
    <div class="card mt-lg" style="background: var(--surface-inset); border: 1px dashed var(--border);">
      <h4 style="margin:0 0 6px;"><Users :size="14"/> {{ $t('admin.resources.bookingMode') }}</h4>
      <p class="muted text-sm" style="max-width:560px; margin:0 0 10px;">{{ $t('admin.resources.bookingModeHelp') }}</p>
      <div class="row gap">
        <label class="toggle">
          <input type="radio" name="bmode" value="exclusive" v-model="form.BookingMode"/>
          <span>{{ $t('admin.resources.modeExclusive') }}</span>
        </label>
        <label class="toggle">
          <input type="radio" name="bmode" value="shared" v-model="form.BookingMode"/>
          <span>{{ $t('admin.resources.modeShared') }}</span>
        </label>
      </div>
      <label v-if="form.BookingMode === 'shared'" class="field mt">
        <span>{{ $t('admin.resources.sharedCapacity') }}</span>
        <input type="number" min="2" v-model.number="form.SharedCapacity"/>
        <small class="muted">{{ $t('admin.resources.sharedCapacityHelp') }}</small>
      </label>
    </div>

    <!-- Composite block -->
    <div class="card mt-lg" style="background: var(--surface-inset); border: 1px dashed var(--border);">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <h4 style="margin:0 0 4px;"><Combine :size="14"/> {{ $t('admin.resources.compositeTitle') }}</h4>
          <p class="muted text-sm" style="max-width:480px;">{{ $t('admin.resources.compositeHelp') }}</p>
        </div>
        <span class="tag" :class="badge.cls">{{ badge.text }}</span>
      </div>

      <div v-if="form.CompositeMode === 'parent'" class="mt">
        <small class="muted">{{ $t('admin.resources.subCount', { n: form.SubResourceCount }) }}</small>
      </div>

      <div v-if="!form.ID && form.CompositeMode !== 'child'" class="mt">
        <button class="btn ghost sm" @click.prevent="showSplit = !showSplit">
          <SplitSquareVertical :size="13"/> {{ $t('admin.resources.splitAction') }}
        </button>
      </div>

      <div v-if="showSplit" class="mt">
        <div class="grid-2">
          <label class="field">
            <span>{{ $t('admin.resources.childCount') }}</span>
            <input type="number" v-model.number="splitForm.child_count" min="2" max="10"/>
          </label>
          <label class="field">
            <span>{{ $t('admin.resources.childCapacity') }}</span>
            <input type="number" v-model.number="splitForm.child_capacity" min="1"/>
          </label>
        </div>
        <label class="field mt">
          <span>{{ $t('admin.resources.childNamesOpt') }}</span>
          <textarea rows="2" :value="(splitForm.child_names || []).join('\n')"
                    @input="splitForm.child_names = $event.target.value.split('\n').map(s => s.trim()).filter(Boolean)"
                    :placeholder="$t('admin.resources.childNamesPh')"></textarea>
        </label>
        <label class="field mt">
          <span>{{ $t('admin.resources.equipment') }}</span>
          <input :value="(splitForm.child_equipment || []).join(', ')"
                 @input="splitForm.child_equipment = $event.target.value.split(',').map(s => s.trim()).filter(Boolean)" />
        </label>
        <button class="btn mt" @click.prevent="doSplit" :disabled="busy">
          <SplitSquareVertical :size="13"/> {{ $t('admin.resources.confirmSplit') }}
        </button>
      </div>
    </div>

    <!-- Operating Hours -->
    <div class="card mt-lg" style="background: var(--surface-inset); border: 1px dashed var(--border);">
      <h4 style="margin:0 0 6px;">Operating Hours</h4>
      <div v-for="day in operatingHours" :key="day.Weekday" class="day-row">
        <span class="day-name">{{ dayName(day.Weekday) }}</span>
        <label class="toggle"><input type="checkbox" v-model="day.IsClosed"/> <span>Closed</span></label>
        <div class="row gap-sm" v-if="!day.IsClosed">
          <input type="time" v-model="day.OpenTime" />
          <span>-</span>
          <input type="time" v-model="day.CloseTime" />
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn ghost danger" v-if="form.ID" @click="deactivate" :disabled="busy">
        <Trash2 :size="13"/> {{ $t('admin.resources.deactivate') }}
      </button>
      <span class="space"></span>
      <button class="btn ghost" @click="$emit('close')">{{ $t('common.cancel') }}</button>
      <button class="btn" @click="save" :disabled="busy"><Save :size="13"/> {{ $t('common.save') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.day-row {
  display: grid;
  grid-template-columns: 100px 100px 1fr;
  gap: 16px;
  align-items: center;
  padding: 8px 0;
}
.day-name {
  font-weight: 500;
}
</style>

<script setup>
import { computed, reactive, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Combine, SplitSquareVertical, Save, Trash2, Users } from 'lucide-vue-next'
import Modal from './Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const props = defineProps({ resource: Object, departments: { type: Array, default: () => [] } })
const emit = defineEmits(['close', 'saved', 'split'])

const { t } = useI18n()
const toasts = useToastStore()
// Apply sane defaults so unsaved fields don't post as null/undefined
const form = reactive({
  BookingMode: 'exclusive',
  SharedCapacity: 1,
  ...props.resource
})
const busy = ref(false)
const showSplit = ref(false)
const splitForm = reactive({
  child_count: 3, child_capacity: 4, child_names: [], child_equipment: []
})
// Tenant-defined resource types (gym, studio, parking, …). Falls back to the
// 4 built-ins if the catalog endpoint isn't reachable yet.
const resourceTypes = ref([
  { Key: 'Room', Label: 'Meeting room' },
  { Key: 'Vehicle', Label: 'Vehicle' },
  { Key: 'Equipment', Label: 'Equipment' },
  { Key: 'Top Management', Label: 'Senior management' }
])

const operatingHours = ref([])





function dayName(weekday) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday]
}

function createDefaultHours() {
  const hours = []
  for (let i = 0; i < 7; i++) {
    hours.push({
      Weekday: i,
      IsClosed: i === 0 || i === 6,
      OpenTime: '09:00',
      CloseTime: '17:00'
    })
  }
  return hours
}

onMounted(async () => {
  try {
    const list = await api.listResourceTypes()
    if (Array.isArray(list) && list.length) resourceTypes.value = list
  } catch { /* keep fallback */ }
  if (props.resource.ID) {
    try {
      const hours = await api.getOperatingHours(props.resource.ID)
      if (hours && hours.length) {
        operatingHours.value = hours.map(h => ({
          ...h,
          OpenTime: h.OpenTime.slice(0, 5),
          CloseTime: h.CloseTime.slice(0, 5)
        }))
      } else {
        operatingHours.value = createDefaultHours()
      }
    } catch (e) {
      toasts.error('Could not load operating hours', e.message)
      operatingHours.value = createDefaultHours()
    }
  } else {
    operatingHours.value = createDefaultHours()
  }
})

function applyTypeDefaults() {
  const def = resourceTypes.value.find(t => t.Key === form.AssetType)
  if (!def) return
  if (!form.ID) {
    if (def.DefaultCapacity)        form.Capacity = def.DefaultCapacity
    if (def.DefaultBookingMode)     form.BookingMode = def.DefaultBookingMode
    form.RequiresApproval = !!def.DefaultRequiresApproval
    if (def.DefaultBookingMode === 'shared' && !form.SharedCapacity) {
      form.SharedCapacity = def.DefaultCapacity || 10
    }
  }
}

const badge = computed(() => {
  if (form.CompositeMode === 'parent') return { cls: 'brand', text: t('admin.resources.parent') }
  if (form.CompositeMode === 'child')  return { cls: 'info',  text: t('admin.resources.child') }
  return { cls: '', text: t('admin.resources.standalone') }
})

async function save() {
  busy.value = true
  try {
    let resourceId = form.ID
    if (resourceId) {
      await api.updateResource(resourceId, form)
    } else {
      const newResource = await api.createResource(form)
      resourceId = newResource.ID
    }

    const hoursToSave = operatingHours.value.map(h => ({
      ...h,
      ResourceID: resourceId
    }))
    await api.setOperatingHours(resourceId, hoursToSave)

    toasts.success(t('admin.resources.saved'))
    emit('saved')
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function deactivate() {
  if (!confirm(t('admin.resources.confirmDeactivate'))) return
  busy.value = true
  try {
    await api.deactivateResource(form.ID)
    toasts.success(t('admin.resources.deactivated'))
    emit('saved')
  } catch (e) { toasts.error('Failed', e.message) }
  finally { busy.value = false }
}

async function doSplit() {
  if (!form.ID) {
    toasts.warn(t('admin.resources.saveFirst'))
    return
  }
  busy.value = true
  try {
    const res = await api.splitResource(form.ID, splitForm)
    emit('split', res)
  } catch (e) { toasts.error('Split failed', e.message) }
  finally { busy.value = false }
}
</script>
