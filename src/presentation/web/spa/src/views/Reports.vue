<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('reports.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('reports.subtitle') }}</p>
    </div>
  </div>

  <div class="card mb">
    <h3 class="mb">{{ $t('reports.usage') }}</h3>
    <p class="muted text-sm mb">{{ $t('reports.usageHelp') }}</p>
    <div class="grid-2">
      <label class="field">
        <span>{{ $t('reports.start') }}</span>
        <input type="date" v-model="start" />
      </label>
      <label class="field">
        <span>{{ $t('reports.end') }}</span>
        <input type="date" v-model="end" />
      </label>
    </div>
    <div class="row gap-sm mt">
      <button class="btn ghost" :disabled="busy" @click="download('csv')"><FileText :size="14"/> {{ $t('reports.exportCsv') }}</button>
      <button class="btn"        :disabled="busy" @click="download('xlsx')"><FileSpreadsheet :size="14"/> {{ $t('reports.exportXlsx') }}</button>
    </div>
  </div>

  <div class="card">
    <h3 class="mb">{{ $t('reports.realtime') }}</h3>
    <p class="muted text-sm">{{ $t('reports.realtimeHelp') }}</p>
    <div class="row gap-sm mt">
      <a class="btn ghost" href="/api/metrics" target="_blank"><Activity :size="14"/> Prometheus /metrics</a>
      <a class="btn ghost" href="http://localhost:9090" target="_blank"><BarChart3 :size="14"/> Prometheus UI</a>
      <a class="btn ghost" href="/api/docs" target="_blank"><BookOpen :size="14"/> API docs</a>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, FileSpreadsheet, Activity, BarChart3, BookOpen } from 'lucide-vue-next'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const busy = ref(false)
const today = new Date().toISOString().slice(0, 10)
const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
const start = ref(monthAgo)
const end   = ref(today)

async function download(format) {
  busy.value = true
  try {
    const blob = await api.exportUsage(format, start.value, end.value)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `usage_${start.value}_${end.value}.${format}`
    a.click()
    URL.revokeObjectURL(url)
    toasts.success(t('reports.downloaded'))
  } catch (e) { toasts.error('Export failed', e.message) }
  finally { busy.value = false }
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
</style>
