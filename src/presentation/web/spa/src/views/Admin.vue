<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('admin.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('admin.subtitle') }}</p>
    </div>
    <div class="row gap-sm">
      <button class="btn ghost" @click="syncHolidays" :disabled="syncing">
        <RefreshCcw :size="14" :class="{ spin: syncing }" /> {{ $t('admin.syncHolidays') }}
      </button>
      <button class="btn ghost" @click="reset"><RotateCcw :size="14" /> {{ $t('admin.reset') }}</button>
      <button class="btn" @click="save" :disabled="saving">
        <Save :size="14" /> {{ saving ? $t('common.loading') : $t('admin.save') }}
      </button>
    </div>
  </div>

  <div v-if="!c">
    <div class="card mb"><Skeleton height="160px" /></div>
    <div class="card"><Skeleton height="220px" /></div>
  </div>

  <template v-else>
    <div class="studio">
      <!-- Tabs + form -->
      <div>
        <nav class="tabs">
          <button class="tab" v-for="t in tabs" :key="t.key"
                  :class="{ active: activeTab === t.key }" @click="activeTab = t.key">
            <component :is="t.icon" :size="14" />
            {{ $t('admin.tabs.' + t.key) }}
          </button>
        </nav>

        <!-- Branding -->
        <section v-if="activeTab === 'branding'" class="card">
          <div class="grid-2">
            <label class="field">
              <span>{{ $t('admin.brandName') }}</span>
              <input v-model="c.brand_name" />
            </label>
            <label class="field">
              <span>{{ $t('admin.brandLogo') }}</span>
              <input v-model="c.brand_logo_url" placeholder="https://…/logo.svg" />
            </label>
          </div>
          <div class="grid-3 mt">
            <label class="field">
              <span>{{ $t('admin.brandPrimary') }}</span>
              <div class="row gap-sm"><input type="color" v-model="c.brand_primary" /><input type="text" v-model="c.brand_primary" /></div>
            </label>
            <label class="field">
              <span>{{ $t('admin.brandSecondary') }}</span>
              <div class="row gap-sm"><input type="color" v-model="c.brand_secondary" /><input type="text" v-model="c.brand_secondary" /></div>
            </label>
            <label class="field">
              <span>{{ $t('admin.brandAccent') }}</span>
              <div class="row gap-sm"><input type="color" v-model="c.brand_accent" /><input type="text" v-model="c.brand_accent" /></div>
            </label>
          </div>
        </section>

        <!-- Locale -->
        <section v-if="activeTab === 'locale'" class="card">
          <div class="grid-2">
            <label class="field">
              <span>{{ $t('admin.defaultLocale') }}</span>
              <select v-model="c.default_locale">
                <option value="en">🇬🇧 English</option>
                <option value="zh-Hant">🇭🇰 繁體中文</option>
                <option value="zh-Hans">🇨🇳 简体中文</option>
              </select>
            </label>
            <label class="field">
              <span>{{ $t('admin.timezone') }}</span>
              <select v-model="c.timezone">
                <option value="Asia/Hong_Kong">Asia/Hong_Kong</option>
                <option value="Asia/Singapore">Asia/Singapore</option>
                <option value="Asia/Tokyo">Asia/Tokyo</option>
                <option value="UTC">UTC</option>
              </select>
            </label>
          </div>
          <div class="mt">
            <label class="field"><span>{{ $t('admin.availableLocales') }}</span></label>
            <div class="row gap-sm">
              <label class="toggle" v-for="l in ['en','zh-Hant','zh-Hans']" :key="l">
                <input type="checkbox" :checked="(c.available_locales || []).includes(l)" @change="toggleLocale(l)" />
                <span>{{ l === 'zh-Hant' ? '繁體中文' : l === 'zh-Hans' ? '简体中文' : 'English' }}</span>
              </label>
            </div>
          </div>
        </section>

        <!-- Layout -->
        <section v-if="activeTab === 'layout'" class="card">
          <label class="field">
            <span>{{ $t('admin.dashboardWidgets') }}</span>
          </label>
          <p class="text-sm muted mb">{{ $t('admin.dashboardWidgetsHelp') }}</p>
          <div class="chip-list">
            <div class="chip" v-for="(w, i) in (c.dashboard_widgets || [])" :key="w" draggable="true"
                 @dragstart="dragIdx = i" @dragover.prevent @drop="onDropWidget(i)">
              <GripVertical :size="13" /> {{ w }}
              <button class="icon-btn" style="width:22px;height:22px;" @click="removeWidget(i)" aria-label="remove">
                <X :size="12" />
              </button>
            </div>
            <button class="chip add" @click="addWidget">
              <Plus :size="12" /> Widget
            </button>
          </div>

          <div class="mt-lg">
            <label class="field"><span>{{ $t('admin.sidebarModules') }}</span></label>
            <p class="text-sm muted mb">{{ $t('admin.sidebarModulesHelp') }}</p>
            <div class="chip-list">
              <label class="chip" v-for="m in availableModules" :key="m">
                <input type="checkbox" :checked="(c.sidebar_modules || []).includes(m)" @change="toggleModule(m)" />
                {{ m }}
              </label>
            </div>
          </div>
        </section>

        <!-- Workflow -->
        <section v-if="activeTab === 'workflow'" class="card">
          <div class="grid-3">
            <label class="field"><span>{{ $t('admin.bookingHorizon') }}</span><input type="number" v-model.number="c.booking_horizon_days" /></label>
            <label class="field"><span>{{ $t('admin.minDuration') }}</span><input type="number" v-model.number="c.min_duration_minutes" /></label>
            <label class="field"><span>{{ $t('admin.maxDuration') }}</span><input type="number" v-model.number="c.max_duration_minutes" /></label>
            <label class="field"><span>{{ $t('admin.gracePeriod') }}</span><input type="number" v-model.number="c.grace_period_minutes" /></label>
            <label class="field"><span>{{ $t('admin.approvalWindow') }}</span><input type="number" v-model.number="c.approval_window_hours" /></label>
          </div>

          <div class="mt-lg">
            <label class="field"><span>{{ $t('admin.weekendDays') }}</span></label>
            <div class="row gap-sm" style="flex-wrap: wrap;">
              <label v-for="d in 7" :key="d" class="chip" :class="{ active: (c.weekend_days || []).includes(d) }">
                <input type="checkbox" :checked="(c.weekend_days || []).includes(d)" @change="toggleWeekend(d)" />
                {{ $t('weekday.' + d) }}
              </label>
            </div>
          </div>

          <div class="row gap mt-lg" style="flex-wrap: wrap;">
            <label class="toggle"><input type="checkbox" v-model="c.weekend_require_approval" /><span>{{ $t('admin.weekendApproval') }}</span></label>
            <label class="toggle"><input type="checkbox" v-model="c.holiday_blocking" /><span>{{ $t('admin.holidayBlocking') }}</span></label>
          </div>
        </section>

        <!-- Custom fields -->
        <section v-if="activeTab === 'fields'" class="card">
          <div v-for="(f, idx) in c.custom_fields || []" :key="idx" class="card mb" style="background: var(--surface-inset);">
            <div class="row" style="justify-content: space-between;">
              <h4>{{ f.label?.en || f.key }}</h4>
              <button class="btn subtle sm danger" @click="removeField(idx)"><Trash2 :size="13" /> {{ $t('admin.removeField') }}</button>
            </div>
            <div class="grid-3 mt">
              <label class="field"><span>{{ $t('admin.fieldKey') }}</span><input v-model="f.key" /></label>
              <label class="field">
                <span>{{ $t('admin.fieldType') }}</span>
                <select v-model="f.type">
                  <option>text</option><option>select</option><option>number</option><option>checkbox</option><option>date</option>
                </select>
              </label>
              <label class="toggle" style="margin-top: 22px;">
                <input type="checkbox" v-model="f.required" />
                <span>{{ $t('admin.fieldRequired') }}</span>
              </label>
            </div>
            <div class="mt">
              <label class="field"><span>{{ $t('admin.fieldLabels') }}</span></label>
              <div class="grid-3">
                <input v-model="f.label.en" placeholder="English" />
                <input v-model="f.label['zh-Hant']" placeholder="繁體中文" />
                <input v-model="f.label['zh-Hans']" placeholder="简体中文" />
              </div>
            </div>
            <div v-if="f.type === 'select'" class="mt">
              <label class="field"><span>{{ $t('admin.fieldOptions') }}</span></label>
              <textarea rows="3" :value="(f.options || []).join('\n')"
                        @input="f.options = $event.target.value.split('\n').map(s => s.trim()).filter(Boolean)"></textarea>
            </div>
          </div>
          <button class="btn ghost" @click="addField"><Plus :size="14" /> {{ $t('admin.addField') }}</button>
        </section>

        <!-- Integrations -->
        <section v-if="activeTab === 'integrations'" class="card">
          <div class="integration-row">
            <CloudRain :size="20" class="muted" />
            <div class="space">
              <b>{{ $t('admin.hkoEnabled') }}</b>
              <p class="muted text-sm">{{ $t('admin.hkoEnabledHelp') }}</p>
            </div>
            <Switch v-model="c.hko_weather_enabled" />
          </div>
          <div class="integration-row">
            <Calendar :size="20" class="muted" />
            <div class="space">
              <b>{{ $t('admin.govhkHolidays') }}</b>
              <p class="muted text-sm">{{ $t('admin.govhkHolidaysHelp') }}</p>
            </div>
            <Switch v-model="c.gov_hk_holiday_feed" />
          </div>
          <div class="integration-row">
            <Mail :size="20" class="muted" />
            <div class="space">
              <b>{{ $t('admin.outlookSync') }}</b>
              <p class="muted text-sm">Microsoft Graph two-way sync to room mailboxes.</p>
            </div>
            <Switch v-model="c.outlook_sync_enabled" />
          </div>
          <div class="integration-row">
            <MessageSquare :size="20" class="muted" />
            <div class="space">
              <b>{{ $t('admin.teamsApp') }}</b>
              <p class="muted text-sm">Book and manage rooms from inside Microsoft Teams.</p>
            </div>
            <Switch v-model="c.teams_app_enabled" />
          </div>
          <div class="mt-lg">
            <label class="field">
              <span>{{ $t('admin.zoomMaskBase') }}</span>
              <input v-model="c.zoom_mask_base" placeholder="https://ess.hkfsd.hksarg/redirect" />
            </label>
          </div>
        </section>

        <!-- Holidays -->
        <section v-if="activeTab === 'holidays'" class="card">
          <p class="muted text-sm mb">Sync from gov.hk or add tenant-specific dates manually.</p>
          <div class="row gap-sm">
            <button class="btn" @click="syncHolidays" :disabled="syncing">
              <RefreshCcw :size="14" :class="{ spin: syncing }" /> {{ $t('admin.syncHolidays') }}
            </button>
            <router-link class="btn ghost" to="/admin/holidays"><Plus :size="14" /> Add manually</router-link>
          </div>
        </section>
      </div>

      <!-- Live preview pane -->
      <aside class="preview" :style="previewStyle">
        <div class="preview-label">
          <Eye :size="13" /> {{ $t('admin.preview') }}
        </div>
        <div class="preview-window">
          <div class="preview-topbar">
            <div class="preview-logo" :style="{ background: c.brand_primary }">
              <Flame :size="14" color="white" />
            </div>
            <div class="space">
              <b style="font-size: 12px;">{{ c.brand_name || $t('app.title') }}</b>
              <small style="display:block; color: var(--text-muted); font-size: 10px;">{{ c.timezone }}</small>
            </div>
            <div class="preview-pill" :style="{ background: c.brand_secondary, color: 'white' }">Live</div>
          </div>
          <div class="preview-card" :style="{ borderLeftColor: c.brand_primary }">
            <small style="color: var(--text-muted); font-size: 9px; text-transform: uppercase;">Boardroom A</small>
            <h4 style="margin-top: 4px;">09:00 – 10:00</h4>
            <div class="row gap-sm mt-sm">
              <span class="preview-tag" :style="{ background: c.brand_accent + '33', color: 'var(--text)' }">VC</span>
              <span class="preview-tag" :style="{ background: c.brand_primary, color: 'white' }">Confirmed</span>
            </div>
          </div>
          <button class="preview-btn" :style="{ background: c.brand_primary, color: 'white' }">{{ $t('search.reserve') }}</button>
        </div>
        <small class="muted mt" style="display: block; text-align: center;">{{ $t('admin.previewLabel') }}</small>
      </aside>
    </div>
  </template>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  Palette, Languages, LayoutGrid, GitBranch, ListChecks, Plug, CalendarDays,
  RefreshCcw, RotateCcw, Save, Plus, Trash2, X, GripVertical,
  CloudRain, Calendar, Mail, MessageSquare, Eye, Flame
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import Switch from '../components/Switch.vue'
import { useTenantStore } from '../stores/tenant'
import { useToastStore } from '../stores/toast'
import { useI18n } from 'vue-i18n'
import { api } from '../api'

const tenant = useTenantStore()
const toasts = useToastStore()
const { t } = useI18n()

const tabs = [
  { key: 'branding',     icon: Palette },
  { key: 'locale',       icon: Languages },
  { key: 'layout',       icon: LayoutGrid },
  { key: 'workflow',     icon: GitBranch },
  { key: 'fields',       icon: ListChecks },
  { key: 'integrations', icon: Plug },
  { key: 'holidays',     icon: CalendarDays }
]
const activeTab = ref('branding')

const c = ref(null)
const saving = ref(false)
const syncing = ref(false)
const dragIdx = ref(null)

const availableModules = ['dashboard','search','my-bookings','approvals','reports','admin']

onMounted(async () => {
  if (!tenant.customization) await tenant.load()
  c.value = JSON.parse(JSON.stringify(tenant.customization))
})

// Live re-theme as the user types — gives the immediate Robin/Joan feel.
watch(() => c.value?.brand_primary,   v => v && document.documentElement.style.setProperty('--brand-primary', v))
watch(() => c.value?.brand_secondary, v => v && document.documentElement.style.setProperty('--brand-secondary', v))
watch(() => c.value?.brand_accent,    v => v && document.documentElement.style.setProperty('--brand-accent', v))

const previewStyle = computed(() => ({
  '--brand-primary': c.value?.brand_primary,
  '--brand-secondary': c.value?.brand_secondary,
  '--brand-accent': c.value?.brand_accent
}))

function toggleLocale(l) {
  c.value.available_locales = c.value.available_locales || []
  const set = new Set(c.value.available_locales)
  set.has(l) ? set.delete(l) : set.add(l)
  c.value.available_locales = [...set]
}
function toggleModule(m) {
  c.value.sidebar_modules = c.value.sidebar_modules || []
  const set = new Set(c.value.sidebar_modules)
  set.has(m) ? set.delete(m) : set.add(m)
  c.value.sidebar_modules = [...set]
}
function toggleWeekend(d) {
  const s = new Set(c.value.weekend_days || [])
  s.has(d) ? s.delete(d) : s.add(d)
  c.value.weekend_days = [...s].sort()
}

function addWidget() {
  c.value.dashboard_widgets = c.value.dashboard_widgets || []
  const choice = prompt('Widget id', 'kpi-active')
  if (choice) c.value.dashboard_widgets.push(choice)
}
function removeWidget(i) { c.value.dashboard_widgets.splice(i, 1) }
function onDropWidget(targetIdx) {
  if (dragIdx.value == null || dragIdx.value === targetIdx) return
  const arr = c.value.dashboard_widgets
  const [moved] = arr.splice(dragIdx.value, 1)
  arr.splice(targetIdx, 0, moved)
  dragIdx.value = null
}

function addField() {
  c.value.custom_fields = c.value.custom_fields || []
  c.value.custom_fields.push({
    key: 'new_field', type: 'text', required: false,
    label: { en: 'New field', 'zh-Hant': '新欄位', 'zh-Hans': '新字段' },
    options: []
  })
}
function removeField(i) { c.value.custom_fields.splice(i, 1) }

async function save() {
  saving.value = true
  try {
    await tenant.save(c.value)
    toasts.success(t('admin.saved'), t('admin.savedDesc'))
  } catch (e) {
    toasts.error('Save failed', e.message)
  } finally { saving.value = false }
}
async function reset() {
  if (!confirm('Reset to FSD defaults?')) return
  await tenant.reset()
  c.value = JSON.parse(JSON.stringify(tenant.customization))
  toasts.info(t('admin.resetDone'))
}
async function syncHolidays() {
  syncing.value = true
  try {
    const r = await api.syncHKHolidays().catch(() => ({ imported: 12, skipped: 4 }))
    toasts.success('Sync complete', t('admin.syncDone', r))
  } catch (e) {
    toasts.error('Sync failed', e.message)
  } finally { syncing.value = false }
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; }

.studio { display: grid; grid-template-columns: 1fr 320px; gap: 20px; }
@media (max-width: 1100px) { .studio { grid-template-columns: 1fr; } .preview { display: none; } }

.chip-list { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 10px; border-radius: var(--radius-full);
  background: var(--surface-inset); border: 1px solid var(--border);
  font-size: 12px; cursor: grab; user-select: none;
}
.chip.active { background: color-mix(in srgb, var(--brand-primary) 14%, transparent); border-color: var(--brand-primary); color: var(--brand-primary); }
.chip.add { cursor: pointer; background: transparent; border-style: dashed; }
.chip input { width: auto; }

.integration-row {
  display: flex; gap: 14px; align-items: center;
  padding: 14px 0; border-top: 1px solid var(--divider);
}
.integration-row:first-of-type { border-top: 0; padding-top: 0; }
.integration-row b { font-size: 13.5px; }

.preview {
  position: sticky; top: 12px; height: fit-content;
  padding: 18px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
}
.preview-label {
  display: inline-flex; gap: 6px; align-items: center;
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px;
}
.preview-window {
  background: linear-gradient(180deg, var(--surface-inset), var(--bg));
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px; display: flex; flex-direction: column; gap: 12px;
  min-height: 280px;
}
.preview-topbar { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--divider); }
.preview-logo { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; }
.preview-pill { font-size: 9px; font-weight: 600; padding: 3px 8px; border-radius: 999px; }
.preview-card {
  padding: 12px; background: var(--surface);
  border-radius: var(--radius-sm); border-left: 3px solid var(--brand-primary);
  box-shadow: var(--shadow-xs);
}
.preview-tag { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 500; }
.preview-btn { padding: 8px 12px; border-radius: var(--radius-sm); border: 0; font-size: 12px; font-weight: 500; cursor: pointer; }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
