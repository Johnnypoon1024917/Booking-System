<!--
  Reception dashboard for visitor management.
  Lists today's visits and lets reception mark check-in / check-out by
  clicking the row buttons. Host-initiated visit creation lives in the
  booking flow (BookingModal "Invite a visitor" section) and not here.
-->
<template>
  <div class="page-header mb-lg">
    <h1>{{ $t('admin.visitors.title') }}</h1>
    <p class="muted text-md mt-sm">{{ $t('admin.visitors.subtitle') }}</p>
  </div>

  <div class="row gap mb">
    <select v-model="filter.status" class="select" @change="load">
      <option value="">{{ $t('admin.visitors.statusAll') }}</option>
      <option value="Expected">{{ $t('admin.visitors.statusExpected') }}</option>
      <option value="Checked In">{{ $t('admin.visitors.statusCheckedIn') }}</option>
      <option value="Checked Out">{{ $t('admin.visitors.statusCheckedOut') }}</option>
    </select>
    <button type="button" class="btn ghost" @click="load" :disabled="loading">
      <RefreshCcw :size="14" aria-hidden="true"/> {{ $t('common.refresh') }}
    </button>
  </div>

  <Skeleton v-if="loading" height="300px"/>

  <div v-else class="card" style="padding: 0; overflow-x: auto;">
    <table class="table" :aria-label="$t('admin.visitors.title')">
      <thead>
        <tr>
          <th scope="col">{{ $t('admin.visitors.colExpected') }}</th>
          <th scope="col">{{ $t('admin.visitors.colName') }}</th>
          <th scope="col">{{ $t('admin.visitors.colCompany') }}</th>
          <th scope="col">{{ $t('admin.visitors.colPurpose') }}</th>
          <th scope="col">{{ $t('admin.visitors.colStatus') }}</th>
          <th scope="col">{{ $t('admin.visitors.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="v in visits" :key="v.ID || v.id">
          <td>{{ formatTime(v.ExpectedAt || v.expected_at) }}</td>
          <td>
            <b>{{ v.VisitorName || v.visitor_name }}</b>
            <div v-if="v.VisitorEmail || v.visitor_email" class="muted text-sm">
              {{ v.VisitorEmail || v.visitor_email }}
            </div>
          </td>
          <td>{{ v.VisitorCompany || v.visitor_company || '—' }}</td>
          <td>{{ v.Purpose || v.purpose || '—' }}</td>
          <td><span :class="statusClass(v.Status || v.status)">{{ v.Status || v.status }}</span></td>
          <td>
            <button v-if="(v.Status || v.status) === 'Expected'" type="button"
                    class="btn ghost sm" @click="checkin(v)">
              {{ $t('admin.visitors.checkin') }}
            </button>
            <button v-else-if="(v.Status || v.status) === 'Checked In'" type="button"
                    class="btn ghost sm" @click="checkout(v)">
              {{ $t('admin.visitors.checkout') }}
            </button>
          </td>
        </tr>
        <tr v-if="!visits.length">
          <td colspan="6" class="muted" style="text-align: center; padding: 24px;">
            {{ $t('admin.visitors.empty') }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { RefreshCcw } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import { api } from '../api'

const filter = reactive({ status: '' })
const visits = ref([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const url = '/api/v1/admin/visits' + (filter.status ? `?status=${encodeURIComponent(filter.status)}` : '')
    const r = await api.get(url)
    visits.value = r.data || []
  } finally { loading.value = false }
}

async function checkin(v)  { await api.post(`/api/v1/visits/${v.ID || v.id}/checkin`); await load() }
async function checkout(v) { await api.post(`/api/v1/visits/${v.ID || v.id}/checkout`); await load() }

function formatTime(t) { return t ? new Date(t).toLocaleString() : '—' }
function statusClass(s) {
  if (s === 'Checked In')  return 'tag success'
  if (s === 'Checked Out') return 'tag'
  if (s === 'No Show')     return 'tag warning'
  if (s === 'Cancelled')   return 'tag'
  return 'tag info'
}

onMounted(load)
</script>
