<template>
  <div class="skeleton" :style="style" aria-hidden="true" />
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({
  width: { type: String, default: '100%' },
  height: { type: String, default: '14px' },
  radius: { type: String, default: 'var(--radius-sm)' }
})
const style = computed(() => ({ width: props.width, height: props.height, borderRadius: props.radius }))
</script>
