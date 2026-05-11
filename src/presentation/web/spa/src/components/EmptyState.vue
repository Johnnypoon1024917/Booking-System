<template>
  <div class="empty">
    <div class="icon-wrap">
      <component :is="icon" :size="24" />
    </div>
    <h4>{{ title }}</h4>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.actions" class="mt"><slot name="actions" /></div>
  </div>
</template>

<script setup>
import { Inbox } from 'lucide-vue-next'
defineProps({
  icon: { type: [Object, Function], default: () => Inbox },
  title: { type: String, required: true },
  description: { type: String, default: '' }
})
</script>
