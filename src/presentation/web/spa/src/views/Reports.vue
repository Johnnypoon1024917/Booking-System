<template>
  <div class="mrbs">
    <h1 class="fsd-page-title">Reports</h1>

    <div class="rep-shell">
      <!-- Report type list -->
      <div class="panel" style="align-self:start;">
        <div class="ph"><span>Report Types</span></div>
        <div class="pb" style="padding:6px;">
          <button v-for="r in visibleReportTypes" :key="r.key"
                  class="rt" :class="{ on: selected === r.key }" @click="select(r.key)">
            <FileText :size="14" /> {{ r.label }}
          </button>
        </div>
      </div>

      <!-- Selected report -->
      <div class="panel" style="align-self:start;">
        <div class="ph"><span>{{ current.label }}</span></div>
        <div class="pb">
          <p class="muted text-sm mb">Default raw data report — download as Excel or CSV for the selected period.</p>
          <div class="grid-3">
            <label class="fld"><span>Start Scope</span><input type="date" v-model="start" /></label>
            <label class="fld"><span>End Scope</span><input type="date" v-model="end" /></label>
            <label class="fld">
              <span>Location Base Filter</span>
              <select v-model="locFilter">
                <option value="">All Floors</option>
                <option v-for="l in locations" :key="l" :value="l">{{ l }}</option>
              </select>
            </label>
          </div>
          <div class="row gap-sm mt mb">
            <button class="mrbs-btn" :disabled="busy" @click="download('xlsx')">
              <FileSpreadsheet :size="14" /> Download as Excel
            </button>
            <button class="mrbs-btn ghost" :disabled="busy" @click="download('csv')">
              <FileText :size="14" /> Download as CSV
            </button>
          </div>

          <div class="prev-head">Preview <span class="muted text-sm">({{ viewRows.length }} rows)</span></div>
          <div style="overflow-x:auto; border:1px solid var(--asl-line); border-radius:3px;">
            <table class="lt">
              <thead><tr><th v-for="c in table.headers" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, i) in viewRows" :key="i">
                  <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
                </tr>
                <tr v-if="!viewRows.length">
                  <td :colspan="Math.max(1, table.headers.length)" style="text-align:center; color:var(--asl-grey); padding:24px;">
                    {{ loadingPrev ? 'Loading…' : 'No data for the selected period' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { FileText, FileSpreadsheet } from 'lucide-vue-next'
import { api } from '../api'
import { useToastStore } from '../stores/toast'
import { useTenantStore } from '../stores/tenant'

const toasts = useToastStore()
const tenant = useTenantStore()
const today = new Date().toISOString().slice(0, 10)
const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
const start = ref(monthAgo)
const end = ref(today)
const busy = ref(false)
const loadingPrev = ref(false)
const table = ref({ headers: [], rows: [] })

const reportTypes = [
  { key: 'audit',   label: 'Audit Trail' },
  { key: 'summary', label: 'Booking Summary' },
  { key: 'noshow',  label: 'Booking Summary - No Show' },
  { key: 'staff',   label: 'Daily Staff Productivity' },
  { key: 'usage',   label: 'Room Usage and Duration' },
  { key: 'medical', label: 'Medical Booking Summary' },
  { key: 'addl',    label: 'Additional Booking Summary' }
]
// Admin-curated report templates (System Settings → Workflow). Empty/
// absent list ⇒ show all.
const visibleReportTypes = computed(() => {
  const allowed = tenant.customization?.report_types
  if (!allowed || !allowed.length) return reportTypes
  return reportTypes.filter(r => allowed.includes(r.key))
})

const selected = ref('summary')
const current = computed(() =>
  visibleReportTypes.value.find(r => r.key === selected.value) ||
  visibleReportTypes.value[0] || reportTypes[0])

const locFilter = ref('')
const locations = ref([])

// Client-side Location Base filter on the preview (FSD spec Module E).
// Export still pulls the full server dataset for the period.
const viewRows = computed(() => {
  if (!locFilter.value) return table.value.rows
  const li = table.value.headers.findIndex(h => /location/i.test(h))
  if (li < 0) return table.value.rows
  return table.value.rows.filter(r => (r[li] || '') === locFilter.value)
})

onMounted(async () => {
  try {
    const res = await api.listResources()
    locations.value = [...new Set((res || []).map(r => r.Location || r.location).filter(Boolean))]
  } catch { /* non-fatal */ }
  // Snap selection to an allowed template if the default is hidden.
  if (!visibleReportTypes.value.some(r => r.key === selected.value)) {
    selected.value = visibleReportTypes.value[0]?.key || selected.value
  }
  loadPreview()
})
watch([start, end], loadPreview)

function select(k) { selected.value = k; loadPreview() }

async function loadPreview() {
  loadingPrev.value = true
  try {
    table.value = await api.getReportData(selected.value, start.value, end.value)
    if (!table.value || !Array.isArray(table.value.rows)) table.value = { headers: [], rows: [] }
  } catch (e) {
    table.value = { headers: [], rows: [] }
    toasts.error('Could not load preview', e.message)
  } finally {
    loadingPrev.value = false
  }
}

async function download(format) {
  busy.value = true
  try {
    const blob = await api.exportReport(selected.value, format, start.value, end.value)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selected.value}_${start.value}_${end.value}.${format}`
    a.click()
    URL.revokeObjectURL(url)
    toasts.success('Report downloaded')
  } catch (e) { toasts.error('Export failed', e.message) }
  finally { busy.value = false }
}
</script>

<style scoped>
.rep-shell { display: grid; grid-template-columns: 260px 1fr; gap: 16px; }
@media (max-width: 880px) { .rep-shell { grid-template-columns: 1fr; } }
.rt {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 12px; border: 0; background: none; cursor: pointer;
  font: inherit; font-size: 13px; color: #33414e; text-align: left;
  border-radius: 3px;
}
.rt:hover { background: var(--asl-blue-soft); }
.rt.on { background: var(--asl-blue); color: #fff; font-weight: 600; }
.prev-head { font-size: 13px; font-weight: 600; margin: 6px 0 8px; color: #33414e; }
</style>
