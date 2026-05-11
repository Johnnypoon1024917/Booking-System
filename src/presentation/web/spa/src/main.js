import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { i18n, applyTenantLocale } from './i18n'
import { useTenantStore } from './stores/tenant'
import { useThemeStore } from './stores/theme'
import { clickOutside } from './directives/clickOutside'
import './styles.css'

async function bootstrap() {
  const app = createApp(App)
  app.use(createPinia())
  app.use(i18n)
  app.use(router)
  app.directive('click-outside', clickOutside)

  // Theme first so first paint isn't a flash of wrong colors.
  const theme = useThemeStore()
  theme.apply()

  // Tenant document drives brand tokens, locale, layout. Best-effort: an
  // unauthenticated user lands on /login and we'll load it post-auth.
  try {
    const tenant = useTenantStore()
    await tenant.load()
    applyTenantLocale(tenant.customization?.default_locale)
    applyBrandColors(tenant.customization)
  } catch {
    // not fatal
  }

  app.mount('#app')
}

function applyBrandColors(c) {
  if (!c) return
  const root = document.documentElement
  if (c.brand_primary)   root.style.setProperty('--brand-primary', c.brand_primary)
  if (c.brand_secondary) root.style.setProperty('--brand-secondary', c.brand_secondary)
  if (c.brand_accent)    root.style.setProperty('--brand-accent', c.brand_accent)
  if (c.brand_name) document.title = c.brand_name
}

bootstrap()
