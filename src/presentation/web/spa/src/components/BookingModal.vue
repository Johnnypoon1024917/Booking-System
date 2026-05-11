<template>
  <Modal @close="$emit('close')">
    <template #header>
      <div class="row gap-sm">
        <CalendarPlus :size="18" />
        <span>{{ $t('booking.confirm') }}</span>
      </div>
    </template>

    <!-- Summary -->
    <div class="summary">
      <div class="thumb" :style="{ background: 'linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))' }">
        <Building2 :size="20" color="white" />
      </div>
      <div class="space">
        <h3>{{ resource.Name || resource.name }}</h3>
        <small class="muted">{{ resource.Location || resource.location }} · {{ resource.Capacity || resource.capacity }} pax</small>
      </div>
    </div>

    <div class="time-row mt mb-lg">
      <div class="row gap-sm"><Calendar :size="14" /> {{ formatDate(date) }}</div>
      <div class="row gap-sm"><Clock :size="14" /> {{ start }} – {{ end }}</div>
      <span class="tag" :class="needsApproval ? 'warning' : 'success'">
        {{ needsApproval ? $t('search.approval') : $t('booking.autoApproved') }}
      </span>
    </div>

    <!-- Recurrence -->
    <div class="card recurrence mb">
      <label class="toggle">
        <input type="checkbox" v-model="recur"/>
        <span><Repeat :size="13"/> {{ $t('booking.makeRecurring') }}</span>
      </label>
      <div v-if="recur" class="grid-2 mt">
        <label class="field">
          <span>{{ $t('booking.pattern') }}</span>
          <select v-model="pattern">
            <option value="daily">{{ $t('booking.daily') }}</option>
            <option value="weekly">{{ $t('booking.weekly') }}</option>
            <option value="bi-weekly">{{ $t('booking.biweekly') }}</option>
            <option value="monthly">{{ $t('booking.monthly') }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ $t('booking.occurrences') }}</span>
          <input type="number" v-model.number="count" min="1" max="100"/>
        </label>
      </div>
    </div>

    <!-- Custom fields -->
    <div v-if="customFields.length">
      <label class="field" v-for="f in customFields" :key="f.key">
        <span>{{ f.label?.[locale] || f.label?.en || f.key }}{{ f.required ? ' *' : '' }}</span>
        <select v-if="f.type === 'select'" v-model="customData[f.key]">
          <option disabled value="">—</option>
          <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
        </select>
        <input v-else-if="f.type === 'number'" type="number" v-model.number="customData[f.key]" />
        <input v-else-if="f.type === 'date'" type="date" v-model="customData[f.key]" />
        <label v-else-if="f.type === 'checkbox'" class="toggle" style="margin-top:4px;">
          <input type="checkbox" v-model="customData[f.key]" />
          <span>{{ f.label?.[locale] || f.key }}</span>
        </label>
        <input v-else type="text" v-model="customData[f.key]" />
      </label>
    </div>

    <label class="field">
      <span>{{ $t('booking.title') }} <span v-if="true">*</span></span>
      <input v-model="title" placeholder="e.g. Weekly Team Sync" required />
    </label>

    <label class="field">
      <span>{{ $t('booking.meetingURL') }}</span>
      <input v-model="meetingURL" placeholder="https://teams.microsoft.com/…" />
    </label>

    <!-- Result panel -->
    <div v-if="result" class="result mt">
      <div class="row gap" style="align-items: flex-start;">
        <div class="result-icon" :class="result.requires_approval ? 'pending' : 'ok'">
          <Clock v-if="result.requires_approval" :size="16" />
          <Check v-else :size="16" />
        </div>
        <div class="space">
          <b>{{ result.requires_approval ? $t('booking.pending') : $t('booking.success') }}</b>
          <p class="muted text-sm">{{ result.requires_approval ? $t('booking.pendingDesc') : $t('booking.successDesc') }}</p>
        </div>
      </div>

      <div v-if="result.checkin_token" class="qr-block mt">
        <canvas ref="qrCanvas" />
        <div class="text-sm muted" style="text-align: center; margin-top: 8px;">
          {{ $t('booking.qr') }}
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn ghost" @click="$emit('close')">{{ $t('booking.cancel') }}</button>
      <button class="btn" :disabled="busy || !!result" @click="submit">
        <Loader2 v-if="busy" :size="14" class="spin" />
        {{ $t('booking.submit') }}
      </button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, nextTick, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { Building2, Calendar, Clock, Check, CalendarPlus, Loader2, Repeat } from 'lucide-vue-next'
import Modal from './Modal.vue'
import { api } from '../api'
import { useTenantStore } from '../stores/tenant'
import { useToastStore } from '../stores/toast'

const props = defineProps(['resource', 'date', 'start', 'end'])
const emit = defineEmits(['close', 'booked'])

const tenant = useTenantStore()
const toasts = useToastStore()
const { locale } = useI18n()
const customFields = computed(() => tenant.customization?.custom_fields || [])
const customData = reactive({})
const title = ref('')
const meetingURL = ref('')
const busy = ref(false)
const result = ref(null)
const qrCanvas = ref(null)

const recur = ref(false)
const pattern = ref('weekly')
const count = ref(4)

const needsApproval = computed(() => props.resource.RequiresApproval || props.resource.requires_approval)

function formatDate(d) {
  if (!d) return ''
  return new Date(d + 'T00:00:00').toLocaleDateString(locale.value, { weekday: 'long', month: 'short', day: 'numeric' })
}

async function submit() {
  busy.value = true
  try {
    // Convert local date+time to proper ISO with timezone offset
    const startLocal = new Date(`${props.date}T${props.start}:00`)
    const endLocal = new Date(`${props.date}T${props.end}:00`)
    const r = await api.createBooking({
      resource_id: props.resource.ID || props.resource.id,
      start_time: startLocal.toISOString(),
      end_time: endLocal.toISOString(),
      title: title.value || undefined,
      meeting_url: meetingURL.value || undefined,
      custom_data: customData,
      recurrence: recur.value ? { pattern: pattern.value, count: count.value } : undefined
    })
    result.value = r || { status: 'Confirmed' }
    if (result.value.checkin_token) {
      await nextTick()
      QRCode.toCanvas(qrCanvas.value, location.origin + '/api/v1/checkin/' + result.value.checkin_token, { width: 200, margin: 1 })
    }
    setTimeout(() => emit('booked'), 1600)
  } catch (e) {
    toasts.error('Booking failed', e.message)
  } finally { busy.value = false }
}
</script>

<style scoped>
.summary { display: flex; gap: 14px; align-items: center; }
.thumb { width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center; }

.time-row {
  display: flex; gap: 14px; flex-wrap: wrap;
  padding: 10px 12px;
  background: var(--surface-inset);
  border-radius: var(--radius-sm);
  font-size: 13px; color: var(--text-secondary);
}

.recurrence { background: var(--surface-inset); border: 1px dashed var(--border); }

.result {
  padding: 16px; border-radius: var(--radius);
  background: var(--surface-inset);
  border: 1px solid var(--border);
}
.result-icon {
  width: 32px; height: 32px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--success-bg); color: var(--success); flex-shrink: 0;
}
.result-icon.pending { background: var(--warning-bg); color: var(--warning); }

.qr-block { padding: 16px; background: white; border-radius: var(--radius-sm); display: grid; place-items: center; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
