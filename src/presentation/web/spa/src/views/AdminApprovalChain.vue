<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('approvalChain.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('approvalChain.subtitle') }}</p>
    </div>
    <button class="btn" @click="openNew"><Plus :size="14"/> {{ $t('approvalChain.newRule') }}</button>
  </div>

  <div v-if="loading">
    <div class="card mb" v-for="n in 3" :key="n"><Skeleton height="80px"/></div>
  </div>
  <EmptyState v-else-if="!rules.length" :icon="GitBranch"
              :title="$t('approvalChain.empty')"
              :description="$t('approvalChain.emptyDesc')"/>
  <div v-else>
    <article v-for="r in rules" :key="r.ID" class="card hover rule-card mb" @click="open(r)">
      <div class="prio">{{ r.Priority }}</div>
      <div class="space" style="min-width:0;">
        <div class="row gap-sm" style="align-items: baseline;">
          <h3 class="truncate">{{ r.Name }}</h3>
          <span class="tag info">{{ r.ScopeType }}<span v-if="r.ScopeValue">: {{ r.ScopeValue }}</span></span>
          <span v-if="!r.IsActive" class="tag">{{ $t('common.inactive') }}</span>
        </div>
        <div class="muted text-sm mt-sm row gap-sm" style="flex-wrap: wrap;">
          <span v-for="(lvl, i) in r.Levels" :key="i" class="level-pill">
            <span class="num">{{ i + 1 }}</span> {{ lvl.name }}
            <small>{{ describeLevel(lvl) }}</small>
          </span>
          <ArrowRight :size="11" v-if="r.Levels.length === 0"/>
        </div>
      </div>
      <ChevronRight :size="16" class="muted"/>
    </article>
  </div>

  <Modal v-if="editing" @close="editing = null"
         :title="editing.ID ? $t('approvalChain.editRule') : $t('approvalChain.newRule')">
    <div class="grid-2">
      <label class="field"><span>{{ $t('approvalChain.name') }}</span><input v-model="editing.Name"/></label>
      <label class="field">
        <span>{{ $t('approvalChain.priority') }}</span>
        <input type="number" v-model.number="editing.Priority" min="1" max="999"/>
      </label>
      <label class="field">
        <span>{{ $t('approvalChain.scopeType') }}</span>
        <select v-model="editing.ScopeType">
          <option value="asset_type">{{ $t('approvalChain.scope.assetType') }}</option>
          <option value="resource">{{ $t('approvalChain.scope.resource') }}</option>
          <option value="department">{{ $t('approvalChain.scope.department') }}</option>
          <option value="tenant">{{ $t('approvalChain.scope.tenant') }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ $t('approvalChain.scopeValue') }}</span>
        <select v-if="editing.ScopeType === 'asset_type'" v-model="editing.ScopeValue">
          <option>Room</option><option>Vehicle</option><option>Equipment</option><option>Top Management</option>
        </select>
        <select v-else-if="editing.ScopeType === 'resource'" v-model="editing.ScopeValue">
          <option value="">—</option>
          <option v-for="r in resources" :key="r.ID" :value="r.ID">{{ r.Name }}</option>
        </select>
        <select v-else-if="editing.ScopeType === 'department'" v-model="editing.ScopeValue">
          <option value="">—</option>
          <option v-for="d in departments" :key="d.ID" :value="d.ID">{{ d.Name }}</option>
        </select>
        <input v-else v-model="editing.ScopeValue" disabled placeholder="(tenant-wide)"/>
      </label>
    </div>

    <div class="mt-lg">
      <label class="field"><span>{{ $t('approvalChain.levels') }}</span></label>
      <div v-for="(lvl, i) in editing.Levels" :key="i" class="card mb level-card">
        <div class="row" style="justify-content: space-between; align-items: flex-start;">
          <div class="row gap-sm" style="align-items: baseline;">
            <span class="num">{{ i + 1 }}</span>
            <input v-model="lvl.name" :placeholder="$t('approvalChain.levelName')" style="font-weight: 600; max-width: 280px;"/>
          </div>
          <button class="btn ghost danger sm" @click="removeLevel(i)"><Trash2 :size="13"/></button>
        </div>
        <div class="grid-2 mt">
          <label class="field">
            <span>{{ $t('approvalChain.approverRole') }}</span>
            <select v-model="lvl.approver_role">
              <option value="">—</option>
              <option>System Admin</option><option>Security Admin</option><option>Room Admin</option><option>Secretary</option>
            </select>
          </label>
          <label class="field">
            <span>{{ $t('approvalChain.minGrade') }}</span>
            <input v-model="lvl.min_grade" placeholder="SDO / DGFS"/>
          </label>
          <label class="field" style="grid-column: 1 / -1;">
            <span>{{ $t('approvalChain.specificApprovers') }}</span>
            <select multiple v-model="lvl.approver_user_ids" style="min-height: 80px;">
              <option v-for="u in users" :key="u.ID" :value="u.ID">{{ u.Username }} · {{ u.Role }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ $t('approvalChain.autoAfterHours') }}</span>
            <input type="number" v-model.number="lvl.auto_after_hours" min="0" placeholder="0 = no auto"/>
          </label>
        </div>
      </div>
      <button class="btn ghost" @click="addLevel"><Plus :size="13"/> {{ $t('approvalChain.addLevel') }}</button>
    </div>

    <label class="toggle mt-lg"><input type="checkbox" v-model="editing.IsActive"/> <span>{{ $t('common.active') }}</span></label>

    <template #footer>
      <button class="btn ghost danger" v-if="editing.ID" @click="del" :disabled="busy"><Trash2 :size="13"/> {{ $t('common.delete') }}</button>
      <span class="space"></span>
      <button class="btn ghost" @click="editing = null">{{ $t('common.cancel') }}</button>
      <button class="btn" :disabled="busy" @click="save"><Save :size="13"/> {{ $t('common.save') }}</button>
    </template>
  </Modal>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus, GitBranch, ArrowRight, ChevronRight, Save, Trash2
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const loading = ref(true)
const busy = ref(false)
const rules = ref([])
const resources = ref([])
const departments = ref([])
const users = ref([])
const editing = ref(null)

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [r, res, dept, usr] = await Promise.all([
      api.listApprovalRules(),
      api.listResources().catch(() => []),
      api.listDepartments().catch(() => []),
      api.listUsers().catch(() => [])
    ])
    rules.value = r || []
    resources.value = res || []
    departments.value = dept || []
    users.value = usr || []
  } catch (e) { toasts.error('Could not load', e.message) }
  finally { loading.value = false }
}

function open(r) { editing.value = JSON.parse(JSON.stringify({ ...r, Levels: r.Levels || [] })) }
function openNew() {
  editing.value = {
    Name: '', ScopeType: 'asset_type', ScopeValue: 'Room',
    Priority: 100, IsActive: true,
    Levels: [{ name: 'Approval', approver_role: '', min_grade: '', approver_user_ids: [], auto_after_hours: 0 }]
  }
}
function addLevel() {
  editing.value.Levels.push({ name: 'Step ' + (editing.value.Levels.length + 1), approver_role: '', min_grade: '', approver_user_ids: [], auto_after_hours: 0 })
}
function removeLevel(i) { editing.value.Levels.splice(i, 1) }

async function save() {
  busy.value = true
  try {
    if (editing.value.ID) await api.updateApprovalRule(editing.value.ID, editing.value)
    else                  await api.createApprovalRule(editing.value)
    toasts.success(t('common.saved'))
    editing.value = null
    load()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function del() {
  if (!confirm(t('approvalChain.confirmDelete'))) return
  busy.value = true
  try {
    await api.deleteApprovalRule(editing.value.ID)
    editing.value = null
    load()
  } catch (e) { toasts.error('Delete failed', e.message) }
  finally { busy.value = false }
}

function describeLevel(lvl) {
  const parts = []
  if (lvl.approver_role) parts.push(lvl.approver_role)
  if (lvl.min_grade)     parts.push('grade ≥ ' + lvl.min_grade)
  if (lvl.approver_user_ids?.length) parts.push((lvl.approver_user_ids.length) + ' specific')
  if (lvl.auto_after_hours)  parts.push('auto +' + lvl.auto_after_hours + 'h')
  return parts.length ? '· ' + parts.join(' · ') : ''
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.rule-card { display: grid; grid-template-columns: 44px 1fr auto; gap: 14px; align-items: center; cursor: pointer; }
.prio {
  width: 44px; height: 44px; border-radius: 12px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--brand-primary), var(--brand-secondary));
  color: white; font-weight: 700;
}
.level-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 999px;
  background: var(--surface-inset); border: 1px solid var(--border);
  font-size: 12px;
}
.level-pill .num {
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--brand-primary); color: white;
  display: grid; place-items: center; font-size: 10px; font-weight: 700;
}
.level-pill small { color: var(--text-muted); }

.level-card { background: var(--surface-inset); }
.num { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--brand-primary); color: white; font-size: 11px; font-weight: 700; }
</style>
