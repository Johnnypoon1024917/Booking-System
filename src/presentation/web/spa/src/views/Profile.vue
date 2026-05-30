<template>
  <div class="page-header mb-lg">
    <div>
      <h1>{{ $t('profile.title') }}</h1>
      <p class="muted text-md mt-sm">{{ $t('profile.subtitle') }}</p>
    </div>
  </div>

  <div class="card profile-card mb">
    <Avatar :name="user.name" size="lg"/>
    <div class="space" style="min-width:0;">
      <h2 style="margin:0;">{{ user.name }}</h2>
      <small class="muted">{{ user.role }}<span v-if="user.grade"> · {{ user.grade }}</span></small>
      <div class="row gap-sm mt-sm" style="flex-wrap: wrap;">
        <span v-for="r in user.regions" :key="r" class="tag">{{ r }}</span>
      </div>
    </div>
  </div>

  <div class="card mb">
    <h3 class="mb">{{ $t('profile.session') }}</h3>
    <div class="row gap" style="flex-wrap: wrap;">
      <div class="col gap-sm" style="min-width: 200px;">
        <small class="muted">{{ $t('profile.tenant') }}</small>
        <code style="font-size:12px;">{{ user.tenantId || '—' }}</code>
      </div>
      <div class="col gap-sm" style="min-width: 200px;">
        <small class="muted">{{ $t('profile.dn') }}</small>
        <code style="font-size:12px;">{{ user.dn || '—' }}</code>
      </div>
      <div class="col gap-sm" style="min-width: 160px;">
        <small class="muted">{{ $t('profile.expiresAt') }}</small>
        <span>{{ user.expiresAt || '—' }}</span>
      </div>
    </div>
  </div>

  <div class="card">
    <h3 class="mb">{{ $t('profile.preferences') }}</h3>
    <div class="row gap" style="flex-wrap: wrap;">
      <button class="btn ghost" @click="cycleLocale">
        <Globe :size="14"/>
        {{ $t('profile.language') }}: {{ localeLabel }}
      </button>
      <button class="btn ghost danger" @click="logout">
        <LogOut :size="14"/> {{ $t('app.logout') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Globe, LogOut } from 'lucide-vue-next'
import Avatar from '../components/Avatar.vue'
import { setLocale } from '../i18n'
import { clearToken } from '../api'

const { locale, availableLocales } = useI18n()

const user = computed(() => {
  let payload = {}
  try {
    const tok = localStorage.getItem('fsd_jwt')
    if (tok) payload = JSON.parse(atob(tok.split('.')[1]))
  } catch {}
  const exp = payload.exp ? new Date(payload.exp * 1000).toLocaleString() : ''
  return {
    name: localStorage.getItem('fsd_user') || payload.sub || 'User',
    role: payload.role || '',
    grade: payload.grade || '',
    regions: payload.regions || [],
    tenantId: payload.tenant_id || '',
    dn: payload.dn || '',
    expiresAt: exp,
  }
})

const localeLabel = computed(() => locale.value === 'zh-Hant' ? '繁體中文' : locale.value === 'zh-Hans' ? '简体中文' : 'English')

function cycleLocale() {
  const idx = availableLocales.indexOf(locale.value)
  const next = availableLocales[(idx + 1) % availableLocales.length]
  setLocale(next)
}

function logout() { clearToken(); location.href = '/' }
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.profile-card { display: grid; grid-template-columns: 60px 1fr; gap: 18px; align-items: center; }
</style>
