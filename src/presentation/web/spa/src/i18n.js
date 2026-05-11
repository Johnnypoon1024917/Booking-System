// Trilingual i18n bootstrap. The default locale is overridden at runtime
// by the tenant customization document so each tenant's users land on the
// language their org operates in.
import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import zhHans from './locales/zh-Hans.json'

const stored = localStorage.getItem('fsd_locale')

export const i18n = createI18n({
  legacy: false,
  locale: stored || navigatorPreferred() || 'en',
  fallbackLocale: 'en',
  messages: {
    en,
    'zh-Hant': zhHant,
    'zh-Hans': zhHans
  }
})

export function applyTenantLocale(locale) {
  if (!locale) return
  const stored = localStorage.getItem('fsd_locale')
  if (stored) return // user choice wins
  if (i18n.global.availableLocales.includes(locale)) {
    i18n.global.locale.value = locale
  }
}

export function setLocale(locale) {
  if (i18n.global.availableLocales.includes(locale)) {
    i18n.global.locale.value = locale
    localStorage.setItem('fsd_locale', locale)
    document.documentElement.lang = locale
  }
}

function navigatorPreferred() {
  const langs = navigator.languages || [navigator.language]
  for (const l of langs) {
    if (!l) continue
    const lower = l.toLowerCase()
    if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant')) return 'zh-Hant'
    if (lower.startsWith('zh-cn') || lower.startsWith('zh-hans') || lower === 'zh') return 'zh-Hans'
    if (lower.startsWith('en')) return 'en'
  }
  return null
}
