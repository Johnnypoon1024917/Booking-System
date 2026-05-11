<template>
  <button class="sw" :class="{ on: modelValue }"
          role="switch" :aria-checked="modelValue"
          @click="$emit('update:modelValue', !modelValue)">
    <span class="thumb" />
  </button>
</template>

<script setup>
defineProps({ modelValue: Boolean })
defineEmits(['update:modelValue'])
</script>

<style scoped>
.sw {
  width: 40px; height: 22px; border-radius: 999px;
  background: var(--border); border: 0; padding: 0;
  position: relative; cursor: pointer;
  transition: background var(--dur);
}
.sw.on { background: var(--brand-primary); }
.thumb {
  position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: white; box-shadow: var(--shadow-sm);
  transition: left var(--dur) var(--ease);
}
.sw.on .thumb { left: 20px; }
</style>
