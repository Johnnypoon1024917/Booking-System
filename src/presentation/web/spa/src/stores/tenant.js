import { defineStore } from 'pinia'
import { api } from '../api'

// tenant store — single source of truth for the customization document so
// branding/i18n/layout decisions don't require prop-drilling through every
// component.
export const useTenantStore = defineStore('tenant', {
  state: () => ({
    customization: null,
    loading: false,
    error: null
  }),
  actions: {
    async load() {
      this.loading = true
      this.error = null
      try {
        this.customization = await api.getCustomization()
      } catch (e) {
        this.error = e.message
      } finally {
        this.loading = false
      }
    },
    async save(updated) {
      this.customization = await api.saveCustomization(updated)
    },
    async reset() {
      this.customization = await api.resetCustomization()
    }
  }
})
