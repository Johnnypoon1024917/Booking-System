import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// The SPA is served by the Go binary at /app/. The Vue dev server proxies
// /api and /api/v1/realtime to the Go backend so we keep one origin and a
// single JWT lifecycle in development.
export default defineConfig({
  base: '/app/',
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'FSD Resource Booking',
        short_name: 'FSD MRBS',
        description: 'Multi-tenant resource booking platform',
        theme_color: '#002147',
        background_color: '#f5f5f5',
        display: 'standalone',
        scope: '/app/',
        start_url: '/app/',
        icons: []
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // cleanupOutdatedCaches removes precache entries from previous
        // builds so the new SW doesn't try to refetch hashed asset
        // filenames that no longer exist on the server — the source of
        // the "Failed to fetch" Workbox PrecacheStrategy errors after
        // every redeploy. skipWaiting + clientsClaim make the new SW
        // take over immediately instead of sitting in "waiting" while
        // the old one keeps serving 404s for the previous build's
        // chunks.
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        // Treat a missing precached chunk as a non-fatal recoverable
        // condition (fetch from network) rather than a hard error that
        // bubbles up to the page console.
        navigateFallback: '/app/index.html',
        runtimeCaching: [
          {
            urlPattern: /^\/api\/v1\/(bookings\/search|admin\/customization)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 50, maxAgeSeconds: 300 }
            }
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      '/api/v1/realtime': { target: 'ws://localhost:8080', ws: true },
      '/api': 'http://localhost:8080'
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
