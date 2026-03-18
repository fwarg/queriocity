import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const port = env.PORT ?? '3000'
  return {
    root: 'src/client',
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Queriocity',
          short_name: 'Queriocity',
          description: 'Queriocity',
          theme_color: '#ffffff',
          background_color: '#ffffff',
          display: 'standalone',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
      }),
    ],
    build: {
      outDir: '../../dist/client',
      emptyOutDir: true,
    },
    server: {
      host: true,
      proxy: {
        '/api': { target: `http://localhost:${port}`, changeOrigin: true },
      },
    },
  }
})
