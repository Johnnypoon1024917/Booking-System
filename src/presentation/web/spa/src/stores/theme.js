import { defineStore } from 'pinia'

// Theme store — dark mode has been removed; the app is light-only.
// `mode` is kept as a constant so any lingering reference resolves, and
// apply() pins data-theme to light for styles.css.
export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: 'light'
  }),
  actions: {
    apply() {
      document.documentElement.setAttribute('data-theme', 'light')
    }
  }
})
