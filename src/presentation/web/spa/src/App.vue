<template>
  <ToastHost />

  <div v-if="$route.name === 'kiosk'">
    <router-view />
  </div>

  <div v-else class="app-shell">
    <!-- Mobile drawer backdrop: clicking it closes the sidebar. -->
    <div v-if="sidebarOpen" class="drawer-backdrop" @click="sidebarOpen = false" aria-hidden="true" />

    <Sidebar :open="sidebarOpen" @navigate="sidebarOpen = false" />

    <div class="app-main-col">
      <TopBar @toggle-sidebar="sidebarOpen = !sidebarOpen" />
      <main class="main">
        <!-- Plain router-view: the transition wrapper was blocking
             component swaps on first navigation in some browsers. -->
        <router-view :key="$route.fullPath" />
      </main>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Sidebar from './components/Sidebar.vue'
import TopBar from './components/TopBar.vue'
import ToastHost from './components/ToastHost.vue'
import { useThemeStore } from './stores/theme'

const route = useRoute()
const sidebarOpen = ref(false)
const theme = useThemeStore()

onMounted(() => theme.apply())

// Auto-close the mobile drawer on every route change so the drawer
// doesn't linger after navigating from a sidebar link.
watch(() => route.fullPath, () => { sidebarOpen.value = false })
</script>

<style scoped>
.drawer-backdrop {
  display: none;
}
@media (max-width: 880px) {
  .drawer-backdrop {
    display: block;
    position: fixed; inset: 0;
    background: rgba(15, 23, 42, 0.55);
    backdrop-filter: blur(2px);
    z-index: 99;
    animation: fade-in 200ms var(--ease, ease);
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
}
</style>
