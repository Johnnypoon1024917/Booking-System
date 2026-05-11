import { defineStore } from 'pinia'

// Theme store — persists user choice. The actual CSS variables are switched
// by setting `data-theme` on <html>, which our styles.css reads.
export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: localStorage.getItem('fsd_theme') || systemPreference()
  }),
  actions: {
    apply() {
      document.documentElement.setAttribute('data-theme', this.mode)
    },
    toggle() {
      this.mode = this.mode === 'dark' ? 'light' : 'dark'
      localStorage.setItem('fsd_theme', this.mode)
      this.apply()
    }
  }
})

function systemPreference() {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
