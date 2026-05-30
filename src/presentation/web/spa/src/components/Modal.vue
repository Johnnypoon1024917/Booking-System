<template>
  <Teleport to="body">
    <div class="overlay" @click.self="$emit('close')" role="presentation">
      <div
        ref="dialogEl"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="onKey"
      >
        <header v-if="title || $slots.header">
          <h3 :id="titleId">
            <slot name="header">{{ title }}</slot>
          </h3>
          <button
            class="icon-btn"
            type="button"
            :aria-label="$t('common.close')"
            @click="$emit('close')"
          >
            <X :size="18" aria-hidden="true" />
          </button>
        </header>
        <section><slot /></section>
        <footer v-if="$slots.footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { onMounted, onBeforeUnmount, nextTick, ref } from 'vue'
import { X } from 'lucide-vue-next'

defineProps({ title: { type: String, default: '' } })
const emit = defineEmits(['close'])
const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`
const dialogEl = ref(null)

// Element that had focus before the modal opened, so we can return focus
// when it closes (WCAG 2.4.3 Focus Order, 2.4.7 Focus Visible).
let lastFocused = null

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusables() {
  if (!dialogEl.value) return []
  return Array.from(dialogEl.value.querySelectorAll(focusableSelector)).filter(
    (el) => !el.hasAttribute('aria-hidden')
  )
}

// Keep tab within the modal — pressing Tab from the last element cycles
// back to the first, and Shift+Tab from the first jumps to the last.
function onKey(e) {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  if (e.key !== 'Tab') return
  const els = focusables()
  if (els.length === 0) {
    e.preventDefault()
    dialogEl.value?.focus()
    return
  }
  const first = els[0]
  const last = els[els.length - 1]
  const active = document.activeElement
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  lastFocused = document.activeElement
  await nextTick()
  const els = focusables()
  ;(els[0] || dialogEl.value)?.focus()
})

onBeforeUnmount(() => {
  // Restore focus to the trigger so keyboard users don't get teleported
  // to the document body. Guard against the trigger being unmounted.
  if (lastFocused && typeof lastFocused.focus === 'function') {
    lastFocused.focus()
  }
})
</script>
