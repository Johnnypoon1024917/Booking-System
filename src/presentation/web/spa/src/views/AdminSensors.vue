<!--
  IoT sensor inventory + enrolment.
  Lists the tenant's devices with last-seen + last-value; the enrol form
  registers a new device and returns the shared secret ONCE (the operator
  must copy it onto the physical sensor before navigating away).
-->
<template>
  <div class="page-header mb-lg">
    <h1>{{ $t('admin.sensors.title') }}</h1>
    <p class="muted text-md mt-sm">{{ $t('admin.sensors.subtitle') }}</p>
  </div>

  <section class="card mb-lg" aria-labelledby="enrol-h">
    <h2 id="enrol-h">{{ $t('admin.sensors.enrol') }}</h2>
    <p class="muted text-sm">{{ $t('admin.sensors.enrolHelp') }}</p>
    <div class="grid-3 mt">
      <label class="field">
        <span>{{ $t('admin.sensors.deviceId') }}</span>
        <input v-model="form.device_id" placeholder="presence-rm-12a"/>
      </label>
      <label class="field">
        <span>{{ $t('admin.sensors.kind') }}</span>
        <select v-model="form.kind">
          <option value="presence">presence</option>
          <option value="co2">co2</option>
          <option value="temp">temp</option>
          <option value="humidity">humidity</option>
          <option value="desk-occupancy">desk-occupancy</option>
        </select>
      </label>
      <label class="field">
        <span>{{ $t('admin.sensors.resourceId') }}</span>
        <input v-model="form.resource_id" placeholder="resource UUID (optional)"/>
      </label>
    </div>
    <button type="button" class="btn mt" @click="enrol" :disabled="busy || !form.device_id">
      {{ $t('admin.sensors.enrol') }}
    </button>
    <div v-if="lastSecret" class="banner warning mt">
      <b>{{ $t('admin.sensors.secretOnce') }}</b>
      <code class="block" style="word-break: break-all; margin-top: 8px;">{{ lastSecret }}</code>
    </div>
  </section>

  <section class="card" aria-labelledby="inv-h">
    <h2 id="inv-h">{{ $t('admin.sensors.inventory') }}</h2>
    <Skeleton v-if="loading" height="200px"/>
    <table v-else class="table" :aria-label="$t('admin.sensors.inventory')">
      <thead>
        <tr>
          <th scope="col">{{ $t('admin.sensors.deviceId') }}</th>
          <th scope="col">{{ $t('admin.sensors.kind') }}</th>
          <th scope="col">{{ $t('admin.sensors.resourceId') }}</th>
          <th scope="col">{{ $t('admin.sensors.lastSeen') }}</th>
          <th scope="col">{{ $t('admin.sensors.lastValue') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in devices" :key="d.id">
          <td><code>{{ d.device_id }}</code></td>
          <td>{{ d.kind }}</td>
          <td><small>{{ d.resource_id || '—' }}</small></td>
          <td>{{ formatTime(d.last_seen_at) }}</td>
          <td>
            <span v-if="d.last_bool !== null">{{ d.last_bool ? 'occupied' : 'free' }}</span>
            <span v-else-if="d.last_value !== null">{{ d.last_value }}</span>
            <span v-else>—</span>
          </td>
        </tr>
        <tr v-if="!devices.length">
          <td colspan="5" class="muted" style="text-align: center; padding: 24px;">
            {{ $t('admin.sensors.empty') }}
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import Skeleton from '../components/Skeleton.vue'
import { api } from '../api'

const form = reactive({ device_id: '', kind: 'presence', resource_id: '' })
const devices = ref([])
const lastSecret = ref('')
const loading = ref(false)
const busy = ref(false)

async function load() {
  loading.value = true
  try {
    const r = await api.get('/api/v1/admin/sensors')
    devices.value = r.data || []
  } finally { loading.value = false }
}

async function enrol() {
  busy.value = true; lastSecret.value = ''
  try {
    const r = await api.post('/api/v1/admin/sensors', form)
    lastSecret.value = r.data.secret
    form.device_id = ''; form.resource_id = ''
    await load()
  } finally { busy.value = false }
}

function formatTime(t) { return t ? new Date(t).toLocaleString() : '—' }

onMounted(load)
</script>
