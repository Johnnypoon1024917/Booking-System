<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('scim.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('scim.subtitle') }}</p>
    </div>
    <button class="btn" @click="issueOpen = true"><Plus :size="14"/> {{ $t('scim.newToken') }}</button>
  </div>

  <div class="card mb">
    <h3 class="mb">{{ $t('scim.endpointTitle') }}</h3>
    <div class="grid-2">
      <label class="field">
        <span>{{ $t('scim.scimEndpoint') }}</span>
        <div class="row gap-sm" style="align-items: center;">
          <input :value="scimEndpoint" readonly />
          <button class="icon-btn" @click="copy(scimEndpoint)"><Copy :size="14"/></button>
        </div>
      </label>
      <label class="field">
        <span>{{ $t('scim.tenantUrl') }}</span>
        <div class="row gap-sm" style="align-items: center;">
          <input :value="scimTenantURL" readonly />
          <button class="icon-btn" @click="copy(scimTenantURL)"><Copy :size="14"/></button>
        </div>
      </label>
    </div>
    <details class="mt">
      <summary style="cursor: pointer; color: var(--text-muted); font-size: 12px;">{{ $t('scim.howTo') }}</summary>
      <ol style="font-size: 13px; line-height: 1.7; color: var(--text-secondary); margin-top: 8px;">
        <li>{{ $t('scim.step1') }}</li>
        <li>{{ $t('scim.step2') }}</li>
        <li>{{ $t('scim.step3') }}</li>
        <li>{{ $t('scim.step4') }}</li>
      </ol>
    </details>
  </div>

  <div v-if="loading"><Skeleton height="180px"/></div>
  <EmptyState v-else-if="!tokens.length" :icon="KeyRound" :title="$t('scim.noTokens')" :description="$t('scim.noTokensDesc')"/>
  <div v-else class="card" style="padding:0;">
    <div class="t-row header">
      <div>{{ $t('scim.name') }}</div>
      <div>{{ $t('scim.prefix') }}</div>
      <div>{{ $t('common.status') }}</div>
      <div></div>
    </div>
    <div class="t-row" v-for="t in tokens" :key="t.ID">
      <div>{{ t.Name }}</div>
      <div><code style="font-size:12px;">scim_{{ t.Prefix }}…</code></div>
      <div>
        <span class="tag" :class="t.IsActive ? 'success' : 'danger'">
          {{ t.IsActive ? $t('common.active') : $t('common.inactive') }}
        </span>
      </div>
      <div><button class="btn ghost danger sm" v-if="t.IsActive" @click="revoke(t)"><Trash2 :size="13"/></button></div>
    </div>
  </div>

  <Modal v-if="issueOpen" @close="issueOpen = false; newName = ''" :title="$t('scim.newToken')">
    <p class="muted text-sm mb">{{ $t('scim.issueHelp') }}</p>
    <label class="field">
      <span>{{ $t('scim.tokenName') }}</span>
      <input v-model="newName" :placeholder="$t('scim.tokenNamePh')" />
    </label>
    <template #footer>
      <button class="btn ghost" @click="issueOpen = false">{{ $t('common.cancel') }}</button>
      <button class="btn" :disabled="busy" @click="issue"><KeyRound :size="13"/> {{ $t('scim.issue') }}</button>
    </template>
  </Modal>

  <Modal v-if="issuedToken" @close="issuedToken = null" :title="$t('scim.savedTitle')">
    <p class="muted text-sm mb">{{ $t('scim.savedBody') }}</p>
    <div class="card" style="background: var(--surface-inset);">
      <code style="font-size: 13px; word-break: break-all;">{{ issuedToken }}</code>
    </div>
    <template #footer>
      <button class="btn ghost" @click="copy(issuedToken)">{{ $t('webhooks.copy') }}</button>
      <button class="btn" @click="issuedToken = null">{{ $t('webhooks.gotIt') }}</button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, KeyRound, Copy, Trash2 } from 'lucide-vue-next'
import Skeleton from '../components/Skeleton.vue'
import EmptyState from '../components/EmptyState.vue'
import Modal from '../components/Modal.vue'
import { api } from '../api'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toasts = useToastStore()
const loading = ref(true)
const busy = ref(false)
const tokens = ref([])
const issueOpen = ref(false)
const newName = ref('')
const issuedToken = ref(null)

const scimEndpoint = computed(() => location.origin + '/scim/v2')
const scimTenantURL = computed(() => location.origin + '/scim/v2/Users')

onMounted(load)

async function load() {
  loading.value = true
  try { tokens.value = await api.listScimTokens() || [] }
  catch (e) { toasts.error('Could not load', e.message) }
  finally { loading.value = false }
}

async function issue() {
  busy.value = true
  try {
    const r = await api.issueScimToken(newName.value || 'Azure AD provisioning')
    issueOpen.value = false
    newName.value = ''
    issuedToken.value = r.token
    load()
  } catch (e) { toasts.error('Issue failed', e.message) }
  finally { busy.value = false }
}

async function revoke(token) {
  if (!confirm(token.Name + ' — Revoke this token?')) return
  try {
    await api.revokeScimToken(token.ID)
    load()
  } catch (e) { toasts.error('Revoke failed', e.message) }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    toasts.success(t('webhooks.copied'))
  } catch {}
}
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.t-row {
  display: grid; grid-template-columns: 2fr 1.5fr 100px 60px;
  gap: 12px; padding: 12px 18px; align-items: center;
  border-bottom: 1px solid var(--divider);
}
.t-row.header {
  background: var(--surface-inset); font-size: 11px; font-weight: 600;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;
}
.t-row:last-child { border-bottom: 0; }
</style>
