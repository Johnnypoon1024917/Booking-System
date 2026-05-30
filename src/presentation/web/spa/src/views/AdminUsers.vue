<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('admin.users.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('admin.users.subtitle') }}</p>
    </div>
    <button class="btn" @click="openNew"><Plus :size="14"/> {{ $t('admin.users.new') }}</button>
  </div>

  <div class="card mb">
    <div class="search" style="max-width:360px;">
      <Search class="icon" :size="14"/>
      <input v-model="q" :placeholder="$t('admin.users.searchPh')" />
    </div>
  </div>

  <div v-if="loading">
    <div class="card mb" v-for="n in 5" :key="n"><Skeleton height="48px"/></div>
  </div>
  <EmptyState v-else-if="!filtered.length" :icon="Users" :title="$t('admin.users.empty')"/>

  <div v-else class="card" style="padding:0; overflow:hidden;">
    <div class="user-row header">
      <div>{{ $t('admin.users.user') }}</div>
      <div>{{ $t('admin.users.role') }}</div>
      <div>{{ $t('admin.users.regions') }}</div>
      <div>{{ $t('admin.users.status') }}</div>
      <div></div>
    </div>
    <div class="user-row" v-for="u in filtered" :key="u.ID">
      <div class="row gap" style="min-width:0;">
        <Avatar :name="u.Username"/>
        <div style="min-width:0;">
          <div class="truncate" style="font-weight: 500;">{{ u.Username }}</div>
          <small class="muted truncate" style="display:block;">{{ u.DN || '—' }}</small>
        </div>
      </div>
      <div><span class="tag brand">{{ u.Role }}</span></div>
      <div class="muted text-sm">
        <span v-for="r in u.RegionAccess || []" :key="r" class="tag">{{ r }}</span>
        <span v-if="!(u.RegionAccess || []).length">—</span>
      </div>
      <div>
        <span class="tag" :class="u.IsActive ? 'success' : 'danger'">{{ u.IsActive ? $t('common.active') : $t('common.inactive') }}</span>
      </div>
      <div><button class="btn subtle sm" @click="open(u)"><Pencil :size="13"/></button></div>
    </div>
  </div>

  <Modal v-if="editing" @close="editing = null" :title="editing.ID ? $t('admin.users.edit') : $t('admin.users.create')">
    <div class="grid-2">
      <label class="field"><span>{{ $t('admin.users.username') }}</span><input v-model="editing.Username"/></label>
      <label class="field"><span>{{ $t('admin.users.dn') }}</span><input v-model="editing.DN" placeholder="CN=..."/></label>
      <label class="field">
        <span>{{ $t('admin.users.role') }}</span>
        <select v-model="editing.Role">
          <option>System Admin</option><option>Security Admin</option><option>Room Admin</option>
          <option>General User</option><option>Secretary</option>
        </select>
      </label>
      <label class="field"><span>{{ $t('admin.users.grade') }}</span><input v-model="editing.Grade" placeholder="SDO / DGFS / …"/></label>
      <label class="field">
        <span>{{ editing.ID ? $t('admin.users.password') : $t('admin.users.initialPassword') }}
          <span v-if="editing.ID" class="muted">{{ $t('admin.users.passwordKeepHint') }}</span></span>
        <input type="password" v-model="editing.password" autocomplete="new-password"/>
      </label>
    </div>

    <label class="toggle mt">
      <input type="checkbox" v-model="editing.must_change_password"/>
      <span>{{ $t('admin.users.forceReset') }}</span>
    </label>
    <label class="field mt">
      <span>{{ $t('admin.users.regions') }}</span>
      <input :value="(editing.RegionAccess || []).join(', ')"
             @input="editing.RegionAccess = $event.target.value.split(',').map(s => s.trim()).filter(Boolean)"
             placeholder="Hong Kong, Kowloon, New Territories"/>
    </label>

    <!-- Department membership: many-to-many via user_departments join.
         Editing.DepartmentIDs is normalised to an empty array on open
         so v-model with the checkbox `value` always behaves; missing
         memberships are explicitly cleared on save with an empty array
         (not nil), which the backend reads as "wipe membership". -->
    <div class="field mt">
      <span>Departments</span>
      <div v-if="!departments.length" class="muted text-sm">
        No departments configured yet — add some on the Departments admin page.
      </div>
      <div v-else class="dep-grid">
        <label v-for="d in departments" :key="d.ID" class="dep-chip">
          <input type="checkbox"
                 :value="d.ID"
                 v-model="editing.DepartmentIDs" />
          <span>{{ d.Name }}<span v-if="d.Code" class="muted text-sm"> · {{ d.Code }}</span></span>
        </label>
      </div>
    </div>

    <label class="toggle mt">
      <input type="checkbox" v-model="editing.IsActive"/>
      <span>{{ $t('admin.users.activeAccount') }}</span>
    </label>
    <template #footer>
      <button class="btn ghost danger" v-if="editing.ID" @click="deactivate" :disabled="busy">
        <Trash2 :size="13"/> {{ $t('admin.users.deactivate') }}
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
import { Plus, Search, Users, Pencil, Save, Trash2 } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Avatar from '../components/Avatar.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const loading = ref(true)
const items = ref([])
const departments = ref([])
const editing = ref(null)
const q = ref('')
const busy = ref(false)

const filtered = computed(() => items.value.filter(u =>
  !q.value || u.Username?.toLowerCase().includes(q.value.toLowerCase()) || u.DN?.toLowerCase().includes(q.value.toLowerCase())
))

onMounted(() => { load(); loadDepartments() })

async function load() {
  loading.value = true
  try { items.value = await api.listUsers() || [] }
  catch (e) { toasts.error('Could not load users', e.message) }
  finally { loading.value = false }
}

async function loadDepartments() {
  try { departments.value = await api.listDepartments() || [] }
  catch { /* non-fatal — the modal degrades to "no departments configured" */ }
}

function open(u) {
  // Deep-clone the row + normalise DepartmentIDs to a real array. The
  // backend omits the field on users with no memberships, and v-model
  // on a checkbox needs an array (not undefined) or vue can't push to
  // it on first click.
  const clone = JSON.parse(JSON.stringify(u))
  clone.DepartmentIDs = Array.isArray(clone.DepartmentIDs) ? clone.DepartmentIDs : []
  editing.value = clone
}
function openNew() {
  editing.value = { Username: '', DN: '', Role: 'General User', Grade: '', RegionAccess: [], DepartmentIDs: [], IsActive: true, password: '', must_change_password: true }
}

async function save() {
  busy.value = true
  try {
    if (editing.value.ID) await api.updateUser(editing.value.ID, editing.value)
    else                  await api.createUser(editing.value)
    toasts.success(t('common.saved'))
    editing.value = null
    load()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function deactivate() {
  if (!confirm(t('admin.users.confirmDeactivate'))) return
  busy.value = true
  try {
    await api.deactivateUser(editing.value.ID)
    toasts.success(t('common.done'))
    editing.value = null
    load()
  } catch (e) { toasts.error('Failed', e.message) }
  finally { busy.value = false }
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.search { position: relative; }
.search .icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none; }
.search input { padding-left: 36px; }

.user-row {
  display: grid; grid-template-columns: 1.6fr 1fr 1.5fr 0.8fr 60px;
  gap: 14px; padding: 14px 18px; align-items: center;
  border-bottom: 1px solid var(--divider);
}
.user-row.header {
  background: var(--surface-inset); font-size: 11px; font-weight: 600;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;
}
.user-row:last-child { border-bottom: 0; }
@media (max-width: 700px) {
  .user-row { grid-template-columns: 1fr; }
  .user-row.header { display: none; }
}

/* Department checkbox grid in the Edit User modal. Auto-fill so 1-2
   departments stay readable while larger sets wrap into a tidy 2-3
   column block. */
.dep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  margin-top: 6px;
}
.dep-chip {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
  font-size: 13px;
}
.dep-chip:hover { background: var(--surface-inset); }
.dep-chip input { margin: 0; }
</style>
