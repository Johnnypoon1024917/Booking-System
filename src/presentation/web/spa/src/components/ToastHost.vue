<template>
  <div class="toast-host">
    <div v-for="t in toasts.items" :key="t.id" class="toast" :class="t.kind" role="status">
      <span class="dot" />
      <div class="body">
        <b>{{ t.title }}</b>
        <p v-if="t.description">{{ t.description }}</p>
      </div>
      <button class="icon-btn" style="width:24px;height:24px;" @click="toasts.dismiss(t.id)" aria-label="dismiss">
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { X } from 'lucide-vue-next'
import { useToastStore } from '../stores/toast'
const toasts = useToastStore()
</script>
