import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt', not 'autoUpdate'. autoUpdate reloads the page the moment a
      // new build lands, which during a broadcast means losing a half-typed
      // SKU. The app registers the worker itself (see src/lib/pwa.ts), watches
      // for updates, and offers a bar the operator taps when they are between
      // SKUs rather than mid-one.
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: 'TikShop',
        short_name: 'TikShop',
        description: 'Live listing and orders for TikTok Shop',
        theme_color: '#0f0f0f',
        background_color: '#0f0f0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is cached so it opens with no signal. API calls are
        // never cached — stale listings are worse than none. Unpushed work
        // lives in the IndexedDB queue, not in the HTTP cache.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: { port: 5173 },
})
