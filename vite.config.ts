/// <reference types="vitest/config" />
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered in main.tsx so a new release replaces the cached app and reloads automatically.
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      // Task 2.6: phone alerts. The push and notification-click handlers live in public/push-sw.js.
      // Server addresses (/api/...) are never answered by the cached app: Microsoft's sign-in comes back to
      // /api/v1/microsoft/callback as a page visit, and it must reach the server (task 3.1).
      workbox: { importScripts: ['push-sw.js'], navigateFallbackDenylist: [/^\/api\//],
        // Task 6.1: the PDF maker and its fonts (1.6 MB) load only when someone makes an evidence pack, not on install.
        globIgnores: ['**/pdfmake-*.js', '**/vfs_fonts-*.js'] },
      manifest: {
        name: 'Agent Control Tower',
        short_name: 'Control Tower',
        description: 'Human approval, kill switch and audit for AI agents',
        theme_color: '#20242c',
        background_color: '#20242c',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', 'functions/**/*.test.ts'],
  },
})
