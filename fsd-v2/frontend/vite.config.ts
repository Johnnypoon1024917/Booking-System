import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA proxies /api/* to the NestJS backend in dev so the same JWT
// origin policy applies as in production. VITE_API_URL is used only
// when the SPA is built and served from a different origin.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://api:3000', changeOrigin: true },
    },
  },
});
