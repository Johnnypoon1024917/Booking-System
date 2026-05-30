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
          <span class="tag info">{{ r.ScopeType }}<span v-if="r.ScopeValue">: {{ scopeLabel(r) }}</span></span>
          <span v-if="!r.IsActive" class="tag warning">{{ $t('common.inactive') }}</span>
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
    <!-- ===== Basic fields ===== -->
    <div class="grid-2">
      <label class="field"><span>{{ $t('approvalChain.name') }}</span><input v-model="editing.Name"/></label>
      <label class="field">
        <span>{{ $t('approvalChain.priority') }}</span>
        <input type="number" v-model.number="editing.Priority" min="1" max="999"/>
        <small class="muted">{{ $t('approvalChain.priorityHelp') }}</small>
      </label>
      <label class="field">
        <span>{{ $t('approvalChain.scopeType') }}</span>
        <select v-model="editing.ScopeType" @change="editing.ScopeValue = ''">
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
        <input v-else v-model="editing.ScopeValue" disabled :placeholder="$t('approvalChain.scope.tenantWide')"/>
      </label>
    </div>

    <label class="toggle mt"><input type="checkbox" v-model="editing.IsActive"/> <span>{{ $t('common.active') }}</span></label>

    <!-- ===== Levels editor ===== -->
    <h4 class="section-h">{{ $t('approvalChain.levels') }}</h4>
    <div v-for="(lvl, i) in editing.Levels" :key="i" class="card mb level-card">
      <div class="level-head">
        <span class="num">{{ i + 1 }}</span>
        <input v-model="lvl.name" :placeholder="$t('approvalChain.levelName')" class="level-name"/>
        <div class="row gap-sm">
          <button class="btn icon-only sm ghost" @click="moveLevel(i, -1)" :disabled="i === 0" :title="$t('approvalChain.moveUp')">
            <ArrowUp :size="13"/>
          </button>
          <button class="btn icon-only sm ghost" @click="moveLevel(i, 1)" :disabled="i === editing.Levels.length - 1" :title="$t('approvalChain.moveDown')">
            <ArrowDown :size="13"/>
          </button>
          <button class="btn icon-only sm ghost danger" @click="removeLevel(i)" :title="$t('common.delete')">
            <Trash2 :size="13"/>
          </button>
        </div>
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
          <select v-model="lvl.min_grade">
            <option value="">{{ $t('approvalChain.anyGrade') }}</option>
            <option v-for="g in GRADES" :key="g" :value="g">{{ g }}</option>
          </select>
          <small class="muted">{{ $t('approvalChain.minGradeHelp') }}</small>
        </label>
        <label class="field" style="grid-column: 1 / -1;">
          <span>{{ $t('approvalChain.specificApprovers') }} <small class="muted">({{ (lvl.approver_user_ids||[]).length }} {{ $t('approvalChain.selected') }})</small></span>
          <select multiple v-model="lvl.approver_user_ids" style="min-height: 92px;">
            <option v-for="u in users" :key="u.ID" :value="u.ID">{{ u.Username }} · {{ u.Role }}{{ u.Grade ? ' · ' + u.Grade : '' }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ $t('approvalChain.autoAfterHours') }}</span>
          <input type="number" v-model.number="lvl.auto_after_hours" min="0" placeholder="0"/>
          <small class="muted">{{ $t('approvalChain.autoAfterHoursHelp') }}</small>
        </label>
        <label class="toggle" style="align-self: end;">
          <input type="checkbox" v-model="lvl.parallel"/>
          <span>{{ $t('approvalChain.parallel') }}</span>
          <small class="muted">{{ $t('approvalChain.parallelHelp') }}</small>
        </label>
      </div>

      <div v-if="i > 0" class="mt">
        <div class="field-label">{{ $t('approvalChain.dependencies') }}</div>
        <p class="muted text-sm">{{ $t('approvalChain.dependenciesHelp') }}</p>
        <div class="dep-chips">
          <label v-for="j in i" :key="j-1" class="dep-chip" :class="{ active: depsOf(lvl).includes(j-1) }">
            <input type="checkbox"
                   :checked="depsOf(lvl).includes(j-1)"
                   @change="toggleDep(lvl, j-1, $event.target.checked)"/>
            <span class="num small">{{ j }}</span>
            <span>{{ editing.Levels[j-1].name || ('Step ' + j) }}</span>
          </label>
        </div>
        <small v-if="!depsOf(lvl).length" class="muted">{{ $t('approvalChain.linearDefault') }}</small>
      </div>
    </div>
    <button class="btn ghost" @click="addLevel"><Plus :size="13"/> {{ $t('approvalChain.addLevel') }}</button>

    <!-- ===== Chain preview ===== -->
    <h4 class="section-h">{{ $t('approvalChain.preview') }}</h4>
    <div class="chain-preview">
      <svg v-if="editing.Levels.length" :viewBox="`0 0 ${previewWidth} 80`" :width="previewWidth" height="80">
        <!-- Dependency arrows -->
        <g v-for="(lvl, i) in editing.Levels" :key="'a'+i">
          <line v-for="d in normalisedDeps(i)" :key="`a${i}_${d}`"
                :x1="nodeX(d) + 36" :y1="40"
                :x2="nodeX(i) - 36" :y2="40"
                class="chain-arrow"/>
        </g>
        <!-- Level nodes -->
        <g v-for="(lvl, i) in editing.Levels" :key="'n'+i">
          <circle :cx="nodeX(i)" :cy="40" r="22"
                  class="chain-node"
                  :class="{ parallel: lvl.parallel }"/>
          <text :x="nodeX(i)" y="40" class="chain-node-text" text-anchor="middle" dominant-baseline="central">{{ i + 1 }}</text>
          <text :x="nodeX(i)" y="72" class="chain-node-label" text-anchor="middle">{{ truncate(lvl.name || ('Step ' + (i + 1)), 14) }}</text>
        </g>
      </svg>
      <p v-else class="muted text-sm">{{ $t('approvalChain.previewEmpty') }}</p>
    </div>

    <!-- ===== Simulator ===== -->
    <h4 class="section-h">{{ $t('approvalChain.simulator') }}</h4>
    <p class="muted text-sm">{{ $t('approvalChain.simulatorHelp') }}</p>
    <div class="grid-2">
      <label class="field">
        <span>{{ $t('approvalChain.simResource') }}</span>
        <select v-model="simResourceId">
          <option value="">—</option>
          <option v-for="r in resources" :key="r.ID" :value="r.ID">{{ r.Name }} · {{ r.AssetType }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ $t('approvalChain.simUser') }}</span>
        <select v-model="simUserId">
          <option value="">—</option>
          <option v-for="u in users" :key="u.ID" :value="u.ID">{{ u.Username }} · {{ u.Role }}{{ u.Grade ? ' · ' + u.Grade : '' }}</option>
        </select>
      </label>
    </div>
    <div v-if="simulation" class="sim-result mt">
      <div class="row gap-sm" style="flex-wrap: wrap;">
        <span class="tag" :class="simulation.scopeMatches ? 'success' : 'warning'">
          {{ simulation.scopeMatches ? $t('approvalChain.scopeMatches') : $t('approvalChain.scopeNoMatch') }}
        </span>
        <span v-if="simulation.scopeMatches" class="tag info">{{ simulation.eligibleCount }} / {{ editing.Levels.length }} {{ $t('approvalChain.levelsActionable') }}</span>
      </div>
      <ul v-if="simulation.scopeMatches" class="sim-list mt">
        <li v-for="(row, i) in simulation.levels" :key="i" :class="{ ok: row.eligible }">
          <span class="num small">{{ i + 1 }}</span>
          <span class="sim-name">{{ row.name }}</span>
          <span class="sim-reason muted text-sm">{{ row.reason }}</span>
          <Check v-if="row.eligible" :size="14" class="ok-ic"/>
          <X v-else :size="14" class="no-ic"/>
        </li>
      </ul>
    </div>

    <template #footer>
      <button class="btn ghost danger" v-if="editing.ID" @click="del" :disabled="busy"><Trash2 :size="13"/> {{ $t('common.delete') }}</button>
      <span class="space"></span>
      <button class="btn ghost" @click="editing = null">{{ $t('common.cancel') }}</button>
      <button class="btn" :disabled="busy || !canSave" @click="save"><Save :size="13"/> {{ $t('common.save') }}</button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plus, GitBranch, ArrowRight, ArrowUp, ArrowDown, ChevronRight, Save, Trash2, Check, X
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

// Kept in sync with domain/user/grade.go — the SPA shows these in the
// MinGrade dropdown so admins can't typo a grade that silently fails the
// backend check. Update both files together when the rank ladder changes.
const GRADES = ['SO', 'SSO', 'ADO', 'DO', 'SDO', 'ADD', 'DDGFS', 'DGFS']
const GRADE_RANK = Object.fromEntries(GRADES.map((g, i) => [g, (i + 1) * 10]))
function gradeAtLeast(actual, required) {
  if (!required) return true
  return (GRADE_RANK[actual] || 0) >= (GRADE_RANK[required] || 0)
}

const { t } = useI18n()
const toasts = useToastStore()
const loading = ref(true)
const busy = ref(false)
const rules = ref([])
const resources = ref([])
const departments = ref([])
const users = ref([])
const editing = ref(null)
const simResourceId = ref('')
const simUserId = ref('')

const canSave = computed(() => editing.value && (editing.value.Name || '').trim().length > 0)

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

function open(r) {
  // Deep-clone so the form has its own copy; normalise level field names so
  // missing arrays from older rules don't blow up reactivity.
  const clone = JSON.parse(JSON.stringify({ ...r, Levels: r.Levels || [] }))
  for (const lvl of clone.Levels) {
    lvl.approver_user_ids = lvl.approver_user_ids || []
    lvl.dependencies = lvl.dependencies || []
    lvl.parallel = !!lvl.parallel
  }
  editing.value = clone
}

function openNew() {
  editing.value = {
    Name: '', ScopeType: 'asset_type', ScopeValue: 'Room',
    Priority: 100, IsActive: true,
    Levels: [emptyLevel('Approval')]
  }
}

function emptyLevel(name) {
  return { name, approver_role: '', min_grade: '', approver_user_ids: [], auto_after_hours: 0, parallel: false, dependencies: [] }
}

function addLevel() {
  editing.value.Levels.push(emptyLevel('Step ' + (editing.value.Levels.length + 1)))
}

function removeLevel(i) {
  // Bumping a level out of the chain renumbers everyone after it — clean
  // up dependencies that pointed at the removed index (drop them) and
  // decrement indices that were past it.
  editing.value.Levels.splice(i, 1)
  for (const lvl of editing.value.Levels) {
    lvl.dependencies = (lvl.dependencies || [])
      .filter(d => d !== i)
      .map(d => d > i ? d - 1 : d)
  }
}

function moveLevel(i, delta) {
  const j = i + delta
  if (j < 0 || j >= editing.value.Levels.length) return
  const arr = editing.value.Levels
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  // Reordering invalidates dependency indices. Rather than try to
  // remap them (ambiguous when the swapped levels referenced each
  // other), drop any deps that no longer make sense (>= own index).
  arr.forEach((lvl, idx) => {
    lvl.dependencies = (lvl.dependencies || []).filter(d => d < idx)
  })
}

function depsOf(lvl) { return lvl.dependencies || [] }

function toggleDep(lvl, idx, checked) {
  const deps = new Set(depsOf(lvl))
  if (checked) deps.add(idx); else deps.delete(idx)
  lvl.dependencies = Array.from(deps).sort((a, b) => a - b)
}

// For preview: when a level has no explicit deps, show the implicit
// "linear" arrow from the immediately preceding level.
function normalisedDeps(i) {
  if (i === 0) return []
  const explicit = depsOf(editing.value.Levels[i])
  return explicit.length ? explicit : [i - 1]
}

const previewWidth = computed(() => Math.max(200, editing.value?.Levels.length * 110 || 0))
function nodeX(i) { return 60 + i * 110 }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s }

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
  if (lvl.min_grade)     parts.push('≥ ' + lvl.min_grade)
  if (lvl.approver_user_ids?.length) parts.push(lvl.approver_user_ids.length + ' specific')
  if (lvl.parallel)          parts.push('any-of')
  if (lvl.auto_after_hours)  parts.push('auto +' + lvl.auto_after_hours + 'h')
  return parts.length ? '· ' + parts.join(' · ') : ''
}

function scopeLabel(r) {
  if (r.ScopeType === 'resource') return resources.value.find(x => x.ID === r.ScopeValue)?.Name || r.ScopeValue
  if (r.ScopeType === 'department') return departments.value.find(x => x.ID === r.ScopeValue)?.Name || r.ScopeValue
  return r.ScopeValue
}

// ===== Simulator =====
// Mirrors backend matchRule + canDecide so admins can sanity-check a rule
// without having to create a real booking. Source of truth stays on the
// server; this is just a hint, and it's labelled as such in the help text.
const simulation = computed(() => {
  if (!editing.value) return null
  if (!simResourceId.value || !simUserId.value) return null
  const res = resources.value.find(r => r.ID === simResourceId.value)
  const usr = users.value.find(u => u.ID === simUserId.value)
  if (!res || !usr) return null
  const scopeMatches = matchScope(editing.value, res)
  if (!scopeMatches) {
    return { scopeMatches: false, levels: [], eligibleCount: 0 }
  }
  const rows = editing.value.Levels.map(lvl => {
    const eligible = userCanDecide(lvl, usr)
    return { name: lvl.name || '(unnamed)', eligible, reason: explain(lvl, usr, eligible) }
  })
  return { scopeMatches: true, levels: rows, eligibleCount: rows.filter(r => r.eligible).length }
})

function matchScope(rule, res) {
  switch (rule.ScopeType) {
    case 'resource':    return res.ID === rule.ScopeValue
    case 'asset_type':  return res.AssetType === rule.ScopeValue
    case 'department':  return res.DepartmentID === rule.ScopeValue
    case 'tenant':      return true
  }
  return false
}

function userCanDecide(lvl, u) {
  if ((lvl.approver_user_ids || []).includes(u.ID)) return gradeAtLeast(u.Grade, lvl.min_grade)
  if (lvl.approver_role && lvl.approver_role.toLowerCase() === (u.Role || '').toLowerCase()) {
    return gradeAtLeast(u.Grade, lvl.min_grade)
  }
  if ((u.Role || '') === 'System Admin' && !(lvl.approver_user_ids || []).length && !lvl.approver_role) return true
  return false
}

function explain(lvl, u, eligible) {
  if (eligible) {
    if ((lvl.approver_user_ids || []).includes(u.ID)) return t('approvalChain.eligibleSpecific')
    if (lvl.approver_role && lvl.approver_role.toLowerCase() === (u.Role || '').toLowerCase()) return t('approvalChain.eligibleRole')
    return t('approvalChain.eligibleAdmin')
  }
  if (lvl.approver_role && lvl.approver_role.toLowerCase() !== (u.Role || '').toLowerCase()) return t('approvalChain.notEligibleRole', { role: lvl.approver_role })
  if (lvl.min_grade && !gradeAtLeast(u.Grade, lvl.min_grade)) return t('approvalChain.notEligibleGrade', { grade: lvl.min_grade })
  return t('approvalChain.notEligibleOther')
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

.section-h {
  margin: 24px 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.level-card { background: var(--surface-inset); }
.level-head { display: flex; align-items: center; gap: 10px; }
.level-name { flex: 1; font-weight: 600; font-size: 15px; }

.num {
  display: inline-grid; place-items: center;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--brand-primary); color: white;
  font-size: 12px; font-weight: 700; flex-shrink: 0;
}
.num.small { width: 18px; height: 18px; font-size: 10px; }

.field-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }

.dep-chips {
  display: flex; flex-wrap: wrap; gap: 6px;
}
.dep-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.dep-chip:hover { background: var(--surface-inset); }
.dep-chip.active {
  background: var(--brand-primary);
  color: white;
  border-color: var(--brand-primary);
}
.dep-chip.active .num { background: rgba(255,255,255,0.25); }
.dep-chip input { display: none; }

/* Chain preview SVG */
.chain-preview {
  overflow-x: auto;
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}
.chain-node {
  fill: var(--brand-primary);
  stroke: var(--brand-primary);
  stroke-width: 2;
}
.chain-node.parallel {
  fill: var(--surface);
  stroke: var(--brand-primary);
  stroke-dasharray: 3 2;
}
.chain-node-text { fill: white; font-weight: 700; font-size: 12px; }
.chain-node.parallel + .chain-node-text { fill: var(--brand-primary); }
.chain-node-label { fill: var(--text); font-size: 11px; }
.chain-arrow {
  stroke: var(--text-muted);
  stroke-width: 1.5;
  marker-end: url(#arrow);
}

/* Simulator */
.sim-result { background: var(--surface-inset); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; }
.sim-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.sim-list li { display: grid; grid-template-columns: 22px 1fr auto 14px; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; background: var(--surface); }
.sim-list li.ok { background: rgba(16, 185, 129, 0.08); }
.sim-name { font-weight: 500; font-size: 13px; }
.ok-ic { color: rgb(16, 185, 129); }
.no-ic { color: rgb(239, 68, 68); }
</style>
