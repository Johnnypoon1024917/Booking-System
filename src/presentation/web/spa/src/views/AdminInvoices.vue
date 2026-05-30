<!--
  Charge-back invoice dashboard.
  Triggers monthly rollup, lists Draft/Issued/Paid invoices, opens
  detail with line items, and provides Issue / Mark Paid / CSV actions.
-->
<template>
  <div class="page-header mb-lg">
    <h1>{{ $t('admin.invoices.title') }}</h1>
    <p class="muted text-md mt-sm">{{ $t('admin.invoices.subtitle') }}</p>
  </div>

  <section class="card mb-lg">
    <div class="row gap">
      <label class="field" style="max-width: 200px;">
        <span>{{ $t('admin.invoices.month') }}</span>
        <input type="month" v-model="month"/>
      </label>
      <button type="button" class="btn" @click="runRollup" :disabled="busy">
        {{ $t('admin.invoices.run') }}
      </button>
      <button type="button" class="btn ghost" @click="load" :disabled="loading">
        {{ $t('common.refresh') }}
      </button>
    </div>
    <div v-if="lastRun" class="status mt">{{ $t('admin.invoices.runResult', lastRun) }}</div>
  </section>

  <Skeleton v-if="loading" height="280px"/>
  <div v-else class="card" style="padding: 0; overflow-x: auto;">
    <table class="table" :aria-label="$t('admin.invoices.title')">
      <thead>
        <tr>
          <th scope="col">{{ $t('admin.invoices.colPeriod') }}</th>
          <th scope="col">{{ $t('admin.invoices.colCostCentre') }}</th>
          <th scope="col">{{ $t('admin.invoices.colLines') }}</th>
          <th scope="col" style="text-align: right;">{{ $t('admin.invoices.colSubtotal') }}</th>
          <th scope="col" style="text-align: right;">{{ $t('admin.invoices.colTax') }}</th>
          <th scope="col" style="text-align: right;">{{ $t('admin.invoices.colTotal') }}</th>
          <th scope="col">{{ $t('admin.invoices.colStatus') }}</th>
          <th scope="col">{{ $t('admin.invoices.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inv in invoices" :key="inv.id">
          <td>{{ formatPeriod(inv.period_start) }}</td>
          <td><code>{{ inv.cost_centre }}</code></td>
          <td>{{ inv.line_count }}</td>
          <td style="text-align: right;">{{ inv.subtotal.toFixed(2) }} {{ inv.currency }}</td>
          <td style="text-align: right;">{{ inv.tax.toFixed(2) }}</td>
          <td style="text-align: right;"><b>{{ inv.total.toFixed(2) }}</b></td>
          <td><span :class="statusClass(inv.status)">{{ inv.status }}</span></td>
          <td>
            <button type="button" class="btn ghost sm" @click="download(inv)">CSV</button>
            <button v-if="inv.status === 'Draft'" type="button" class="btn ghost sm" @click="issue(inv)">
              {{ $t('admin.invoices.issue') }}
            </button>
            <button v-else-if="inv.status === 'Issued'" type="button" class="btn ghost sm" @click="markPaid(inv)">
              {{ $t('admin.invoices.markPaid') }}
            </button>
          </td>
        </tr>
        <tr v-if="!invoices.length">
          <td colspan="8" class="muted" style="text-align: center; padding: 24px;">
            {{ $t('admin.invoices.empty') }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import Skeleton from '../components/Skeleton.vue'
import { api, getToken } from '../api'

const month    = ref(new Date().toISOString().slice(0, 7))
const invoices = ref([])
const loading  = ref(false)
const busy     = ref(false)
const lastRun  = ref(null)

async function load() {
  loading.value = true
  try {
    const r = await api.get('/api/v1/admin/invoices')
    invoices.value = r.data || []
  } finally { loading.value = false }
}

async function runRollup() {
  busy.value = true
  try {
    const r = await api.post(`/api/v1/admin/invoices/run?month=${month.value}`)
    lastRun.value = { period: r.data.period, upserted: r.data.upserted, rate: r.data.tax_rate }
    await load()
  } finally { busy.value = false }
}

async function issue(inv)    { await api.post(`/api/v1/admin/invoices/${inv.id}/issue`); await load() }
async function markPaid(inv) { await api.post(`/api/v1/admin/invoices/${inv.id}/mark-paid`); await load() }

async function download(inv) {
  // Direct fetch with the bearer token so the response streams as a
  // CSV download; we avoid axios because it would parse the body.
  const r = await fetch(`/api/v1/admin/invoices/${inv.id}.csv`, {
    headers: { Authorization: 'Bearer ' + getToken() },
  })
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: `invoice-${inv.id}.csv` })
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

function formatPeriod(d) {
  const dt = new Date(d)
  return dt.toLocaleString(undefined, { year: 'numeric', month: 'short' })
}
function statusClass(s) {
  if (s === 'Paid')   return 'tag success'
  if (s === 'Issued') return 'tag info'
  if (s === 'Void')   return 'tag'
  return 'tag warning'
}

onMounted(load)
</script>
