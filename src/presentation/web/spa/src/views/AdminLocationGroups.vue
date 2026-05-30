<template>
  <div class="mrbs">
    <h1 class="fsd-page-title">Room Privilege</h1>

    <!-- Organisation hierarchy diagram -->
    <div class="panel">
      <div class="ph"><span>Organisation Hierarchy</span></div>
      <div class="pb" style="overflow-x:auto;">
        <div class="hier">
          <div class="node">User Groups</div>
          <div class="vbar" />
          <div class="tier">
            <div class="branch" v-for="loc in locationTree" :key="loc.name">
              <div class="node sm">{{ loc.name }}</div>
              <div class="vbar" />
              <div class="leaves drop-zone"
                   :class="{ over: dropTarget === loc.name }"
                   @dragover.prevent="dropTarget = loc.name"
                   @dragleave="dropTarget = (dropTarget === loc.name ? null : dropTarget)"
                   @drop="onRoomDrop(loc.name)">
                <div class="node sm room" v-for="rm in loc.rooms" :key="rm.id"
                     draggable="true" @dragstart="onRoomDragStart(rm.id)" :title="'Drag to move ' + rm.name">
                  ⠿ {{ rm.name }}
                </div>
                <div class="node sm" v-if="!loc.rooms.length" style="opacity:.6;">Drop room here</div>
              </div>
            </div>
          </div>
        </div>
        <p class="muted text-sm mt">Drag a room between locations to reassign it. Changes are saved immediately.</p>
      </div>
    </div>

    <!-- Manage Locations -->
    <div class="panel">
      <div class="ph"><span>Locations</span></div>
      <div class="pb">
        <div class="row gap-sm mb" style="flex-wrap:wrap; align-items:flex-end;">
          <label class="fld" style="margin:0; min-width:200px;">
            <span>New location name</span>
            <input v-model="newLoc.name" placeholder="e.g. FSD HQ Tower 18/F" @keydown.enter="addLocationEntity" />
          </label>
          <label class="fld" style="margin:0; min-width:160px;">
            <span>Region (optional)</span>
            <input v-model="newLoc.region" placeholder="e.g. Hong Kong" @keydown.enter="addLocationEntity" />
          </label>
          <button class="mrbs-btn" @click="addLocationEntity"><Plus :size="14" /> Add location</button>
        </div>
        <table class="lt" v-if="locations.length">
          <thead><tr><th>Name</th><th>Region</th><th style="width:120px;">Rooms</th><th style="width:70px;"></th></tr></thead>
          <tbody>
            <tr v-for="l in locations" :key="l.ID">
              <td>{{ l.Name }}</td>
              <td>{{ l.Region || '—' }}</td>
              <td>{{ roomCountFor(l.Name) }}</td>
              <td><button class="ic del" title="Delete" @click="removeLocationEntity(l)"><Trash2 :size="14" /></button></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted text-sm">No locations yet. Add one above — it will appear in the hierarchy and the resource editor.</p>
      </div>
    </div>

    <!-- System Privilege Assignment Matrix -->
    <div class="panel">
      <div class="ph"><span>System Privilege Assignment Matrix</span></div>
      <div class="pb" style="padding:0; overflow-x:auto;">
        <table class="pmatrix">
          <thead>
            <tr>
              <th style="width:240px;">User Role Profile Group</th>
              <th>Assigned Location Scope</th>
              <th style="width:260px;">Workflow Approval Logic</th>
              <th style="width:90px;"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in roleMatrix" :key="row.role">
              <td><strong>{{ row.role }}</strong></td>
              <td>
                <div class="chips" style="border:0; padding:0;">
                  <span v-for="(l,i) in row.scope" :key="l" class="chip">{{ l }}<button @click="row.scope.splice(i,1)"><X :size="11"/></button></span>
                  <select class="loc-add" @change="addScope(row, $event)">
                    <option value="">+ add location</option>
                    <option v-for="l in allLocations.filter(x=>!row.scope.includes(x))" :key="l" :value="l">{{ l }}</option>
                    <option value="__ALL__">All Floors / Locations</option>
                  </select>
                </div>
              </td>
              <td>
                <select v-model="row.workflow">
                  <option>Direct Automatic Approval</option>
                  <option>One-Layer Supervisor Review</option>
                  <option>VIP Restricted Authentication</option>
                </select>
              </td>
              <td>
                <button class="mrbs-btn" style="padding:5px 10px;font-size:12px;" :disabled="row.busy" @click="saveRole(row)">Save</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="muted text-sm" style="padding:10px 14px;">
          Maps Active Directory role profiles to location scope and the approval workflow applied to their bookings.
        </p>
      </div>
    </div>

    <!-- Location User Groups table -->
    <div class="panel">
      <div class="ph">
        <span>Location User Groups</span>
        <button class="mrbs-btn" @click="openEdit(null)"><Plus :size="14" /> Create</button>
      </div>
      <div class="pb" style="padding:0;">
        <div class="lt-toolbar" style="padding:10px 14px;">
          <div class="row gap-sm">
            <span class="muted text-sm">Show</span>
            <select v-model.number="pageSize" class="mini-sel"><option>10</option><option>25</option><option>50</option></select>
            <span class="muted text-sm">entries</span>
          </div>
          <input v-model="q" class="srch" placeholder="Search…" />
        </div>
        <table class="lt">
          <thead><tr><th>Name</th><th>Filter By</th><th>Approver Email</th><th>Location(s)</th><th>Status</th><th style="width:90px;">Actions</th></tr></thead>
          <tbody>
            <tr v-for="g in paged" :key="g.id">
              <td>{{ g.name }}</td>
              <td>{{ g.filterBy }}</td>
              <td>{{ g.approvers.join(', ') || '—' }}</td>
              <td>{{ g.locations.join(', ') || '—' }}</td>
              <td><span class="badge" :class="g.status === 'Active' ? 'on' : 'off'">{{ g.status }}</span></td>
              <td>
                <button class="ic" title="Edit" @click="openEdit(g)"><Pencil :size="14" /></button>
                <button class="ic del" title="Delete" @click="remove(g)"><Trash2 :size="14" /></button>
              </td>
            </tr>
            <tr v-if="!paged.length"><td colspan="6" style="text-align:center; color:var(--asl-grey); padding:24px;">No groups defined</td></tr>
          </tbody>
        </table>
        <div class="lt-toolbar" style="padding:10px 14px;">
          <span class="muted text-sm">Showing {{ filtered.length ? (page-1)*pageSize+1 : 0 }} to {{ Math.min(page*pageSize, filtered.length) }} of {{ filtered.length }} entries</span>
          <div class="row gap-sm">
            <button class="mrbs-btn ghost" :disabled="page<=1" @click="page--">Previous</button>
            <span class="pg">{{ page }}</span>
            <button class="mrbs-btn ghost" :disabled="page*pageSize>=filtered.length" @click="page++">Next</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit drawer -->
    <div v-if="editing" class="overlay" @click.self="editing = null">
      <div class="modal mrbs" style="width:min(560px,calc(100vw - 32px));">
        <header><h3>{{ editing.id ? 'Edit' : 'Create' }} Location User Group</h3>
          <button class="icon-btn" @click="editing = null"><X :size="16" /></button></header>
        <section>
          <label class="fld"><span>Name</span><input v-model="editing.name" placeholder="e.g. test group" /></label>
          <label class="fld">
            <span>Filter By</span>
            <select v-model="editing.filterBy"><option>Whitelist</option><option>Channel</option><option>Department</option></select>
          </label>

          <label class="fld" style="margin-bottom:6px;"><span>Location Users</span></label>
          <div class="row gap-sm mb">
            <label class="mrbs-btn ghost" style="cursor:pointer;">
              <Upload :size="14" /> Choose file…
              <input type="file" accept=".csv,.xlsx" style="display:none" @change="onFile" />
            </label>
            <a class="muted text-sm" href="#" @click.prevent>Download import template</a>
            <span v-if="editing.fileName" class="muted text-sm">{{ editing.fileName }}</span>
          </div>

          <label class="fld" style="margin-bottom:6px;"><span>Approver Email(s)</span></label>
          <div class="chips mb">
            <span v-for="(a,i) in editing.approvers" :key="a" class="chip">{{ a }}<button @click="editing.approvers.splice(i,1)"><X :size="11"/></button></span>
            <input v-model="approverInput" placeholder="add email + Enter" @keydown.enter.prevent="addApprover" />
          </div>

          <label class="fld" style="margin-bottom:6px;">
            <span>Assigned Location(s)
              <span class="muted">— {{ editing.locations.length }} selected</span>
            </span>
          </label>
          <div class="loc-checklist mb">
            <label class="loc-allrow">
              <input type="checkbox"
                     :checked="allLocations.length && editing.locations.length === allLocations.length"
                     @change="toggleAllLocations($event)" />
              <b>Select all locations</b>
            </label>
            <label v-for="l in allLocations" :key="l" class="loc-item">
              <input type="checkbox" :value="l"
                     :checked="editing.locations.includes(l)"
                     @change="toggleLocation(l, $event)" />
              <span class="space">{{ l }}</span>
              <small class="muted">{{ regionFor(l) }}</small>
            </label>
            <div v-if="!allLocations.length" class="muted text-sm" style="padding:8px;">
              No locations defined yet — add some in the Locations panel.
            </div>
          </div>

          <label class="fld">
            <span>Status</span>
            <select v-model="editing.status"><option>Active</option><option>Inactive</option></select>
          </label>
        </section>
        <footer>
          <button class="mrbs-btn ghost" @click="editing = null">Cancel</button>
          <button class="mrbs-btn" @click="save">Save</button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Plus, Pencil, Trash2, X, Upload } from 'lucide-vue-next'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const toasts = useToastStore()

const groups = ref([])
const loading = ref(false)
const resources = ref([])
const departments = ref([])
const q = ref('')
const page = ref(1)
const pageSize = ref(10)
const editing = ref(null)
const approverInput = ref('')

// Privilege matrix — one location-group row per AD role, name-prefixed so
// it persists through the same backend without a new model.
const ROLE_PREFIX = 'role:'
const DEFAULT_ROLES = [
  'FSD Administrative Officer', 'Regional Station Crew', 'Special Emergency Unit',
  'System Admin', 'Security Admin', 'Room Admin', 'Secretary', 'General User'
]
const roleMatrix = ref([])

// Location names come from the managed list; fall back to whatever
// resources already reference so the UI is never empty pre-migration.
const allLocations = computed(() => {
  const managed = locations.value.map(l => l.Name).filter(Boolean)
  if (managed.length) return [...new Set(managed)]
  return [...new Set(resources.value.map(r => r.Location || r.location).filter(Boolean))]
})

const locationTree = computed(() => {
  // One node per managed location (shown even with zero rooms), plus an
  // "Unassigned" bucket for resources whose label isn't a managed location.
  const order = allLocations.value.slice()
  const map = {}
  for (const name of order) map[name] = []
  for (const r of resources.value) {
    const loc = r.Location || r.location || ''
    const key = (loc && map[loc] !== undefined) ? loc : 'Unassigned'
    if (map[key] === undefined) map[key] = []
    map[key].push({ id: r.ID || r.id, name: r.Name || r.name })
  }
  const names = [...order]
  if (map['Unassigned'] !== undefined && !names.includes('Unassigned')) names.push('Unassigned')
  return names.map(name => ({ name, rooms: map[name] || [] }))
})

function roomCountFor(name) {
  return resources.value.filter(r => (r.Location || r.location) === name).length
}

const dragRoomId = ref(null)
const dropTarget = ref(null)
function onRoomDragStart(id) { dragRoomId.value = id }
function onRoomDrop(locName) {
  dropTarget.value = null
  const id = dragRoomId.value
  dragRoomId.value = null
  if (!id) return
  const res = resources.value.find(r => (r.ID || r.id) === id)
  if (!res) return
  const current = res.Location || res.location
  if (current === locName) return
  const updated = { ...res, Location: locName, location: locName }
  api.updateResource(id, updated)
    .then(() => {
      res.Location = locName
      if ('location' in res) res.location = locName
      toasts.success('Moved', `${res.Name || res.name} → ${locName}`)
    })
    .catch(e => toasts.error('Move failed', e.message))
}

const filtered = computed(() => {
  const s = q.value.toLowerCase()
  return groups.value
    .filter(g => !g.name.startsWith(ROLE_PREFIX))
    .filter(g => !s || g.name.toLowerCase().includes(s) || g.filterBy.toLowerCase().includes(s))
})
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

onMounted(async () => {
  try {
    resources.value = await api.listResources().catch(() => api.roomCatalog().catch(() => []))
    departments.value = await api.listDepartments().catch(() => [])
  } catch { /* non-fatal */ }
  await loadLocations()
  await reload()
})

// ---- Managed locations (first-class, admin-CRUD) ----
const locations = ref([])
const newLoc = reactive({ name: '', region: '' })
async function loadLocations() {
  try { locations.value = await api.listLocations() }
  catch { locations.value = [] }
}
async function addLocationEntity() {
  if (!newLoc.name.trim()) { toasts.error('Location name required'); return }
  try {
    await api.createLocation({ Name: newLoc.name.trim(), Region: newLoc.region.trim() })
    newLoc.name = ''; newLoc.region = ''
    await loadLocations()
    toasts.success('Location added')
  } catch (e) { toasts.error('Add failed', e.message) }
}
async function removeLocationEntity(l) {
  if (!confirm(`Delete location "${l.Name}"? Rooms keep their label but it leaves the managed list.`)) return
  try {
    await api.deleteLocation(l.ID)
    await loadLocations()
    toasts.success('Location deleted')
  } catch (e) { toasts.error('Delete failed', e.message) }
}

async function reload() {
  loading.value = true
  try {
    const list = await api.listLocationGroups()
    groups.value = (list || []).map(g => ({
      id: g.ID,
      name: g.Name,
      filterBy: g.FilterBy || 'Whitelist',
      approvers: Array.isArray(g.Approvers) ? g.Approvers : [],
      locations: Array.isArray(g.Locations) ? g.Locations : [],
      status: g.Status || 'Active'
    }))
    buildRoleMatrix()
  } catch (e) {
    toasts.error('Could not load location groups', e.message)
  } finally {
    loading.value = false
  }
}

function buildRoleMatrix() {
  const byRole = {}
  for (const g of groups.value) {
    if (g.name.startsWith(ROLE_PREFIX)) byRole[g.name.slice(ROLE_PREFIX.length)] = g
  }
  const roles = [...new Set([...DEFAULT_ROLES, ...Object.keys(byRole)])]
  roleMatrix.value = roles.map(role => {
    const g = byRole[role]
    return {
      role,
      id: g?.id || '',
      scope: g ? [...g.locations] : [],
      workflow: g?.filterBy || 'Direct Automatic Approval',
      busy: false
    }
  })
}

function addScope(row, e) {
  const v = e.target.value
  if (v === '__ALL__') row.scope = ['All Floors / Locations']
  else if (v && !row.scope.includes(v)) row.scope.push(v)
  e.target.value = ''
}

async function saveRole(row) {
  row.busy = true
  try {
    const payload = {
      Name: ROLE_PREFIX + row.role,
      FilterBy: row.workflow,
      Approvers: [],
      Locations: row.scope,
      Status: 'Active'
    }
    if (row.id) await api.updateLocationGroup(row.id, payload)
    else await api.createLocationGroup(payload)
    toasts.success('Privilege saved', row.role)
    await reload()
  } catch (e) {
    toasts.error('Save failed', e.message)
  } finally {
    row.busy = false
  }
}

function toPayload(g) {
  return {
    Name: g.name,
    FilterBy: g.filterBy,
    Approvers: g.approvers || [],
    Locations: g.locations || [],
    Status: g.status
  }
}

function openEdit(g) {
  editing.value = g
    ? JSON.parse(JSON.stringify(g))
    : { id: '', name: '', filterBy: 'Whitelist', approvers: [], locations: [], status: 'Active', fileName: '' }
  approverInput.value = ''
}
function addApprover() {
  const v = approverInput.value.trim()
  if (v && !editing.value.approvers.includes(v)) editing.value.approvers.push(v)
  approverInput.value = ''
}
function toggleLocation(name, e) {
  const set = new Set(editing.value.locations)
  if (e.target.checked) set.add(name); else set.delete(name)
  editing.value.locations = [...set]
}
function toggleAllLocations(e) {
  editing.value.locations = e.target.checked ? [...allLocations.value] : []
}
function regionFor(name) {
  const l = locations.value.find(x => x.Name === name)
  return l && l.Region ? l.Region : ''
}
function onFile(e) { editing.value.fileName = e.target.files?.[0]?.name || '' }

async function save() {
  if (!editing.value.name.trim()) { toasts.error('Name is required'); return }
  try {
    if (editing.value.id) {
      await api.updateLocationGroup(editing.value.id, toPayload(editing.value))
    } else {
      await api.createLocationGroup(toPayload(editing.value))
    }
    toasts.success('Location user group saved')
    editing.value = null
    await reload()
  } catch (e) {
    toasts.error('Save failed', e.message)
  }
}
async function remove(g) {
  if (!confirm(`Delete group "${g.name}"?`)) return
  try {
    await api.deleteLocationGroup(g.id)
    toasts.success('Group deleted')
    await reload()
  } catch (e) {
    toasts.error('Delete failed', e.message)
  }
}
</script>

<style scoped>
.badge { font-size: 11px; padding: 3px 9px; border-radius: 3px; font-weight: 600; }
.badge.on { background: var(--asl-ok-bg); color: var(--asl-ok); }
.badge.off { background: #f1f3f5; color: var(--asl-grey); }
.ic { border: 0; background: none; cursor: pointer; color: var(--asl-blue); padding: 4px; }
.ic.del { color: var(--asl-bad); }
.srch, .mini-sel { padding: 5px 8px; border: 1px solid var(--asl-line); border-radius: 3px; font: inherit; font-size: 13px; }
.pg { background: var(--asl-blue); color: #fff; padding: 4px 10px; border-radius: 3px; font-size: 13px; }
.loc-add { border: 0; background: none; font: inherit; font-size: 13px; color: var(--asl-blue); cursor: pointer; }
.modal header { display: flex; justify-content: space-between; align-items: center; }
.leaves.drop-zone { min-width: 96px; min-height: 34px; padding: 4px; border-radius: 4px; border: 1px dashed transparent; }
.leaves.drop-zone.over { border-color: var(--asl-blue); background: var(--asl-blue-soft); }
.node.sm.room { cursor: grab; }
.node.sm.room:active { cursor: grabbing; }
.loc-checklist { border: 1px solid var(--asl-line); border-radius: 4px; max-height: 220px; overflow-y: auto; }
.loc-checklist .loc-allrow,
.loc-checklist .loc-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 13px; border-bottom: 1px solid var(--asl-line); }
.loc-checklist .loc-allrow { background: #f6f8fb; position: sticky; top: 0; }
.loc-checklist .loc-item:last-child { border-bottom: 0; }
.loc-checklist .space { flex: 1; }
.loc-checklist input[type=checkbox] { width: auto; }
</style>
