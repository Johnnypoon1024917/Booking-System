<template>
  <div class="avatar" :class="{ lg: size === 'lg' }" :title="name" :style="bg">
    {{ initials }}
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({
  name: { type: String, default: '' },
  size: { type: String, default: 'md' }
})
const initials = computed(() => {
  if (!props.name) return '·'
  return props.name.trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase()
})
// Deterministic-ish hue from name so different users get distinct accents.
const bg = computed(() => {
  if (!props.name) return {}
  let hash = 0
  for (let i = 0; i < props.name.length; i++) hash = (hash * 31 + props.name.charCodeAt(i)) >>> 0
  const hue = hash % 360
  return { background: `linear-gradient(135deg, hsl(${hue} 60% 45%), hsl(${(hue + 32) % 360} 70% 55%))` }
})
</script>
