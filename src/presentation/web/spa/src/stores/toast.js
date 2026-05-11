import { defineStore } from 'pinia'

let nextId = 1

// Toast store — replaces alert() calls. Each toast auto-dismisses after
// its duration; the host component animates them in and out.
export const useToastStore = defineStore('toast', {
  state: () => ({ items: [] }),
  actions: {
    push({ title, description, kind = 'info', duration = 4500 }) {
      const id = nextId++
      this.items.push({ id, title, description, kind })
      if (duration > 0) {
        setTimeout(() => this.dismiss(id), duration)
      }
      return id
    },
    success(title, description) { return this.push({ title, description, kind: 'success' }) },
    error(title, description)   { return this.push({ title, description, kind: 'error', duration: 6000 }) },
    info(title, description)    { return this.push({ title, description, kind: 'info' }) },
    warn(title, description)    { return this.push({ title, description, kind: 'warning' }) },
    dismiss(id) { this.items = this.items.filter(t => t.id !== id) }
  }
})
