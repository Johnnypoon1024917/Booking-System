<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('admin.resources.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('admin.resources.subtitle') }}</p>
    </div>
    <div class="row gap-sm">
      <button class="btn ghost" @click="load"><RefreshCcw :size="14"/> {{ $t('common.refresh') }}</button>
      <button class="btn" @click="openNew"><Plus :size="14"/> {{ $t('admin.resources.new') }}</button>
    </div>
  </div>

  <div class="stat-strip mb" v-if="!loading && items.length">
    <div class="stat"><small>Total</small><b>{{ stats.total }}</b></div>
    <div class="stat"><small>Active</small><b>{{ stats.active }}</b></div>
    <div class="stat"><small>Approval required</small><b>{{ stats.approval }}</b></div>
    <div class="stat"><small>Restricted</small><b>{{ stats.restricted }}</b></div>
    <div class="stat" v-for="(n, type) in stats.byType" :key="type">
      <small>{{ type }}</small><b>{{ n }}</b>
    </div>
  </div>

  <div class="card mb">
    <div class="row gap" style="flex-wrap: wrap;">
      <div class="search" style="flex:1; max-width:360px;">
        <Search class="icon" :size="14"/>
        <input v-model="q" :placeholder="$t('admin.resources.searchPh')" />
      </div>
      <select v-model="filterType" style="width: auto;">
        <option value="">{{ $t('admin.resources.allTypes') }}</option>
        <option>Room</option><option>Vehicle</option><option>Equipment</option><option>Top Management</option>
      </select>
      <select v-model="filterRegion" style="width: auto;">
        <option value="">{{ $t('admin.resources.allRegions') }}</option>
        <option v-for="r in regions" :key="r">{{ r }}</option>
      </select>
    </div>
  </div>

  <div v-if="loading">
    <div class="card mb" v-for="n in 4" :key="n"><Skeleton height="48px"/></div>
  </div>
  <EmptyState v-else-if="!filtered.length" :icon="Boxes"
              :title="$t('admin.resources.empty')"
              :description="$t('admin.resources.emptyDesc')"/>

  <div v-else>
    <div class="card hover resource-row" v-for="r in filtered" :key="r.ID" @click="open(r)">
      <div class="thumb" :style="{ background: gradient(r) }">
        <component :is="iconFor(r.AssetType)" :size="18" color="white"/>
      </div>
      <div class="space" style="min-width:0;">
        <div class="row gap-sm" style="align-items: baseline;">
          <h3 class="truncate">{{ r.Name }}</h3>
          <span v-if="r.CompositeMode === 'parent'" class="tag brand">
            <Combine :size="11"/> {{ $t('admin.resources.parent') }} · {{ r.SubResourceCount }}
          </span>
          <span v-else-if="r.CompositeMode === 'child'" class="tag info">
            <SplitSquareVertical :size="11"/> {{ $t('admin.resources.child') }}
          </span>
          <span v-if="r.RequiresApproval" class="tag warning">{{ $t('search.approval') }}</span>
          <span v-if="r.IsRestricted" class="tag danger">{{ $t('search.restricted') }}</span>
          <span v-if="!r.IsActive" class="tag">{{ $t('common.inactive') }}</span>
        </div>
        <div class="muted text-sm mt-sm row gap-sm" style="flex-wrap: wrap;">
          <span><Building2 :size="11"/> {{ r.Location }}</span>
          <span><MapPin :size="11"/> {{ r.Region }}</span>
          <span><Users :size="11"/> {{ r.Capacity }}</span>
        </div>
      </div>
      <ChevronRight :size="16" class="muted"/>
    </div>
  </div>

  <ResourceEditor v-if="editing" :resource="editing" :departments="departments"
                  @close="editing = null" @saved="onSaved" @split="onSplit"/>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  RefreshCcw, Plus, Search, Boxes, Combine, SplitSquareVertical,
  Building2, MapPin, Users, ChevronRight,
  DoorOpen, Truck, Wrench, Crown
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import ResourceEditor from '../components/ResourceEditor.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const toasts = useToastStore()
const loading = ref(true)
const items = ref([])
const departments = ref([])
const editing = ref(null)
const q = ref('')
const filterType = ref('')
const filterRegion = ref('')

const regions = computed(() => [...new Set(items.value.map(r => r.Region).filter(Boolean))])

const stats = computed(() => {
  const byType = {}
  let active = 0, approval = 0, restricted = 0
  for (const r of items.value) {
    if (r.IsActive !== false) active++
    if (r.RequiresApproval) approval++
    if (r.IsRestricted) restricted++
    if (r.AssetType) byType[r.AssetType] = (byType[r.AssetType] || 0) + 1
  }
  return { total: items.value.length, active, approval, restricted, byType }
})

const filtered = computed(() => items.value.filter(r =>
  (!q.value || r.Name?.toLowerCase().includes(q.value.toLowerCase()) || r.Location?.toLowerCase().includes(q.value.toLowerCase())) &&
  (!filterType.value || r.AssetType === filterType.value) &&
  (!filterRegion.value || r.Region === filterRegion.value)
))

onMounted(load)

async function load() {
  loading.value = true
  try {
    items.value = await api.listResources() || []
    departments.value = await api.listDepartments() || []
  } catch (e) {
    toasts.error('Could not load resources', e.message)
  } finally { loading.value = false }
}

function open(r) { editing.value = JSON.parse(JSON.stringify(r)) }
function openNew() {
  editing.value = {
    Name: '', AssetType: 'Room', Region: 'Hong Kong', Location: '', Capacity: 4,
    Equipment: [], IsActive: true, RequiresApproval: false, IsRestricted: false,
    CompositeMode: '', SubResourceCount: 1, ParentResourceID: '', DepartmentID: ''
  }
}
function onSaved() { editing.value = null; load() }
function onSplit({ children }) {
  toasts.success('Split created', `${children.length} child resources added`)
  editing.value = null
  load()
}

function iconFor(t) {
  switch (t) {
    case 'Vehicle':        return Truck
    case 'Equipment':      return Wrench
    case 'Top Management': return Crown
    default:               return DoorOpen
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

.resource-row { display: grid; grid-template-columns: 44px 1fr auto; gap: 14px; align-items: center; margin-bottom: 8px; }
.thumb { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; }

.stat-strip {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
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
