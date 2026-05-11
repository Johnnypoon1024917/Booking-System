<template>
  <Teleport to="body">
    <div class="overlay" @click.self="$emit('close')" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header v-if="title || $slots.header">
          <h3 :id="titleId">
            <slot name="header">{{ title }}</slot>
          </h3>
          <button class="icon-btn" aria-label="close" @click="$emit('close')">
            <X :size="18" />
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
import { onMounted, onBeforeUnmount } from 'vue'
import { X } from 'lucide-vue-next'

const props = defineProps({ title: { type: String, default: '' } })
const emit = defineEmits(['close'])
const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`

function onKey(e) { if (e.key === 'Escape') emit('close') }
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>
