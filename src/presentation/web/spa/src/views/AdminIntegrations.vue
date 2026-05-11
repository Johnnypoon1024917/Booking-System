<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('integrations.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('integrations.subtitle') }}</p>
    </div>
  </div>

  <div class="tabs mb">
    <button class="tab" :class="{ active: tab === 'providers' }" @click="tab = 'providers'">
      <Plug :size="13"/> {{ $t('integrations.providers') }}
    </button>
    <button class="tab" :class="{ active: tab === 'mailboxes' }" @click="tab = 'mailboxes'">
      <Mail :size="13"/> {{ $t('integrations.mailboxes') }}
    </button>
  </div>

  <!-- Providers tab -->
  <template v-if="tab === 'providers'">
    <div class="card mb">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div class="row gap" style="align-items: flex-start;">
          <div class="ms-icon"><span>M365</span></div>
          <div>
            <h3 style="margin:0;">Microsoft 365 / Outlook</h3>
            <p class="muted text-sm mt-sm">{{ $t('integrations.msDesc') }}</p>
            <div v-if="msStatus" class="mt-sm">
              <span class="tag" :class="msStatus.cls">{{ msStatus.text }}</span>
              <small class="muted ml-sm">{{ msStatus.detail }}</small>
            </div>
          </div>
        </div>
        <div class="row gap-sm">
          <button class="btn ghost" @click="testMS" :disabled="!msSaved || testing">
            <CheckCheck :size="13"/> {{ testing ? $t('common.loading') : $t('integrations.testConnection') }}
          </button>
          <button v-if="msSaved" class="btn ghost danger" @click="deleteMS"><Trash2 :size="13"/></button>
        </div>
      </div>

      <div class="grid-2 mt-lg">
        <label class="field">
          <span>{{ $t('integrations.azureTenantId') }}</span>
          <input v-model="ms.azure_tenant_id" placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" />
        </label>
        <label class="field">
          <span>{{ $t('integrations.clientId') }}</span>
          <input v-model="ms.client_id" placeholder="00000000-0000-0000-0000-000000000000" />
        </label>
        <label class="field" style="grid-column: 1 / -1;">
          <span>{{ $t('integrations.clientSecret') }}</span>
          <input v-model="ms.client_secret" type="password" :placeholder="msSaved ? '•••••••••• (leave blank to keep)' : 'Application secret value'" />
          <small class="muted">{{ $t('integrations.secretHelp') }}</small>
        </label>
      </div>
      <div class="row mt">
        <button class="btn" @click="saveMS" :disabled="busy">
          <Save :size="13"/> {{ $t('common.save') }}
        </button>
      </div>
      <details class="mt-lg">
        <summary style="cursor:pointer; color: var(--text-muted); font-size: 12px;">{{ $t('integrations.howTo') }}</summary>
        <ol style="font-size: 13px; line-height: 1.7; color: var(--text-secondary); margin-top: 8px;">
          <li>{{ $t('integrations.step1') }}</li>
          <li>{{ $t('integrations.step2') }}</li>
          <li>{{ $t('integrations.step3') }}</li>
          <li>{{ $t('integrations.step4') }}</li>
          <li>{{ $t('integrations.step5') }}</li>
        </ol>
      </details>
    </div>

    <div class="card mb">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div class="row gap" style="align-items: flex-start;">
          <div class="teams-icon"><MessageSquare :size="20" color="white"/></div>
          <div>
            <h3 style="margin:0;">Microsoft Teams</h3>
            <p class="muted text-sm mt-sm">{{ $t('integrations.teamsDesc') }}</p>
          </div>
        </div>
        <div class="row gap-sm">
          <a class="btn ghost" href="/api/v1/teams/manifest" target="_blank">
            <Download :size="13"/> {{ $t('integrations.downloadManifest') }}
          </a>
        </div>
      </div>
    </div>
  </template>

  <!-- Mailbox map tab -->
  <template v-else>
    <div class="card mb">
      <p class="muted text-sm mb">{{ $t('integrations.mailboxesHelp') }}</p>
      <div class="grid-2">
        <label class="field">
          <span>{{ $t('integrations.resource') }}</span>
          <select v-model="mb.resource_id">
            <option value="">—</option>
            <option v-for="r in resources" :key="r.ID" :value="r.ID">{{ r.Name }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ $t('integrations.mailboxUpn') }}</span>
          <input v-model="mb.mailbox_upn" placeholder="boardroom.a@fsd.gov.hk"/>
        </label>
        <label class="field" style="grid-column: 1 / -1;">
          <span>{{ $t('integrations.displayName') }}</span>
          <input v-model="mb.display_name" placeholder="Boardroom A"/>
        </label>
      </div>
      <button class="btn mt" @click="saveMailbox" :disabled="!mb.resource_id || !mb.mailbox_upn || busy">
        <Plus :size="13"/> {{ $t('integrations.addMapping') }}
      </button>
    </div>

    <div v-if="loadingMb"><Skeleton height="120px"/></div>
    <EmptyState v-else-if="!mailboxes.length" :icon="Mail" :title="$t('integrations.noMappings')"/>
    <div v-else class="card" style="padding:0;">
      <div class="map-row header">
        <div>{{ $t('integrations.resource') }}</div>
        <div>{{ $t('integrations.mailboxUpn') }}</div>
        <div>{{ $t('common.status') }}</div>
        <div></div>
      </div>
      <div class="map-row" v-for="m in mailboxes" :key="m.ResourceID">
        <div class="truncate">{{ resourceName(m.ResourceID) }}</div>
        <div class="truncate"><code style="font-size:12px;">{{ m.MailboxUPN }}</code></div>
        <div><span class="tag" :class="m.IsActive ? 'success' : 'danger'">{{ m.IsActive ? $t('common.active') : $t('common.inactive') }}</span></div>
        <div><button class="btn ghost danger sm" @click="removeMailbox(m)"><Trash2 :size="13"/></button></div>
      </div>
    </div>
  </template>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Plug, Mail, MessageSquare, CheckCheck, Trash2, Save, Plus, Download
} from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const tab = ref('providers')
const busy = ref(false)
const testing = ref(false)
const loadingMb = ref(false)

const ms = reactive({ azure_tenant_id: '', client_id: '', client_secret: '' })
const msSaved = ref(false)
const msStatus = ref(null)

const resources = ref([])
const mailboxes = ref([])
const mb = reactive({ resource_id: '', mailbox_upn: '', display_name: '' })
const resourceMap = computed(() => Object.fromEntries(resources.value.map(r => [r.ID, r])))
const resourceName = id => resourceMap.value[id]?.Name || id

onMounted(async () => {
  await loadProviders()
  await loadMailboxes()
})

watch(tab, t => { if (t === 'mailboxes') loadMailboxes() })

async function loadProviders() {
  try {
    const list = await api.listIntegrations() || []
    const m = list.find(c => c.Provider === 'microsoft')
    if (m) {
      msSaved.value = true
      ms.azure_tenant_id = m.AzureTenantID || ''
      ms.client_id = m.ClientID || ''
      ms.client_secret = '' // never reveal
      if (m.LastTestAt) {
        msStatus.value = m.LastTestOK
          ? { cls: 'success', text: t('integrations.connected'), detail: 'Last test ' + new Date(m.LastTestAt).toLocaleString() }
          : { cls: 'danger',  text: t('integrations.failed'),    detail: m.LastTestErr || '' }
      } else {
        msStatus.value = { cls: 'warning', text: t('integrations.untested'), detail: '' }
      }
    }
  } catch (e) { toasts.error('Could not load', e.message) }
}

async function loadMailboxes() {
  loadingMb.value = true
  try {
    const [mbs, rs] = await Promise.all([
      api.listMailboxes(),
      api.listResources().catch(() => [])
    ])
    mailboxes.value = mbs || []
    resources.value = rs || []
  } catch (e) { toasts.error('Could not load', e.message) }
  finally { loadingMb.value = false }
}

async function saveMS() {
  if (!ms.azure_tenant_id || !ms.client_id) {
    toasts.warn(t('integrations.required'))
    return
  }
  busy.value = true
  try {
    await api.saveIntegration('microsoft', {
      AzureTenantID: ms.azure_tenant_id,
      ClientID: ms.client_id,
      ClientSecret: ms.client_secret  // empty leaves stored value untouched
    })
    msSaved.value = true
    ms.client_secret = ''
    toasts.success(t('common.saved'))
    await loadProviders()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function testMS() {
  testing.value = true
  try {
    await api.testIntegration('microsoft')
    toasts.success(t('integrations.testOK'))
    msStatus.value = { cls: 'success', text: t('integrations.connected'), detail: 'just now' }
  } catch (e) {
    toasts.error(t('integrations.testFailed'), e.message)
    msStatus.value = { cls: 'danger', text: t('integrations.failed'), detail: e.message }
  } finally { testing.value = false }
}

async function deleteMS() {
  if (!confirm(t('integrations.confirmDelete'))) return
  busy.value = true
  try {
    await api.deleteIntegration('microsoft')
    msSaved.value = false
    msStatus.value = null
    ms.azure_tenant_id = ''; ms.client_id = ''; ms.client_secret = ''
  } catch (e) { toasts.error('Failed', e.message) }
  finally { busy.value = false }
}

async function saveMailbox() {
  busy.value = true
  try {
    await api.saveMailbox({
      ResourceID:  mb.resource_id,
      MailboxUPN:  mb.mailbox_upn,
      DisplayName: mb.display_name
    })
    mb.resource_id = ''; mb.mailbox_upn = ''; mb.display_name = ''
    toasts.success(t('integrations.mappingAdded'))
    await loadMailboxes()
  } catch (e) { toasts.error('Save failed', e.message) }
  finally { busy.value = false }
}

async function removeMailbox(m) {
  if (!confirm(t('integrations.confirmRemoveMapping'))) return
  try {
    await api.deleteMailbox(m.ResourceID)
    mailboxes.value = mailboxes.value.filter(x => x.ResourceID !== m.ResourceID)
  } catch (e) { toasts.error('Failed', e.message) }
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.ms-icon, .teams-icon {
  width: 44px; height: 44px; border-radius: 12px;
  display: grid; place-items: center; flex-shrink: 0;
  color: white; font-weight: 700; font-size: 12px;
}
.ms-icon { background: linear-gradient(135deg, #5059c9, #7b83eb); }
.teams-icon { background: linear-gradient(135deg, #4b53bc, #5a64dd); }
.ml-sm { margin-left: 6px; }
.map-row {
  display: grid; grid-template-columns: 1.5fr 2fr 100px 60px;
  gap: 12px; padding: 12px 18px; align-items: center;
  border-bottom: 1px solid var(--divider);
}
.map-row.header { background: var(--surface-inset); font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
.map-row:last-child { border-bottom: 0; }
</style>
