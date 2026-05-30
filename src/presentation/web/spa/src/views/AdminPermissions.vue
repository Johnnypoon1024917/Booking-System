<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('permissions.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('permissions.subtitle') }}</p>
    </div>
    <div class="row gap-sm">
      <button class="btn ghost" @click="load" :disabled="loading"><RefreshCcw :size="14"/> {{ $t('common.refresh') }}</button>
      <button class="btn ghost" @click="openNewPermission"><Plus :size="14"/> New permission</button>
      <button class="btn" @click="saveAll" :disabled="busy || !dirty"><Save :size="14"/> {{ $t('common.save') }}</button>
    </div>
  </div>

  <div v-if="loading"><Skeleton height="280px"/></div>

  <div v-else>
    <div class="banner info mb">
      <Lock :size="16"/>
      <span>{{ $t('permissions.help') }}</span>
    </div>

    <div class="card" style="padding: 0; overflow-x: auto;">
      <table class="matrix" :aria-label="$t('permissions.title')">
        <caption class="sr-only">{{ $t('permissions.subtitle') }}</caption>
        <thead>
          <tr>
            <th class="left" scope="col">{{ $t('permissions.permission') }}</th>
            <th v-for="r in roles" :key="r" class="role" scope="col" :aria-label="r">
              <Avatar :name="r" aria-hidden="true"/>
              <span>{{ r }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="g in mergedCatalog" :key="g.title">
            <tr class="group-row">
              <th colspan="99" scope="colgroup">
                <span class="group-title">{{ g.title }}</span>
                <span v-if="g.custom" class="tag info" style="margin-left: 8px;">Custom</span>
                <button v-if="g.custom" class="icon-btn" style="float: right;" type="button"
                        :aria-label="`Delete custom group ${g.title}`"
                        @click="deleteGroup(g)">
                  <Trash2 :size="13" aria-hidden="true"/>
                </button>
              </th>
            </tr>
            <tr v-for="p in g.permissions" :key="p.key">
              <th class="left" scope="row">
                <code class="perm-key">{{ p.key }}</code>
                <small class="muted block">{{ p.label }}</small>
              </th>
              <td v-for="r in roles" :key="r" class="check">
                <input
                  type="checkbox"
                  :checked="has(r, p.key)"
                  :aria-label="`${r}: ${p.label || p.key}`"
                  @change="toggle(r, p.key)"
                />
              </td>
              <td v-if="p.custom" class="check" style="width: 32px;">
                <button class="icon-btn" type="button"
                        :aria-label="`Delete custom permission ${p.key}`"
                        @click="deletePermission(p)">
                  <Trash2 :size="12" aria-hidden="true"/>
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>

  <Modal v-if="creating" @close="creating = null" title="Add a new permission">
    <p class="muted text-sm mb">
      Define a new permission key. After saving, tick the checkboxes above to grant it to roles
      and reference the key from your custom integrations or hooks.
    </p>
    <label class="field">
      <span>Key (machine-readable)</span>
      <input v-model="creating.key" placeholder="e.g. report.weekly_export" autofocus/>
      <small class="muted">Lowercase, dot-separated. Must be unique.</small>
    </label>
    <label class="field mt">
      <span>Label</span>
      <input v-model="creating.label" placeholder="Human-readable description"/>
    </label>
    <label class="field mt">
      <span>Group</span>
      <select v-model="creating.group_key">
        <option value="" disabled>Select a group…</option>
        <optgroup label="Built-in">
          <option v-for="g in builtinGroups" :key="g.key" :value="g.key">{{ g.title }}</option>
        </optgroup>
        <optgroup label="Custom" v-if="customGroups.length">
          <option v-for="g in customGroups" :key="g.key" :value="g.key">{{ g.label }}</option>
        </optgroup>
        <option value="__new__">+ Create new group…</option>
      </select>
    </label>
    <div v-if="creating.group_key === '__new__'" class="grid-2 mt">
      <label class="field">
        <span>New group key</span>
        <input v-model="creating.new_group_key" placeholder="e.g. fleet"/>
      </label>
      <label class="field">
        <span>New group label</span>
        <input v-model="creating.new_group_label" placeholder="e.g. Fleet Operations"/>
      </label>
    </div>
    <label class="field mt">
      <span>Description (optional)</span>
      <textarea rows="2" v-model="creating.description" placeholder="What does this permission allow?"></textarea>
    </label>
    <template #footer>
      <button class="btn ghost" @click="creating = null">{{ $t('common.cancel') }}</button>
      <button class="btn" :disabled="!canSubmit || busy" @click="submitNewPermission">
        <Plus :size="13"/> Add permission
      </button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCcw, Save, Lock, Plus, Trash2 } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import Avatar from '../components/Avatar.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const loading = ref(true)
const busy = ref(false)
const builtinCatalog = ref([])
const customGroups = ref([])
const customPermissions = ref([])
const matrix = ref({})
const original = ref({})
const creating = ref(null)

const roles = computed(() => Object.keys(matrix.value).sort())

// builtinGroups exposes the built-in groups in a uniform { key, title } shape
// for the "Group" select in the new-permission modal. We synthesise the key
// from the title since the server uses the title as the implicit group id.
const builtinGroups = computed(() => builtinCatalog.value.map(g => ({
  key: g.title,
  title: g.title
})))

// mergedCatalog renders the matrix in a single shape regardless of whether a
// permission is built-in or admin-defined — built-ins come first, then any
// custom groups, then a "More" bucket for orphaned custom permissions.
const mergedCatalog = computed(() => {
  const out = builtinCatalog.value.map(g => {
    const builtin = g.keys.map(k => ({ key: k, label: describe(k), custom: false }))
    const extras = customPermissions.value
      .filter(p => p.group_key === g.title)
      .map(p => ({ key: p.key, label: p.label, custom: true }))
    return {
      title: g.title,
      custom: false,
      key: g.title,
      permissions: [...builtin, ...extras]
    }
  })

  for (const g of customGroups.value) {
    out.push({
      title: g.label,
      custom: true,
      key: g.key,
      permissions: customPermissions.value
        .filter(p => p.group_key === g.key)
        .map(p => ({ key: p.key, label: p.label, custom: true }))
    })
  }

  // Custom permissions whose group has been deleted still show up so they
  // can be cleaned up from the UI.
  const orphaned = customPermissions.value.filter(p =>
    !builtinCatalog.value.some(b => b.title === p.group_key) &&
    !customGroups.value.some(g => g.key === p.group_key)
  )
  if (orphaned.length) {
    out.push({
      title: 'Uncategorised',
      custom: true,
      key: '__orphan__',
      permissions: orphaned.map(p => ({ key: p.key, label: p.label, custom: true }))
    })
  }
  return out
})

const dirty = computed(() => {
  for (const r of Object.keys(matrix.value)) {
    const a = [...matrix.value[r]].sort().join(',')
    const b = (original.value[r] || []).slice().sort().join(',')
    if (a !== b) return true
  }
  return false
})

const canSubmit = computed(() => {
  if (!creating.value) return false
  const c = creating.value
  if (!c.key?.trim() || !c.label?.trim()) return false
  if (!c.group_key) return false
  if (c.group_key === '__new__' && (!c.new_group_key?.trim() || !c.new_group_label?.trim())) return false
  return true
})

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [data, cat] = await Promise.all([
      api.getPermissions(),
      api.listPermissionCatalog().catch(() => ({ builtin: [], custom_groups: [], custom_permissions: [] }))
    ])
    builtinCatalog.value = cat.builtin || data.catalog || []
    customGroups.value = cat.custom_groups || []
    customPermissions.value = cat.custom_permissions || []

    const r = data.roles || {}
    matrix.value = {}
    original.value = {}
    for (const role of Object.keys(r)) {
      matrix.value[role] = new Set(r[role] || [])
      original.value[role] = (r[role] || []).slice()
    }
  } catch (e) { toasts.error('Could not load', e.message) }
  finally { loading.value = false }
}

function has(role, key) { return matrix.value[role]?.has(key) }
function toggle(role, key) {
  const s = matrix.value[role] || new Set()
  s.has(key) ? s.delete(key) : s.add(key)
  matrix.value[role] = new Set(s)
}

async function saveAll() {
  busy.value = true
  try {
    for (const r of Object.keys(matrix.value)) {
      const next = [...matrix.value[r]]
      const prev = (original.value[r] || []).slice().sort()
      if (next.slice().sort().join(',') !== prev.join(',')) {
        await api.setRolePermissions(r, next)
        original.value[r] = next.slice()
      }
    }
    toasts.success(t('permissions.saved'))
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

function openNewPermission() {
  creating.value = {
    key: '',
    label: '',
    description: '',
    group_key: builtinGroups.value[0]?.key || '',
    new_group_key: '',
    new_group_label: ''
  }
}

async function submitNewPermission() {
  busy.value = true
  try {
    const c = creating.value
    let groupKey = c.group_key
    if (groupKey === '__new__') {
      const g = await api.createPermissionGroup({
        key: c.new_group_key.trim(),
        label: c.new_group_label.trim()
      })
      groupKey = g.key || c.new_group_key.trim()
    }
    await api.createCustomPermission({
      key: c.key.trim(),
      label: c.label.trim(),
      group_key: groupKey,
      description: c.description?.trim() || ''
    })
    toasts.success('Permission added', `${c.key} is now available in the matrix`)
    creating.value = null
    await load()
  } catch (e) { toasts.error('Could not add permission', e.message) }
  finally { busy.value = false }
}

async function deletePermission(p) {
  if (!confirm(`Delete custom permission "${p.key}"? Roles holding it will lose access on next save.`)) return
  try {
    await api.deleteCustomPermission(p.key)
    toasts.info('Permission removed')
    await load()
  } catch (e) { toasts.error('Delete failed', e.message) }
}

async function deleteGroup(g) {
  if (!confirm(`Delete custom group "${g.title}"? Permissions inside it will move to "Uncategorised".`)) return
  try {
    await api.deletePermissionGroup(g.key)
    toasts.info('Group removed')
    await load()
  } catch (e) { toasts.error('Delete failed', e.message) }
}

const labels = {
  'booking.create':       'Create new bookings',
  'booking.cancel':       'Cancel own bookings',
  'booking.cancel_others':'Cancel anyone\'s bookings',
  'booking.update':       'Edit own bookings',
  'booking.read_all':     'See bookings across the tenant',
  'resource.create':      'Add new resources',
  'resource.update':      'Edit resource configuration',
  'resource.delete':      'Deactivate resources',
  'resource.split':       'Split a resource into sub-resources',
  'service.manage':       'Manage catering & services catalog',
  'user.create':          'Add users',
  'user.update':          'Edit user attributes',
  'user.deactivate':      'Deactivate users',
  'department.manage':    'Manage departments',
  'holiday.manage':       'Add / edit holidays',
  'holiday.import':       'Bulk-import holidays from ICS',
  'approval.decide':      'Approve / reject bookings',
  'approval.delegate':    'Re-route approvals to another approver',
  'approval.bypass':      'Bypass the approval chain',
  'approval_rule.manage': 'Edit approval rule policies',
  'webhook.manage':       'Manage webhook subscriptions',
  'integration.manage':   'Configure M365 / Google / Zoom',
  'permission.manage':    'Edit this matrix',
  'report.view':          'View reports',
  'report.export':        'Export to CSV / XLSX',
  'audit.view':           'View audit trail',
  'customization.manage': 'Edit tenant customization',
  'tenant.manage':        'Manage tenant lifecycle'
}
function describe(key) { return labels[key] || '' }
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }

.matrix {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.matrix thead th {
  position: sticky; top: 0; z-index: 1;
  background: var(--surface-inset);
  padding: 12px 14px;
  text-align: center;
  font-weight: 600; font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid var(--border);
}
.matrix th.left, .matrix td.left {
  text-align: left;
  min-width: 240px;
  padding: 10px 14px;
}
.matrix th.role {
  display: table-cell;
}
.matrix th.role :deep(.avatar) { display: inline-block; vertical-align: middle; margin-right: 6px; }

.matrix td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--divider);
  vertical-align: middle;
}
.matrix td.check { text-align: center; }
.matrix tr:hover td:not(.left) { background: var(--surface-hover); }

.group-row td {
  background: var(--surface-inset);
  border-bottom: 1px solid var(--border);
  padding: 8px 14px;
}
.group-title {
  font-size: 11px; font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.08em;
}
.perm-key {
  font-family: var(--font-mono); font-size: 12px;
  background: transparent; color: var(--text);
}
.block { display: block; margin-top: 2px; }
</style>
