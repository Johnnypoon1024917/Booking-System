<template>
  <div class="mrbs">
    <h1 class="fsd-page-title">Broadcasts</h1>

    <div class="bc-shell">
      <!-- Composer -->
      <div class="panel" style="align-self:start;">
        <div class="ph"><span>{{ editing.id ? 'Edit Broadcast' : 'New Broadcast' }}</span></div>
        <div class="pb">
          <div class="tpl-row">
            <select v-model="tplPick" class="tpl-sel">
              <option value="">— Load a template —</option>
              <option v-for="(t, i) in templates" :key="i" :value="i">{{ t.name }}</option>
            </select>
            <button class="mrbs-btn ghost sm" :disabled="tplPick === ''" @click="applyTemplate">Apply</button>
            <button class="mrbs-btn ghost sm" @click="saveTemplate">Save as template</button>
            <button class="mrbs-btn ghost sm" :disabled="tplPick === ''" @click="deleteTemplate" title="Delete template">✕</button>
          </div>

          <div class="grid-2">
            <label class="fld">
              <span>Severity</span>
              <select v-model="editing.severity">
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="urgent">Urgent (e.g. Typhoon No.8 closure)</option>
              </select>
            </label>
            <label class="fld">
              <span>Banner colour</span>
              <span class="clr-row">
                <input type="color" v-model="editing.color" />
                <input type="text" v-model="editing.color" placeholder="(default by severity)" />
                <button v-if="editing.color" type="button" class="mrbs-btn ghost sm" @click="editing.color = ''">Reset</button>
              </span>
            </label>
          </div>
          <label class="fld"><span>Title</span><input v-model="editing.title" placeholder="e.g. Typhoon Signal No.8 — Facility Closure" /></label>
          <label class="fld"><span>Message</span>
            <textarea v-model="editing.content" rows="4" placeholder="All bookings at the affected facilities are suspended until further notice."></textarea>
          </label>
          <div class="grid-2">
            <label class="fld"><span>Start</span><input type="datetime-local" v-model="editing.start_date" /></label>
            <label class="fld"><span>End</span><input type="datetime-local" v-model="editing.end_date" /></label>
          </div>

          <div class="ph2">Targeting (optional)</div>
          <div class="rb">
            <label class="fld" style="margin-bottom:8px;"><span>Location filter</span>
              <select v-model="editing.location">
                <option value="">All locations</option>
                <option v-for="l in locations" :key="l" :value="l">{{ l }}</option>
              </select>
            </label>
            <label class="fld" style="margin-bottom:8px;"><span>Rooms (Ctrl/Cmd-click for multiple)</span>
              <select multiple v-model="editing.resources" size="5" style="height:auto;">
                <option v-for="r in rooms" :key="r.ID || r.id" :value="r.ID || r.id">
                  {{ r.Name || r.name }} — {{ r.Location || r.location }}
                </option>
              </select>
            </label>
            <p class="muted text-sm">Leave empty to broadcast department-wide. Filters are recorded with the message for routing/email fan-out.</p>
          </div>

          <div class="row gap-sm mt">
            <button class="mrbs-btn" :disabled="busy" @click="save">
              <Megaphone :size="14" /> {{ editing.id ? 'Update' : 'Publish Broadcast' }}
            </button>
            <button v-if="editing.id" class="mrbs-btn ghost" @click="resetForm">Cancel edit</button>
          </div>
        </div>
      </div>

      <!-- Existing -->
      <div class="panel" style="align-self:start;">
        <div class="ph"><span>Published Broadcasts</span>
          <button class="mrbs-btn ghost" @click="load"><RefreshCcw :size="13" /> Refresh</button>
        </div>
        <div class="pb" style="padding:0;">
          <div v-if="loading" style="padding:16px;"><Skeleton height="160px" /></div>
          <EmptyState v-else-if="!items.length" :icon="Megaphone" title="No broadcasts yet" />
          <div v-else>
            <div v-for="b in items" :key="b.id" class="bc-row">
              <span class="pill" :class="sevPill(b.severity)">{{ b.severity }}</span>
              <div class="space">
                <div style="font-weight:600;">{{ b.title }}</div>
                <small class="muted">{{ fmt(b.start_date) }} → {{ fmt(b.end_date) }}
                  <span v-if="active(b)" class="pill ok" style="margin-left:6px;">LIVE</span></small>
                <div class="text-sm" style="margin-top:4px;">{{ b.content }}</div>
              </div>
              <div class="col gap-sm">
                <button class="ic" @click="edit(b)" title="Edit"><Pencil :size="14" /></button>
                <button class="ic del" @click="remove(b)" title="Delete"><Trash2 :size="14" /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Automatic triggers -->
    <div class="panel" style="margin-top:16px;">
      <div class="ph">
        <span>Automatic Triggers (weather-driven)</span>
        <div class="row gap-sm">
          <button class="mrbs-btn ghost" @click="addRule"><Plus :size="13" /> Add rule</button>
          <button class="mrbs-btn" :disabled="savingRules" @click="saveRules">Save rules</button>
        </div>
      </div>
      <div class="pb">
        <p class="muted text-sm" style="margin-bottom:10px;">
          The scheduler polls Hong Kong Observatory every 5 minutes. When a rule's
          condition is met it auto-publishes the broadcast below — no admin action
          needed (e.g. temperature above 30°C → high-temperature alert).
        </p>
        <div v-if="!autoRules.length" class="muted text-sm">No automatic triggers configured.</div>
        <div v-for="(r, i) in autoRules" :key="i" class="rule-card">
          <div class="rule-grid">
            <label class="fld"><span>Enabled</span>
              <select v-model="r.enabled"><option :value="true">Yes</option><option :value="false">No</option></select>
            </label>
            <label class="fld"><span>Condition</span>
              <select v-model="r.metric">
                <option value="temp_above">Temperature above (°C)</option>
                <option value="temp_below">Temperature below (°C)</option>
                <option value="signal_at_least">Weather signal severity ≥ (1–10)</option>
              </select>
            </label>
            <label class="fld"><span>Threshold</span>
              <input type="number" v-model.number="r.threshold" />
            </label>
            <label class="fld"><span>Severity</span>
              <select v-model="r.severity">
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label class="fld"><span>Re-fire after (hrs)</span>
              <input type="number" min="1" v-model.number="r.cooldown_hours" />
            </label>
            <button class="ic del" title="Remove" @click="autoRules.splice(i, 1)"><Trash2 :size="14" /></button>
          </div>
          <label class="fld"><span>Banner title</span>
            <input v-model="r.title" placeholder="e.g. High Temperature Alert" />
          </label>
          <label class="fld"><span>Banner message</span>
            <textarea rows="2" v-model="r.content" placeholder="Very hot weather — outdoor facility use is discouraged."></textarea>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { Megaphone, RefreshCcw, Pencil, Trash2, Plus } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'
import { useTenantStore } from '../stores/tenant'

const toasts = useToastStore()
const tenant = useTenantStore()
const loading = ref(true)
const busy = ref(false)
const items = ref([])
const rooms = ref([])
const locations = ref([])

function blank() {
  const now = new Date()
  const end = new Date(now.getTime() + 24 * 3600 * 1000)
  return {
    id: '', severity: 'urgent', title: '', content: '', color: '',
    start_date: toLocal(now), end_date: toLocal(end),
    location: '', resources: []
  }
}
const editing = ref(blank())

// ---- Message templates (saved locally per admin) ----
const TPL_KEY = 'fsd_broadcast_templates'
const templates = ref([])
const tplPick = ref('')
function loadTemplates() {
  try { templates.value = JSON.parse(localStorage.getItem(TPL_KEY) || '[]') }
  catch { templates.value = [] }
}
function persistTemplates() {
  localStorage.setItem(TPL_KEY, JSON.stringify(templates.value))
}
function applyTemplate() {
  const t = templates.value[tplPick.value]
  if (!t) return
  editing.value.severity = t.severity || 'info'
  editing.value.title = t.title || ''
  editing.value.content = t.content || ''
  editing.value.color = t.color || ''
  toasts.success('Template applied', t.name)
}
function saveTemplate() {
  const name = window.prompt('Template name:', editing.value.title || 'Untitled')
  if (!name || !name.trim()) return
  templates.value.push({
    name: name.trim(),
    severity: editing.value.severity,
    title: editing.value.title,
    content: editing.value.content,
    color: editing.value.color
  })
  persistTemplates()
  toasts.success('Template saved', name.trim())
}
function deleteTemplate() {
  const i = tplPick.value
  if (i === '' || !templates.value[i]) return
  if (!confirm(`Delete template "${templates.value[i].name}"?`)) return
  templates.value.splice(i, 1)
  tplPick.value = ''
  persistTemplates()
}

// ---- Weather auto-trigger rules (persisted in tenant customization) ----
const autoRules = ref([])
const savingRules = ref(false)
function addRule() {
  autoRules.value.push({
    id: 'r' + Date.now(), enabled: true, metric: 'temp_above',
    threshold: 30, severity: 'warning', cooldown_hours: 6,
    title: 'High Temperature Alert',
    content: 'Very hot weather — outdoor facility use is discouraged. Stay hydrated.'
  })
}
async function saveRules() {
  savingRules.value = true
  try {
    const c = JSON.parse(JSON.stringify(tenant.customization || {}))
    c.broadcast_auto_rules = autoRules.value
    await tenant.save(c)
    toasts.success('Automatic triggers saved')
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { savingRules.value = false }
}

function toLocal(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmt(s) { return s ? new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—' }
function active(b) { const n = Date.now(); return new Date(b.start_date) <= n && n <= new Date(b.end_date) }
function sevPill(s) { return s === 'urgent' ? 'bad' : s === 'warning' ? 'amber' : 'navy' }

onMounted(async () => {
  loadTemplates()
  try {
    rooms.value = await api.listResources()
    locations.value = [...new Set(rooms.value.map(r => r.Location || r.location).filter(Boolean))]
  } catch { /* non-fatal */ }
  try {
    if (!tenant.customization) await tenant.load()
    autoRules.value = JSON.parse(JSON.stringify(tenant.customization?.broadcast_auto_rules || []))
  } catch { /* non-fatal */ }
  load()
})

async function load() {
  loading.value = true
  try { items.value = await api.listBroadcasts() }
  catch (e) { toasts.error('Could not load broadcasts', e.message) }
  finally { loading.value = false }
}

function resetForm() { editing.value = blank() }
function edit(b) {
  editing.value = {
    id: b.id, severity: b.severity || 'info', title: b.title, content: b.content,
    color: b.color || b.filters?.color || '',
    start_date: toLocal(new Date(b.start_date)), end_date: toLocal(new Date(b.end_date)),
    location: b.filters?.location || '', resources: b.filters?.resources || []
  }
}

async function save() {
  if (!editing.value.title.trim() || !editing.value.content.trim()) {
    toasts.error('Title and message are required'); return
  }
  busy.value = true
  try {
    const payload = {
      title: editing.value.title,
      content: editing.value.content,
      severity: editing.value.severity,
      start_date: new Date(editing.value.start_date).toISOString(),
      end_date: new Date(editing.value.end_date).toISOString(),
      filters: {
        severity: editing.value.severity,
        color: editing.value.color || undefined,
        location: editing.value.location || undefined,
        resources: editing.value.resources.length ? editing.value.resources : undefined
      }
    }
    if (editing.value.id) await api.updateBroadcast(editing.value.id, payload)
    else await api.createBroadcast(payload)
    toasts.success('Broadcast published')
    resetForm()
    load()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function remove(b) {
  if (!confirm(`Delete broadcast "${b.title}"?`)) return
  try { await api.deleteBroadcast(b.id); toasts.success('Deleted'); load() }
  catch (e) { toasts.error('Delete failed', e.message) }
}
</script>

<style scoped>
.bc-shell { display: grid; grid-template-columns: minmax(0, 400px) minmax(0, 1fr); gap: 16px; align-items: start; }
@media (max-width: 900px) { .bc-shell { grid-template-columns: 1fr; } }
/* Prevent the datetime/select inputs from forcing horizontal overflow. */
.bc-shell > * { min-width: 0; }
.bc-shell :deep(.fld) { min-width: 0; }
.bc-shell :deep(input),
.bc-shell :deep(select),
.bc-shell :deep(textarea) { width: 100%; box-sizing: border-box; min-width: 0; max-width: 100%; }
.bc-shell :deep(.grid-2) { gap: 10px; }

.ph2 { font-size: 12px; font-weight: 600; color: var(--asl-blue); margin: 14px 0 8px; padding-top: 10px; border-top: 1px solid var(--asl-line); }
.bc-row { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-bottom: 1px solid var(--asl-line); }
.bc-row:last-child { border-bottom: 0; }
.ic { border: 0; background: none; cursor: pointer; color: var(--asl-blue); padding: 4px; }
.ic.del { color: var(--asl-bad); }
textarea { width: 100%; padding: 7px 9px; font: inherit; font-size: 13px; border: 1px solid var(--asl-line); border-radius: 3px; box-sizing: border-box; }

.tpl-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 12px; }
.tpl-sel { flex: 1 1 160px; min-width: 0; padding: 6px 8px; border: 1px solid var(--asl-line); border-radius: 3px; font: inherit; font-size: 13px; }
.mrbs-btn.sm { padding: 5px 9px; font-size: 12px; }
.clr-row { display: flex; gap: 6px; align-items: center; }
.clr-row input[type=color] { width: 40px; flex: 0 0 40px; padding: 2px; height: 32px; }
.clr-row input[type=text] { flex: 1 1 auto; min-width: 0; }

.rule-card { border: 1px solid var(--asl-line); border-radius: 4px; padding: 12px; margin-bottom: 12px; }
.rule-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)) 36px; gap: 10px; align-items: end; }
.rule-grid .fld { margin: 0; }
</style>
