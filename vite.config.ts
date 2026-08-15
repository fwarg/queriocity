import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const port = env.PORT ?? '3000'
  return {
    root: 'src/client',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          navigateFallbackDenylist: [/^\/images\//, /^\/api\//],
        },
        manifest: {
          name: 'Queriocity',
          short_name: 'Queriocity',
          // Baked into the build, so unlike the in-app tagline it cannot follow the user's
          // language. Kept identical to the English `app.tagline` in src/shared/i18n/en.ts.
          description: 'Your private research assistant',
          // Tailwind's gray-950, the same value `body` gets in index.css — these paint the
          // splash screen and the Android status bar, so white here flashed on every launch of
          // an app that is dark everywhere else. Hex rather than the oklch the stylesheet
          // compiles to: a manifest is read by installers, not only by browsers.
          theme_color: '#030712',
          background_color: '#030712',
          display: 'standalone',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
      }),
    ],
    // src/shared holds the few modules both halves need; the client root is src/client, so it
    // sits outside and needs an alias rather than a relative path.
    resolve: {
      alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
    },
    build: {
      outDir: '../../dist/client',
      emptyOutDir: true,
    },
    server: {
      host: true,
      proxy: {
        '/api': { target: `http://localhost:${port}`, changeOrigin: true },
        '/images': { target: `http://localhost:${port}`, changeOrigin: true },
      },
    },
  }
})
