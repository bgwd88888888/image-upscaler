import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  server: {
    host: '0.0.0.0',
    port: 43180,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 43180,
    strictPort: true,
  },
})
