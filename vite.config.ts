import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const port = env.PORT ?? '3000'
  return {
    root: 'src/client',
    plugins: [react()],
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
