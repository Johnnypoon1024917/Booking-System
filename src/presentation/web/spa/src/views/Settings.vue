<!--
  Self-service settings panel — surfaces the Phase 1/2/3 user-facing
  capabilities so people can actually use them without admin help.

  Sections:
    • Account            (read-only profile from the JWT)
    • Multi-factor auth  (enrol, activate, disarm)
    • Calendar feed      (mint a subscribable iCal URL)
    • Browser push       (subscribe / unsubscribe via service worker)
    • Data & privacy     (DSAR export, right-to-erasure)

  Errors are always rendered inline rather than alert()ed so screen
  readers see them. Every button has an explicit type="button" so it
  never accidentally submits an ancestor form.
-->
<template>
  <div class="page-header mb-lg">
    <h1>{{ $t('settings.title') }}</h1>
    <p class="muted text-md mt-sm">{{ $t('settings.subtitle') }}</p>
  </div>

  <section class="card mb-lg" aria-labelledby="acct-h">
    <h2 id="acct-h">{{ $t('settings.account') }}</h2>
    <dl class="kv">
      <dt>{{ $t('settings.username') }}</dt><dd>{{ user.username || '—' }}</dd>
      <dt>{{ $t('settings.role') }}</dt><dd>{{ user.role || '—' }}</dd>
      <dt>{{ $t('settings.tenant') }}</dt><dd><code>{{ user.tenant_id || '—' }}</code></dd>
    </dl>
  </section>

  <section class="card mb-lg" aria-labelledby="mfa-h">
    <h2 id="mfa-h">{{ $t('settings.mfa') }}</h2>
    <p class="muted text-sm">{{ $t('settings.mfaHelp') }}</p>
    <p v-if="mfa.enabled" class="tag success">{{ $t('settings.mfaEnabled') }}</p>
    <p v-else class="tag warning">{{ $t('settings.mfaDisabled') }}</p>

    <div v-if="!mfa.enabled && !mfa.enrolling" class="row gap mt">
      <button type="button" class="btn" @click="enrolMFA" :disabled="busy">{{ $t('settings.mfaEnrol') }}</button>
    </div>

    <div v-else-if="mfa.enrolling" class="mt">
      <ol class="enrol-steps">
        <li>{{ $t('settings.mfaStepInstall') }}</li>
        <li>
          {{ $t('settings.mfaStepScan') }}
          <div class="qr-block">
            <canvas ref="qrCanvas" :aria-label="$t('settings.mfaScan')"></canvas>
          </div>
        </li>
        <li>
          {{ $t('settings.mfaStepManual') }}
          <div class="manual-row">
            <code class="manual-secret">{{ mfa.secret_pretty }}</code>
            <button type="button" class="btn ghost sm" @click="copySecret">{{ $t('common.copy') }}</button>
          </div>
          <small class="muted">{{ $t('settings.mfaManualHint') }}</small>
        </li>
        <li>
          <label class="field">
            <span>{{ $t('settings.mfaStepCode') }}</span>
            <input v-model="mfa.code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*"
                   :aria-describedby="mfa.error ? 'mfa-err' : null" autofocus/>
          </label>
        </li>
      </ol>
      <p v-if="mfa.error" id="mfa-err" class="error">{{ mfa.error }}</p>
      <div class="row gap mt">
        <button type="button" class="btn" @click="activateMFA" :disabled="busy || !mfa.code">{{ $t('settings.mfaActivate') }}</button>
        <button type="button" class="btn ghost" @click="cancelEnrol">{{ $t('common.cancel') }}</button>
      </div>
    </div>

    <div v-else class="mt">
      <label class="field">
        <span>{{ $t('settings.mfaDisarmCode') }}</span>
        <input v-model="mfa.code" inputmode="numeric" maxlength="6"/>
      </label>
      <button type="button" class="btn danger" @click="disarmMFA" :disabled="busy || !mfa.code">{{ $t('settings.mfaDisarm') }}</button>
    </div>
  </section>

  <section class="card mb-lg" aria-labelledby="cal-h">
    <h2 id="cal-h">{{ $t('settings.calendar') }}</h2>
    <p class="muted text-sm">{{ $t('settings.calendarHelp') }}</p>
    <div v-if="cal.url" class="mt">
      <label class="field">
        <span>{{ $t('settings.calendarUrl') }}</span>
        <input :value="cal.url" readonly @focus="copyCal" :aria-label="$t('settings.calendarUrl')"/>
      </label>
      <small class="muted">{{ $t('settings.calendarExpires', { date: formatDate(cal.expires_at) }) }}</small>
    </div>
    <button type="button" class="btn mt" @click="mintCalendar" :disabled="busy">{{ cal.url ? $t('settings.calendarRotate') : $t('settings.calendarGenerate') }}</button>
  </section>

  <section class="card mb-lg" aria-labelledby="push-h">
    <h2 id="push-h">{{ $t('settings.push') }}</h2>
    <p class="muted text-sm">{{ $t('settings.pushHelp') }}</p>
    <p v-if="push.unsupported" class="tag warning">{{ $t('settings.pushUnsupported') }}</p>
    <p v-else-if="push.subscribed" class="tag success">{{ $t('settings.pushOn') }}</p>
    <p v-else class="tag">{{ $t('settings.pushOff') }}</p>
    <div class="row gap mt" v-if="!push.unsupported">
      <button type="button" class="btn" v-if="!push.subscribed" @click="subscribePush" :disabled="busy">{{ $t('settings.pushSubscribe') }}</button>
      <button type="button" class="btn ghost" v-else @click="unsubscribePush" :disabled="busy">{{ $t('settings.pushUnsubscribe') }}</button>
    </div>
  </section>

  <section class="card mb-lg" aria-labelledby="dsar-h">
    <h2 id="dsar-h">{{ $t('settings.privacy') }}</h2>
    <p class="muted text-sm">{{ $t('settings.privacyHelp') }}</p>
    <div class="row gap mt">
      <button type="button" class="btn ghost" @click="exportData" :disabled="busy">{{ $t('settings.exportData') }}</button>
      <button type="button" class="btn danger" @click="confirmDelete" :disabled="busy">{{ $t('settings.eraseAccount') }}</button>
    </div>
  </section>

  <p v-if="statusMsg" class="status" role="status">{{ statusMsg }}</p>
</template>

<script setup>
import { nextTick, onMounted, reactive, ref } from 'vue'
import QRCode from 'qrcode'
import { api, getToken, clearToken } from '../api'

const user = reactive({ username: '', role: '', tenant_id: '' })
const mfa  = reactive({
  enabled: false,
  enrolling: false,
  otpauth_url: '',
  secret: '',
  secret_pretty: '',
  code: '',
  error: '',
})
const qrCanvas = ref(null)
const cal  = reactive({ url: '', expires_at: '' })
const push = reactive({ unsupported: false, subscribed: false })
const busy = ref(false)
const statusMsg = ref('')

function decodeJwt(t) {
  try {
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload
  } catch (e) { return {} }
}

async function load() {
  const claims = decodeJwt(getToken() || '')
  user.username = claims.dn || claims.sub || ''
  user.role     = claims.role || ''
  user.tenant_id = claims.tenant_id || ''
  try {
    const r = await api.get('/api/v1/me/mfa')
    mfa.enabled = !!r.data?.enabled
  } catch (e) { /* ignore — endpoint may be disabled */ }
  push.unsupported = !('serviceWorker' in navigator) || !('PushManager' in window)
  if (!push.unsupported) {
    const reg = await navigator.serviceWorker.getRegistration('/push-sw.js')
    const sub = reg ? await reg.pushManager.getSubscription() : null
    push.subscribed = !!sub
  }
}

async function enrolMFA() {
  busy.value = true; mfa.error = ''
  try {
    const r = await api.post('/api/v1/me/mfa/enroll', {})
    mfa.otpauth_url = r.data.otpauth_url
    mfa.secret = r.data.secret
    // Authenticator apps display the secret in space-separated groups of
    // four — match that so users typing it in by hand can verify each
    // group as they go.
    mfa.secret_pretty = (r.data.secret || '').match(/.{1,4}/g)?.join(' ') || r.data.secret
    mfa.enrolling = true
    // Wait one tick so the canvas element exists in the DOM, then render
    // the QR. We pick error-correction L (low) because the payload is
    // short and the camera distance is close — a higher level would
    // make the modules denser without practical benefit.
    await nextTick()
    if (qrCanvas.value) {
      await QRCode.toCanvas(qrCanvas.value, mfa.otpauth_url, {
        width: 220, margin: 1, errorCorrectionLevel: 'L',
        color: { dark: '#0a1f44', light: '#ffffff' },
      })
    }
  } catch (e) { mfa.error = e.message } finally { busy.value = false }
}

async function copySecret() {
  try {
    await navigator.clipboard.writeText(mfa.secret)
    statusMsg.value = 'Secret copied — paste it into Google Authenticator if you cannot scan.'
  } catch (e) { statusMsg.value = 'Copy failed; select the text manually.' }
}

async function activateMFA() {
  busy.value = true; mfa.error = ''
  try {
    await api.post('/api/v1/me/mfa/activate', { code: mfa.code })
    mfa.enabled = true
    cancelEnrol()
    statusMsg.value = 'MFA activated.'
  } catch (e) { mfa.error = 'Invalid code — try again.' } finally { busy.value = false }
}

// cancelEnrol scrubs the pending-secret state so it's not left in the
// DOM (or Vue reactive store) after the user backs out or completes
// activation.
function cancelEnrol() {
  mfa.enrolling = false
  mfa.otpauth_url = ''
  mfa.secret = ''
  mfa.secret_pretty = ''
  mfa.code = ''
  mfa.error = ''
}

async function disarmMFA() {
  busy.value = true
  try {
    await api.delete('/api/v1/me/mfa', { data: { code: mfa.code } })
    mfa.enabled = false; mfa.code = ''
    statusMsg.value = 'MFA disabled.'
  } catch (e) { statusMsg.value = e.message } finally { busy.value = false }
}

async function mintCalendar() {
  busy.value = true
  try {
    const r = await api.get('/api/v1/me/calendar/token')
    cal.url = r.data.feed_url
    cal.expires_at = r.data.expires_at
  } catch (e) { statusMsg.value = e.message } finally { busy.value = false }
}

function copyCal(e) { e.target.select(); navigator.clipboard?.writeText(cal.url) }

function formatDate(d) { return d ? new Date(d).toLocaleDateString() : '—' }

async function subscribePush() {
  busy.value = true
  try {
    const reg = await navigator.serviceWorker.register('/push-sw.js')
    const k = await fetch('/api/v1/push/vapid-key').then(r => r.json())
    if (!k.public_key) { statusMsg.value = 'Server has no VAPID key configured.'; return }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(k.public_key),
    })
    await api.post('/api/v1/me/push', sub.toJSON())
    push.subscribed = true
    statusMsg.value = 'Push notifications enabled.'
  } catch (e) {
    statusMsg.value = 'Could not enable push: ' + e.message
  } finally { busy.value = false }
}

async function unsubscribePush() {
  busy.value = true
  try {
    const reg = await navigator.serviceWorker.getRegistration('/push-sw.js')
    const sub = reg && await reg.pushManager.getSubscription()
    if (sub) {
      await api.delete('/api/v1/me/push', { data: { endpoint: sub.endpoint } })
      await sub.unsubscribe()
    }
    push.subscribed = false
    statusMsg.value = 'Push notifications disabled.'
  } catch (e) { statusMsg.value = e.message } finally { busy.value = false }
}

function urlBase64ToUint8Array(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4)
  const base64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i)
  return out
}

async function exportData() {
  busy.value = true
  try {
    // Use a direct fetch so the browser downloads the JSON file.
    const r = await fetch('/api/v1/me/export', { headers: { Authorization: 'Bearer ' + getToken() } })
    const blob = await r.blob()
    const url = URL.createObjectURL(blob)
    const a = Object.assign(document.createElement('a'), { href: url, download: 'my-data.json' })
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  } catch (e) { statusMsg.value = e.message } finally { busy.value = false }
}

async function confirmDelete() {
  if (!confirm('This permanently disables your account and redacts your personal data. Continue?')) return
  busy.value = true
  try {
    await api.delete('/api/v1/me')
    clearToken()
    window.location.assign('/app/')
  } catch (e) { statusMsg.value = e.message } finally { busy.value = false }
}

onMounted(load)
</script>

<style scoped>
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px 16px; }
.kv dt { color: var(--text-muted); font-size: 13px; }
.kv dd { margin: 0; font-size: 14px; }
.error { color: var(--danger, #b91c1c); font-size: 13px; }
.status { color: var(--text-muted); margin-top: 12px; }

.enrol-steps { padding-left: 20px; margin: 12px 0 0; }
.enrol-steps > li { margin-bottom: 16px; line-height: 1.45; }
.qr-block {
  display: inline-block;
  padding: 10px;
  background: white;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  margin: 8px 0;
}
.qr-block canvas { display: block; }
.manual-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 4px;
}
.manual-secret {
  flex: 1;
  padding: 8px 10px;
  background: var(--bg-muted, #f3f4f6);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  letter-spacing: 0.5px;
  word-break: break-all;
}
</style>
