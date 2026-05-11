<template>
  <div class="mb-lg">
    <h1>{{ $t('search.title') }}</h1>
    <p class="muted text-md mt-sm">{{ $t('search.subtitle') }}</p>
  </div>

  <div class="search-shell">
    <!-- Filters -->
    <form class="card" @submit.prevent="search" style="position: sticky; top: 12px; height: fit-content;">
      <h3 class="mb">{{ $t('search.title') }}</h3>

      <label class="field">
        <span>{{ $t('search.region') }}</span>
        <select v-model="form.region">
          <option value="Hong Kong">Hong Kong HQ</option>
          <option value="Kowloon">Kowloon Command</option>
          <option value="New Territories">New Territories</option>
        </select>
      </label>

      <div class="grid-2 mt">
        <label class="field">
          <span>{{ $t('search.date') }}</span>
          <input type="date" v-model="form.date" />
        </label>
        <label class="field">
          <span>{{ $t('search.capacity') }}</span>
          <input type="number" v-model.number="form.capacity" min="1" />
        </label>
      </div>

      <div class="grid-2 mt">
        <label class="field">
          <span>{{ $t('search.start') }}</span>
          <input type="time" v-model="form.start" />
        </label>
        <label class="field">
          <span>{{ $t('search.end') }}</span>
          <input type="time" v-model="form.end" />
        </label>
      </div>

      <div class="mt">
        <label class="field"><span>Asset type</span></label>
        <div class="row gap-sm" style="flex-wrap: wrap;">
          <button type="button" class="btn subtle sm" v-for="a in assetTypes" :key="a"
                  :class="{ active: form.assetType === a }" @click="toggleAsset(a)">
            <component :is="iconFor(a)" :size="13" />
            {{ $t('search.assetType.' + a) }}
          </button>
        </div>
      </div>

      <button class="btn lg mt-lg" style="width:100%;" :disabled="busy">
        <Search :size="16" />
        {{ busy ? $t('common.loading') : $t('search.submit') }}
      </button>
    </form>

    <!-- Results -->
    <div>
      <div v-if="busy">
        <div v-for="n in 4" :key="n" class="card mb">
          <div class="row gap">
            <Skeleton height="56px" width="56px" radius="12px" />
            <div class="space col">
              <Skeleton width="40%" height="16px" />
              <Skeleton width="65%" height="12px" />
              <div class="row gap-sm mt-sm"><Skeleton width="60px" height="20px" radius="999px" /><Skeleton width="80px" height="20px" radius="999px" /></div>
            </div>
            <Skeleton width="96px" height="36px" radius="8px" />
          </div>
        </div>
      </div>

      <EmptyState v-else-if="results.length === 0 && hasSearched" :icon="SearchX"
                  :title="$t('search.noResults')" :description="$t('search.tryAgain')" />

      <EmptyState v-else-if="!hasSearched" :icon="MapPinned" title="Pick a time to begin"
                  description="Set your region, date and time on the left, then we'll find available rooms."  />

      <template v-else>
        <div class="row mb" style="justify-content: space-between;">
          <small class="muted">{{ $t('search.results', { n: results.length }) }}</small>
          <small class="muted">{{ form.date }} · {{ form.start }} – {{ form.end }}</small>
        </div>

        <article v-for="r in results" :key="r.ID || r.id" class="card hover resource-card">
          <div class="thumb" :style="{ background: gradientFor(r) }">
            <component :is="iconFor(r.AssetType || r.asset_type)" :size="22" color="white" />
          </div>
          <div class="space">
            <div class="row gap-sm" style="align-items: baseline;">
              <h3>{{ r.Name || r.name }}</h3>
              <span class="tag success"><Check :size="11" /> {{ $t('search.available') }}</span>
              <span v-if="r.RequiresApproval || r.requires_approval" class="tag warning">{{ $t('search.approval') }}</span>
              <span v-if="r.IsRestricted || r.is_restricted" class="tag danger">{{ $t('search.restricted') }}</span>
            </div>
            <div class="muted text-sm mt-sm row gap-sm" style="flex-wrap: wrap;">
              <span><Building2 :size="12" /> {{ r.Location || r.location }}</span>
              <span><Users :size="12" /> {{ r.Capacity || r.capacity }} pax</span>
              <span><Tag :size="12" /> {{ $t('search.assetType.' + (r.AssetType || r.asset_type || 'Room')) }}</span>
            </div>
            <div class="row gap-sm mt-sm" style="flex-wrap: wrap;">
              <span v-for="e in (r.Equipment || r.equipment || [])" :key="e" class="tag">{{ e }}</span>
            </div>
          </div>
          <div class="col gap-sm" style="align-items: stretch;">
            <button class="btn" @click="reserve(r)">{{ $t('search.reserve') }}</button>
            <button class="btn ghost sm">{{ $t('search.viewDetails') }}</button>
          </div>
        </article>
      </template>
    </div>
  </div>

  <BookingModal v-if="picked" :resource="picked" :date="form.date" :start="form.start" :end="form.end"
                @close="picked = null" @booked="onBooked" />
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import {
  Search, SearchX, MapPinned, Building2, Users, Tag, Check,
  DoorOpen, Truck, Wrench, Crown
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import BookingModal from '../components/BookingModal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const today = new Date().toISOString().slice(0, 10)
const form = reactive({ region: 'Hong Kong', date: today, capacity: 4, start: '09:00', end: '10:00', assetType: '' })
const results = ref([])
const busy = ref(false)
const picked = ref(null)
const hasSearched = ref(false)
const toasts = useToastStore()

const assetTypes = ['Room', 'Vehicle', 'Equipment', 'Top Management']

onMounted(() => { search() })

async function search() {
  busy.value = true
  hasSearched.value = true
  try {
    const data = await api.searchRooms({
      location: form.region, date: form.date,
      start_time: form.start, end_time: form.end,
      capacity: form.capacity, asset_type: form.assetType || ''
    })
    let list = Array.isArray(data) ? data : []
    if (form.assetType) {
      list = list.filter(r => (r.AssetType || r.asset_type) === form.assetType)
    }
    results.value = list
  } catch (e) {
    toasts.error('Search failed', e.message)
    results.value = []
  } finally {
    busy.value = false
  }
}

function toggleAsset(a) { form.assetType = form.assetType === a ? '' : a; search() }

function iconFor(t) {
  switch (t) {
    case 'Vehicle':        return Truck
    case 'Equipment':      return Wrench
    case 'Top Management': return Crown
    default:               return DoorOpen
  }
}

function gradientFor(r) {
  const t = r.AssetType || r.asset_type
  if (t === 'Vehicle')        return 'linear-gradient(135deg, #2563eb, #06b6d4)'
  if (t === 'Equipment')      return 'linear-gradient(135deg, #7c3aed, #ec4899)'
  if (t === 'Top Management') return 'linear-gradient(135deg, #b45309, #f59e0b)'
  return 'linear-gradient(135deg, var(--brand-primary), color-mix(in srgb, var(--brand-primary) 60%, var(--brand-secondary)))'
}

function reserve(r) { picked.value = r }
function viewDetails(r) {
  // Surface the same JSON the API returned in a toast — full detail page
  // is on the roadmap. For now this gives admins a quick metadata peek.
  toasts.info(r.Name || r.name, [
    r.Location || r.location,
    `${r.Capacity || r.capacity} pax`,
    r.AssetType || r.asset_type,
    ...((r.Equipment || r.equipment || []))
  ].filter(Boolean).join(' · '))
}
function onBooked() { picked.value = null; toasts.success('Reservation submitted'); search() }
</script>

<style scoped>
.search-shell { display: grid; grid-template-columns: 320px 1fr; gap: 18px; }
@media (max-width: 880px) { .search-shell { grid-template-columns: 1fr; } }

.btn.subtle.active { background: var(--brand-primary); color: white; }

.resource-card {
  display: grid; grid-template-columns: 56px 1fr auto;
  gap: 18px; align-items: center; margin-bottom: 12px;
}
.thumb {
  width: 56px; height: 56px; border-radius: 14px;
  display: grid; place-items: center; box-shadow: var(--shadow-sm);
}
@media (max-width: 600px) {
  .resource-card { grid-template-columns: 1fr; }
  .thumb { width: 48px; height: 48px; }
}
</style>
